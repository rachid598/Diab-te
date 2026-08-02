import ARKit
import SceneKit
import UIKit

/**
 Écran de visée LiDAR : aperçu caméra, mesure en direct, capture.

 Deux différences de fond avec l'écran ARCore qu'il remplace.

 D'abord, aucune consigne de mouvement. ARCore triangulait la profondeur à
 partir du déplacement du téléphone : il fallait balayer, on l'a d'ailleurs dit
 à l'envers pendant plusieurs versions (« tiens le téléphone immobile »). Le
 LiDAR mesure un temps de vol, image par image. Immobile marche.

 Ensuite, la capture prend une RAFALE et retient la médiane. Une mesure isolée
 peut tomber sur une image bruitée ; sur neuf mesures en une seconde et demie,
 la médiane est stable et le désaccord entre elles renseigne sur la confiance
 qu'on peut lui accorder. C'est aussi ce qui permet d'afficher un écart, donc
 de savoir quand se méfier.
 */
final class DepthScanViewController: UIViewController, ARSCNViewDelegate {

    /// Rendu au JS : le dictionnaire est passé tel quel à `call.resolve`.
    var onDone: (([String: Any]) -> Void)?

    private let sceneView = ARSCNView()
    private let readout = UILabel()
    private let hint = UILabel()
    private let shutter = UIButton(type: .custom)
    private let closeButton = UIButton(type: .system)
    private let reticle = UIView()
    private let ringFrame = UIView()

    private var reticleW: NSLayoutConstraint!
    private var reticleH: NSLayoutConstraint!
    private var ringW: NSLayoutConstraint!
    private var ringH: NSLayoutConstraint!
    private var reticleSized = false

    private var timer: Timer?
    private var lastResult: DepthMeasure.Result?
    private var capturing = false
    private var finished = false

    /// Largeur maximale du JPEG renvoyé. Au-delà, le base64 traversant le pont
    /// Capacitor devient inutilement lourd sans rien apporter au modèle.
    private let maxPhotoWidth: CGFloat = 1440

    // MARK: - Cycle de vie

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        buildUI()
        sceneView.delegate = self
        sceneView.automaticallyUpdatesLighting = true
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        UIApplication.shared.isIdleTimerDisabled = true

        guard ARWorldTrackingConfiguration.isSupported else {
            finish(error: "ARKit n'est pas disponible sur cet appareil.")
            return
        }
        let config = ARWorldTrackingConfiguration()
        /* Pas de détection de plans : sur une table unie elle met un temps
           indéterminé à accrocher, et ce qu'elle accroche est souvent le SOL,
           ce qui décale toutes les hauteurs de la hauteur de la table. Le plan
           d'appui est déduit de la carte de profondeur elle-même. */
        config.planeDetection = []
        if ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) {
            config.frameSemantics.insert(.sceneDepth)
        } else {
            finish(error: "Cet iPhone n'a pas de LiDAR : la mesure de volume n'est pas disponible.")
            return
        }
        sceneView.session.run(config, options: [.resetTracking, .removeExistingAnchors])

        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            self?.tick()
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        UIApplication.shared.isIdleTimerDisabled = false
        timer?.invalidate()
        timer = nil
        sceneView.session.pause()
    }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }
    override var prefersStatusBarHidden: Bool { true }

    // MARK: - Interface

    private func buildUI() {
        sceneView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(sceneView)

        /* Le cadre matérialise la zone centrale effectivement intégrée (50 % de
           la carte de profondeur). Ses dimensions sont calculées à la première
           image, pas fixées ici : voir sizeReticle. */
        reticle.translatesAutoresizingMaskIntoConstraints = false
        reticle.layer.borderColor = UIColor.white.withAlphaComponent(0.85).cgColor
        reticle.layer.borderWidth = 2
        reticle.layer.cornerRadius = 12
        reticle.isUserInteractionEnabled = false
        view.addSubview(reticle)

        /* Le cadre extérieur matérialise la COURONNE : la zone sur laquelle le
           plan d'appui est ajusté (jusqu'à 94 % de la carte de profondeur, tout
           ce qui est hors du cadre intérieur).

           Sans lui, la contrainte la plus déterminante de la mesure était
           invisible. On visait l'objet dans le cadre vert en croyant bien faire,
           pendant que le plan d'appui se calculait sur un bord de table, un sol
           et un ordinateur portable — et le message d'erreur conseillait de
           reculer, ce qui y faisait entrer encore plus de choses. La règle est
           simple une fois qu'on la voit : entre les deux cadres, de la table
           nue, rien d'autre. */
        ringFrame.translatesAutoresizingMaskIntoConstraints = false
        ringFrame.layer.borderColor = UIColor.white.withAlphaComponent(0.35).cgColor
        ringFrame.layer.borderWidth = 1
        ringFrame.layer.cornerRadius = 16
        ringFrame.isUserInteractionEnabled = false
        view.addSubview(ringFrame)

        readout.translatesAutoresizingMaskIntoConstraints = false
        readout.numberOfLines = 0
        readout.textAlignment = .center
        readout.textColor = .white
        readout.font = .monospacedDigitSystemFont(ofSize: 15, weight: .medium)
        readout.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        readout.layer.cornerRadius = 10
        readout.layer.masksToBounds = true
        readout.text = "Initialisation…"
        view.addSubview(readout)

        hint.translatesAutoresizingMaskIntoConstraints = false
        hint.numberOfLines = 0
        hint.textAlignment = .center
        hint.textColor = UIColor.white.withAlphaComponent(0.9)
        hint.font = .systemFont(ofSize: 13)
        /* La distance annoncée est passée de « 40-50 cm » à « 30-35 cm » sur
           mesures : sur une brique de 1100 cm³, l'erreur vaut −0,3 % en moyenne
           entre 29 et 33 cm, puis +7 % à 36 cm et +22 % à 37 cm — la surface
           mesurée double entre 32 et 37 cm pour un objet qui n'a pas bougé.
           La consigne du bandeau, elle, est la contrainte réelle : c'est là que
           le plan d'appui est calculé. */
        hint.text = "Téléphone à plat, à 30-35 cm. Entre les deux cadres, de la table nue — pas de bord, pas d'objet."
        view.addSubview(hint)

        shutter.translatesAutoresizingMaskIntoConstraints = false
        shutter.backgroundColor = .white
        shutter.layer.cornerRadius = 36
        shutter.layer.borderWidth = 4
        shutter.layer.borderColor = UIColor.black.withAlphaComponent(0.25).cgColor
        shutter.addTarget(self, action: #selector(capture), for: .touchUpInside)
        view.addSubview(shutter)

        closeButton.translatesAutoresizingMaskIntoConstraints = false
        closeButton.setTitle("Annuler", for: .normal)
        closeButton.setTitleColor(.white, for: .normal)
        closeButton.addTarget(self, action: #selector(cancel), for: .touchUpInside)
        view.addSubview(closeButton)

        NSLayoutConstraint.activate([
            sceneView.topAnchor.constraint(equalTo: view.topAnchor),
            sceneView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            sceneView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            sceneView.trailingAnchor.constraint(equalTo: view.trailingAnchor),

            reticle.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            reticle.centerYAnchor.constraint(equalTo: view.centerYAnchor),

            ringFrame.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            ringFrame.centerYAnchor.constraint(equalTo: view.centerYAnchor),

            readout.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            readout.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            readout.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),

            hint.bottomAnchor.constraint(equalTo: shutter.topAnchor, constant: -18),
            hint.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            hint.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),

            shutter.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            shutter.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -28),
            shutter.widthAnchor.constraint(equalToConstant: 72),
            shutter.heightAnchor.constraint(equalToConstant: 72),

            closeButton.centerYAnchor.constraint(equalTo: shutter.centerYAnchor),
            closeButton.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24)
        ])

        reticleW = reticle.widthAnchor.constraint(equalToConstant: 200)
        reticleH = reticle.heightAnchor.constraint(equalToConstant: 200)
        ringW = ringFrame.widthAnchor.constraint(equalToConstant: 300)
        ringH = ringFrame.heightAnchor.constraint(equalToConstant: 300)
        NSLayoutConstraint.activate([reticleW, reticleH, ringW, ringH])
    }

    /**
     Met le cadre à la taille de la zone RÉELLEMENT intégrée.

     Le cadre valait auparavant la moitié de la largeur de l'écran, ce qui était
     faux dans les deux dimensions. La carte de profondeur est en 4:3 ; l'écran
     est bien plus allongé ; ARKit affiche l'aperçu en « remplissage », donc il
     rogne l'image sur les côtés et l'agrandit. Un carré de 50 % de la largeur
     d'écran ne recouvrait ainsi qu'une fraction de la zone mesurée — environ
     0,6 fois en largeur et 0,45 fois en hauteur.

     Conséquence concrète : on croyait exclure le bord de table, le clavier et le
     canapé alors qu'ils étaient dans la mesure, et la couronne servant de plan
     d'appui n'était pas une table. Impossible à deviner en regardant l'écran,
     puisque l'écran affirmait le contraire.
     */
    private func sizeReticle(_ frame: ARFrame) {
        guard !reticleSized else { return }
        let res = frame.camera.imageResolution
        guard res.width > 0, res.height > 0 else { return }
        // En portrait l'image est pivotée : sa largeur vient de la hauteur du capteur.
        let imageW = res.height, imageH = res.width
        let bounds = view.bounds.size
        guard bounds.width > 0, bounds.height > 0 else { return }
        let scale = max(bounds.width / imageW, bounds.height / imageH)
        // 0,50 et 0,94 : exactement centerFraction et ringFraction de DepthMeasure.
        reticleW.constant = imageW * scale * 0.50
        reticleH.constant = imageH * scale * 0.50
        ringW.constant = imageW * scale * 0.94
        ringH.constant = imageH * scale * 0.94
        reticleSized = true
    }

    // MARK: - Mesure en direct

    private func tick() {
        guard !capturing, let frame = sceneView.session.currentFrame else { return }
        sizeReticle(frame)
        let r = DepthMeasure.measure(frame: frame, photoWidthPx: Int(maxPhotoWidth))
        lastResult = r
        render(r, frame: frame)
    }

    private func render(_ r: DepthMeasure.Result, frame: ARFrame) {
        let raw = frame.sceneDepth.map { DepthMeasure.rawCenter($0) } ?? "-"
        if r.ok {
            reticle.layer.borderColor = UIColor.systemGreen.cgColor
            readout.text = String(format: "%.0f cm³  ·  %.0f cm²  ·  h %.1f cm\n%.0f cm de l'objet  ·  %d points",
                                  r.volumeCm3, r.areaCm2, r.heightMaxCm, r.distanceCm, r.samples)
        } else {
            reticle.layer.borderColor = UIColor.white.withAlphaComponent(0.85).cgColor
            readout.text = (r.note.isEmpty ? "Mesure en cours…" : r.note)
        }
        /* Ligne de diagnostic permanente. Sur Android, chaque refus obligeait à
           deviner laquelle des trois causes possibles s'appliquait ; la voir en
           permanence a fait gagner plusieurs allers-retours. */
        hint.text = "centre brut \(raw)  ·  \(r.diag)"
    }

    // MARK: - Capture

    @objc private func capture() {
        guard !capturing, !finished else { return }
        capturing = true
        shutter.isEnabled = false
        shutter.alpha = 0.4
        readout.text = "Mesure…"

        /* Rafale : neuf mesures étalées sur ~1,5 s, médiane des volumes retenus.
           Une image isolée peut être bruitée ; la médiane ne l'est pas, et
           l'écart entre les mesures dit s'il faut se méfier du résultat. */
        var results: [DepthMeasure.Result] = []
        var shots = 0
        let burst = Timer.scheduledTimer(withTimeInterval: 0.17, repeats: true) { [weak self] t in
            guard let self = self else { t.invalidate(); return }
            shots += 1
            if let frame = self.sceneView.session.currentFrame {
                let r = DepthMeasure.measure(frame: frame, photoWidthPx: Int(self.maxPhotoWidth))
                if r.ok { results.append(r) }
            }
            if shots >= 9 {
                t.invalidate()
                self.finishCapture(results)
            }
        }
        RunLoop.main.add(burst, forMode: .common)
    }

    private func finishCapture(_ results: [DepthMeasure.Result]) {
        guard let frame = sceneView.session.currentFrame else {
            capturing = false
            shutter.isEnabled = true
            shutter.alpha = 1
            return
        }

        guard let jpeg = jpegData(from: frame) else {
            finish(error: "Impossible de lire l'image de la caméra.")
            return
        }

        var payload: [String: Any] = [
            "cancelled": false,
            "jpegBase64": jpeg.base64EncodedString()
        ]

        /* Moins de cinq mesures valables sur neuf : on renvoie quand même la
           photo, mais SANS volume. Une photo sans mesure reste exploitable par
           le modèle ; une mesure tirée de deux images n'est pas une mesure. */
        if results.count < 5 {
            let last = lastResult
            payload["depthOk"] = false
            payload["note"] = last?.note.isEmpty == false
                ? last!.note
                : "Mesure instable (\(results.count) images valables sur 9) : recadre sur l'assiette seule et réessaie."
            payload["diag"] = last?.diag ?? ""
            /* L'ÉCHELLE SURVIT AU REFUS DU VOLUME. Elle ne demande qu'une
               distance et les intrinsèques ; ni plan d'appui, ni seuillage du
               relief, ni objet entièrement dans le cadre. Les rejets qui
               invalident un volume — support non horizontal, zone trop remplie,
               objet coupé — ne disent rien contre elle.

               C'est même le cas le plus fréquent en usage réel : un repas dans
               une assiette remplit le cadre et fait souvent échouer le volume,
               alors que sa taille apparente reste parfaitement calibrable. */
            if let s = last, s.scaleOk {
                payload["scaleOk"] = true
                payload["fieldWidthCm"] = s.fieldWidthCm
                payload["cmPerPixel"] = s.cmPerPixel
                payload["distanceCm"] = s.distanceCm
            } else {
                payload["scaleOk"] = false
            }
            finish(payload: payload)
            return
        }

        let volumes = results.map { $0.volumeCm3 }
        let med = DepthMeasure.median(volumes)
        // Le résultat retenu est celui dont le volume est le plus proche de la
        // médiane : tous ses champs restent alors cohérents entre eux.
        let chosen = results.min { abs($0.volumeCm3 - med) < abs($1.volumeCm3 - med) } ?? results[0]

        let lo = volumes.min() ?? med
        let hi = volumes.max() ?? med
        let spread = med > 0 ? (hi - lo) / med : 0

        payload["depthOk"] = true
        payload["volumeCm3"] = chosen.volumeCm3
        payload["areaCm2"] = chosen.areaCm2
        payload["heightMaxCm"] = chosen.heightMaxCm
        payload["heightMeanCm"] = chosen.heightMeanCm
        payload["distanceCm"] = chosen.distanceCm
        payload["cmPerPixel"] = chosen.cmPerPixel
        payload["fieldWidthCm"] = chosen.fieldWidthCm
        payload["scaleOk"] = chosen.scaleOk
        payload["samples"] = chosen.samples
        payload["note"] = spread > 0.25
            ? "Mesure dispersée (±\(Int((spread * 50).rounded())) %) : à prendre avec réserve."
            : chosen.note
        payload["diag"] = chosen.diag
            + " rafale \(results.count)/9 med \(Int(med.rounded()))cm3"
            + " min \(Int(lo.rounded())) max \(Int(hi.rounded()))"
        finish(payload: payload)
    }

    /// Image caméra en JPEG portrait, redimensionnée.
    private func jpegData(from frame: ARFrame) -> Data? {
        let ci = CIImage(cvPixelBuffer: frame.capturedImage).oriented(.right)
        let context = CIContext()
        guard let cg = context.createCGImage(ci, from: ci.extent) else { return nil }
        var image = UIImage(cgImage: cg)
        if image.size.width > maxPhotoWidth {
            let ratio = maxPhotoWidth / image.size.width
            let target = CGSize(width: maxPhotoWidth, height: image.size.height * ratio)
            let renderer = UIGraphicsImageRenderer(size: target)
            image = renderer.image { _ in image.draw(in: CGRect(origin: .zero, size: target)) }
        }
        return image.jpegData(compressionQuality: 0.85)
    }

    // MARK: - Sortie

    @objc private func cancel() {
        finish(payload: ["cancelled": true])
    }

    private func finish(error: String) {
        finish(payload: ["cancelled": false, "error": error])
    }

    private func finish(payload: [String: Any]) {
        guard !finished else { return }
        finished = true
        timer?.invalidate()
        timer = nil
        let done = onDone
        onDone = nil
        dismiss(animated: true) { done?(payload) }
    }
}
