import ARKit
import CoreVideo
import simd
import Foundation

/**
 Transforme une carte de profondeur ARKit (LiDAR) en mesures exploitables.

 Portage du DepthMeasure.java d'ARCore. La géométrie est identique — ajustement
 d'un plan d'appui sur la couronne de l'image, puis intégration du relief du
 centre au-dessus de ce plan. Ce qui change tient à la nature du capteur.

 ARCore déduisait la profondeur du MOUVEMENT : deux vues d'un même point, une
 triangulation, et rien du tout sur une table unie sans grain. D'où les
 « surfaces sans relief », l'exigence de balayage, et surtout des distances
 franchement fausses en dessous de 50 cm sans que rien ne le signale.

 Le LiDAR mesure un temps de vol. Il n'a besoin ni de mouvement ni de texture,
 et il fonctionne dès 25 cm. Le test de validation le confirme : sur une brique
 de lait de 195x94x60 mm, l'app Measure d'Apple lisait 190x90x60, identique à
 30 cm et à 50 cm — moins de 5 % d'écart et aucune dérive selon la distance.
 C'est ce résultat, et lui seul, qui a autorisé l'écriture de ce fichier.

 Les garde-fous d'ARCore sont conservés malgré tout. Ils ne coûtent rien quand
 la mesure est bonne, et un volume absurde présenté comme une mesure reste pire
 que pas de mesure du tout : il est ensuite transmis au modèle comme une donnée
 physique fiable, et sert à calculer des glucides.
 */
enum DepthMeasure {

    struct Result {
        var ok = false
        var volumeCm3: Double = 0
        var areaCm2: Double = 0
        var heightMaxCm: Double = 0
        var heightMeanCm: Double = 0
        var distanceCm: Double = 0
        var cmPerPixel: Double = 0
        var samples = 0
        var note = ""

        /* Compteurs de diagnostic. « 0 point » ne dit pas si la carte était
           vide, si tout était hors de portée, ou si le plan d'appui était faux —
           trois pannes qui demandent trois corrections différentes. */
        var depthPixels = 0
        var inRange = 0
        var confident = 0
        var onPlane = 0
        var planeRmsCm: Double = 0
        var tiltDeg: Double = 0
        var levelDeg: Double = 0    // écart du plan d'appui à l'horizontale réelle
        var fillRatio: Double = 0   // part de la zone centrale comptée comme relief
        var reliefMinMm: Double = 0 // seuil au-dessus duquel un pixel compte
        var edgeRatio: Double = 0   // part du pourtour du cadre occupée par du relief
        var diag = ""
    }

    private static let minHeightM: Double = 0.004
    private static let maxHeightM: Double = 0.22

    /* Le seuil de 4 mm ci-dessus est un PLANCHER, pas le seuil réel. Un pixel ne
       compte comme du relief que s'il dépasse le plan d'appui de plus que le
       bruit de ce plan — et ce bruit varie d'un facteur six selon la surface :
       1 à 2 mm sur un bureau en bois massif bien éclairé, 6 mm sur une table
       ronde vernie prise en biais.

       Avec un seuil fixe à 4 mm, le second cas comptait la moitié de la table
       nue comme du relief : le bruit franchit 4 mm une fois sur deux quand
       l'écart-type vaut 6 mm. Conséquences observées le même jour, sur la même
       brique : le garde-fou de remplissage se déclenchait à 77-79 % alors que
       l'objet n'occupait qu'un tiers du cadre — il détectait du bruit, pas un
       plan faux — et la seule mesure qui passait annonçait 572 cm³ pour 1100.

       À 2,5 écarts-types, moins de 1 % du bruit passe. Le prix est réel et
       assumé : sur une surface qui ajuste mal, un objet de moins de 1,5 cm
       d'épaisseur devient invisible. C'est préférable à un objet inventé —
       et si le plan est bruité à 6 mm, une crêpe de 1 cm n'était de toute
       façon pas mesurable, elle était seulement affichée. */
    private static let reliefNoiseFactor: Double = 2.5

    /* Plage du LiDAR : environ 0,25 à 5 m. On reste plus permissif qu'ARCore
       (qui exigeait 35 cm) parce que le capteur, lui, mesure vraiment de près —
       mais on garde une borne basse : sous 15 cm l'objet sort du champ commun
       à la caméra et au LiDAR, et l'alignement des deux se dégrade. */
    private static let minDepthM: Double = 0.15
    private static let maxDepthM: Double = 2.0
    private static let bestDepthMinM: Double = 0.27

    /* Borne HAUTE de la bande utile, établie sur mesures et non sur intuition.
       Dix prises de la même brique de 1100 cm³, immobile, sur le même bureau :

           29-33 cm  →  −0,3 % en moyenne, dispersion 4,7 %
           34 cm     →  +2,5 %
           35 cm     →  +6,5 %
           36 cm     →  +7,5 %
           37 cm     →  +22 %

       La surface mesurée double entre 32 et 37 cm pour un objet qui n'a pas
       bougé : à 256×192, un pixel couvre 1,8 mm à 32 cm et 2,7 mm à 48 cm, et
       le flou de bord grandit avec lui. Au-delà de 36 cm la mesure est refusée
       plutôt qu'affichée : on n'a aucune raison de croire un nombre dont on
       sait qu'il dérive de 20 %.

       Limite assumée : le cadre ne couvre alors que 23 × 17 cm environ, ce qui
       exclut les grandes assiettes plates. C'est une contrainte à documenter,
       pas à contourner en autorisant une distance invalide. */
    private static let bestDepthMaxM: Double = 0.34
    private static let maxUsefulDepthM: Double = 0.36

    private static let centerFraction = 0.50
    private static let ringFraction = 0.94

    /* ARConfidenceLevel : 0 = low, 1 = medium, 2 = high. On exige au moins
       « medium ». Contrairement à ARCore, où la confiance nulle couvrait des
       surfaces entières (le bois clair et uni notamment), le LiDAR ne déclasse
       que les cas physiques : très absorbant, très réfléchissant, ou trop loin. */
    private static let minConfidence: UInt8 = 1

    private static let minSamples = 60
    private static let minPlanePoints = 150

    /* Une table est plane. Si l'ajustement laisse plus de 1,2 cm d'écart-type,
       c'est que la couronne ne montre pas une table : assiette débordante,
       objets autour, ou carte trop bruitée pour être exploitée. */
    private static let maxPlaneRmsM: Double = 0.012
    private static let outlierM: Double = 0.02

    /* La méthode intègre une CARTE D'ALTITUDE : elle suppose un point de mesure
       par unité de surface de table, donc une vue de dessus. Prise de biais, la
       face verticale d'un objet occupe beaucoup de pixels dont la surface au sol
       est minuscule ; la correction 1/cos les fait alors exploser, et le volume
       avec eux. C'est ce qui donnait 3638 cm³ pour une brique de lait debout,
       photographiée de trois quarts.

       Deux garde-fous : l'inclinaison globale du téléphone, et le rejet des
       pixels rasants — ceux-là décrivent des flancs, pas une épaisseur. */
    private static let maxTiltDeg: Double = 35
    private static let minCos: Double = 0.5

    /* Une table est HORIZONTALE. ARKit connaît la gravité, donc on peut le
       vérifier au lieu de l'espérer — et c'est le seul garde-fou qui distingue
       une table d'un dossier de canapé, d'un mur ou d'un plan aberrant né d'une
       couronne hétérogène. Sans lui, l'ajustement trouvait un plan « plausible »
       à 1,2 cm près sur un mélange de table, de sol et de clavier, et tout le
       centre passait ensuite pour du relief : 543 cm² de relief sur 610 cm² de
       zone, d'où les 4403 cm³ annoncés pour une brique de lait. */
    private static let maxLevelDeg: Double = 20

    /* Un repas ne remplit pas toute la zone de mesure : il y a forcément de la
       table visible autour de lui, dedans. Au-delà de cette proportion, ce n'est
       pas un plat immense, c'est le plan d'appui qui est faux. */
    private static let maxFillRatio: Double = 0.75

    /* Part du pourtour du cadre qu'on tolère occupée par du relief avant de
       conclure que l'objet est coupé. Voir le rejet correspondant. */
    private static let maxEdgeRatio: Double = 0.04

    /* Bornes de vraisemblance d'un repas. Ce sont elles qui auraient arrêté les
       « 5500 cm³ » d'ARCore avant qu'ils n'atteignent l'écran. */
    private static let minAreaCm2: Double = 30
    private static let maxAreaCm2: Double = 1800
    private static let minVolumeCm3: Double = 15
    private static let maxVolumeCm3: Double = 2500

    /* Résumé technique. « champ » est la largeur réelle couverte par l'image à
       la distance mesurée : c'est le seul nombre qui permette de trancher entre
       une distance fausse et une focale fausse, puisqu'on peut le comparer à ce
       que montre l'écran. Si l'écran cadre 35 cm de table et que le champ
       annonce 120 cm, ce sont les intrinsèques qui mentent ; s'il annonce 35 cm
       alors que la distance dit 1 m, c'est la profondeur. */
    private static func diag(_ r: Result, _ dw: Int, _ dh: Int, _ fx: Double, _ fy: Double) -> String {
        let fovCm = fx > 0 ? r.distanceCm * Double(dw) / fx : 0
        return "carte \(dw)x\(dh) f=\(Int(fx.rounded()))/\(Int(fy.rounded()))"
            + " dist \(Int(r.distanceCm.rounded()))cm champ \(Int(fovCm.rounded()))cm"
            + " px \(r.depthPixels) sur \(r.confident) fiables plan \(r.onPlane)"
            + " ecart \(String(format: "%.1f", r.planeRmsCm))cm"
            + " incl \(Int(r.tiltDeg.rounded()))deg"
            + " horiz \(Int(r.levelDeg.rounded()))deg"
            + " rempl \(Int((r.fillRatio * 100).rounded()))%"
            + " seuil \(Int(r.reliefMinMm.rounded()))mm"
            + " bord \(Int((r.edgeRatio * 100).rounded()))%"
    }

    /** Profondeur brute au centre de la carte, en cm. Aucun ajustement, aucun
        filtre : la valeur telle qu'ARKit la donne, pour pouvoir la confronter à
        un mètre ruban. Sans ce point de comparaison, impossible de distinguer
        une carte de profondeur fausse d'un calcul qui la déforme. */
    static func rawCenter(_ depth: ARDepthData) -> String {
        let map = depth.depthMap
        CVPixelBufferLockBaseAddress(map, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(map, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(map) else { return "-" }
        let w = CVPixelBufferGetWidth(map), h = CVPixelBufferGetHeight(map)
        let stride = CVPixelBufferGetBytesPerRow(map)
        let x = w / 2, y = h / 2
        let z = base.advanced(by: y * stride + x * 4)
            .assumingMemoryBound(to: Float32.self).pointee
        var c = 2
        if let cmap = depth.confidenceMap {
            CVPixelBufferLockBaseAddress(cmap, .readOnly)
            if let cbase = CVPixelBufferGetBaseAddress(cmap) {
                let cs = CVPixelBufferGetBytesPerRow(cmap)
                c = Int(cbase.advanced(by: y * cs + x)
                    .assumingMemoryBound(to: UInt8.self).pointee)
            }
            CVPixelBufferUnlockBaseAddress(cmap, .readOnly)
        }
        return "\(Int((Double(z) * 100).rounded())) cm (conf \(c)/2)"
    }

    // MARK: - Mesure

    static func measure(frame: ARFrame, photoWidthPx: Int) -> Result {
        var r = Result()

        guard let depth = frame.sceneDepth else {
            r.note = "Pas de données LiDAR sur cette image."
            return r
        }

        let map = depth.depthMap
        CVPixelBufferLockBaseAddress(map, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(map, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(map) else {
            r.note = "Carte de profondeur illisible."
            return r
        }
        let dw = CVPixelBufferGetWidth(map)
        let dh = CVPixelBufferGetHeight(map)
        let rowStride = CVPixelBufferGetBytesPerRow(map)

        /* Carte de confiance, alignée pixel à pixel sur la profondeur. Sans
           elle, rien ne distingue une distance mesurée d'une distance
           extrapolée — c'était tout le problème du mode lissé d'ARCore, qui
           remplissait les surfaces sans texture et ne le signalait nulle part. */
        var confBase: UnsafeMutableRawPointer?
        var confStride = 0
        let confMap = depth.confidenceMap
        if let cmap = confMap {
            CVPixelBufferLockBaseAddress(cmap, .readOnly)
            confBase = CVPixelBufferGetBaseAddress(cmap)
            confStride = CVPixelBufferGetBytesPerRow(cmap)
        }
        defer {
            if let cmap = confMap { CVPixelBufferUnlockBaseAddress(cmap, .readOnly) }
        }

        @inline(__always)
        func depthAt(_ x: Int, _ y: Int) -> Double {
            let v = base.advanced(by: y * rowStride + x * 4)
                .assumingMemoryBound(to: Float32.self).pointee
            return v.isFinite && v > 0 ? Double(v) : 0
        }

        @inline(__always)
        func confidenceAt(_ x: Int, _ y: Int) -> UInt8 {
            guard let cb = confBase else { return 2 }
            return cb.advanced(by: y * confStride + x)
                .assumingMemoryBound(to: UInt8.self).pointee
        }

        /* Les intrinsèques décrivent l'image capturée (frame.camera.imageResolution),
           à laquelle la carte de profondeur est alignée. Les deux sont en 4:3 sur
           les appareils LiDAR — 1920x1440 et 256x192 — donc le facteur d'échelle
           est le même sur les deux axes.

           On applique néanmoins le facteur de la LARGEUR aux deux focales, et on
           recentre le point principal vertical si les cadrages diffèrent. C'est la
           correction qui manquait sur Android : mettre chaque axe à l'échelle de
           sa propre dimension viole l'hypothèse de pixels carrés, et gonflait
           toutes les surfaces d'un facteur voisin de 4/3. */
        let intr = frame.camera.intrinsics
        let res = frame.camera.imageResolution
        guard res.width > 0, res.height > 0, intr[0][0] > 0, intr[1][1] > 0 else {
            r.note = "Paramètres optiques indisponibles."
            return r
        }
        let scale = Double(dw) / Double(res.width)
        let fx = Double(intr[0][0]) * scale
        let fy = Double(intr[1][1]) * scale
        let cx = Double(intr[2][0]) * scale
        let sameFraming = abs(Double(res.width) / Double(res.height) - Double(dw) / Double(dh)) < 0.02
        let cy = sameFraming ? Double(intr[2][1]) * scale : Double(dh) / 2

        let cx0 = Int(Double(dw) * (1 - centerFraction) / 2), cx1 = dw - cx0
        let cy0 = Int(Double(dh) * (1 - centerFraction) / 2), cy1 = dh - cy0
        let rx0 = Int(Double(dw) * (1 - ringFraction) / 2), rx1 = dw - rx0
        let ry0 = Int(Double(dh) * (1 - ringFraction) / 2), ry1 = dh - ry0

        // ---- Couronne : les points qui serviront de table ----
        var px = [Double](), py = [Double](), pz = [Double]()
        px.reserveCapacity((rx1 - rx0) * (ry1 - ry0))
        py.reserveCapacity((rx1 - rx0) * (ry1 - ry0))
        pz.reserveCapacity((rx1 - rx0) * (ry1 - ry0))

        for y in ry0..<ry1 {
            for x in rx0..<rx1 {
                if x >= cx0 && x < cx1 && y >= cy0 && y < cy1 { continue }
                let z = depthAt(x, y)
                if z <= 0 { continue }
                r.depthPixels += 1
                if confidenceAt(x, y) < minConfidence { continue }
                r.confident += 1
                if z < minDepthM || z > maxDepthM { continue }
                r.inRange += 1
                px.append((Double(x) - cx) * z / fx)
                py.append((Double(y) - cy) * z / fy)
                pz.append(z)
            }
        }
        let n = pz.count
        r.onPlane = n
        if n > 0 { r.distanceCm = median(pz) * 100 }

        if n < minPlanePoints {
            r.note = r.confident == 0
                ? "Le LiDAR ne renvoie rien de fiable ici : surface très sombre, très brillante, ou trop loin. Rapproche-toi à 40-50 cm."
                : "Pas assez de points fiables autour de l'assiette (\(n)) : cadre un peu plus large pour voir de la table tout autour."
            r.diag = diag(r, dw, dh, fx, fy)
            return r
        }

        /* Ajustement en deux temps : un premier plan sur tous les points, puis
           un second sur les seuls points qui en sont proches. Sans cette
           reprise, un bord d'assiette ou un verre attrapé par la couronne
           bascule le plan entier — et toutes les hauteurs avec lui. */
        guard var plane = fit(px, py, pz, keep: nil) else {
            r.note = "Plan d'appui indéterminé : recule pour voir plus de table."
            r.diag = diag(r, dw, dh, fx, fy)
            return r
        }
        var keep = [Bool](repeating: false, count: n)
        var kept = 0
        var nrm = (plane.0 * plane.0 + plane.1 * plane.1 + 1).squareRoot()
        for i in 0..<n {
            let d = abs(plane.0 * px[i] + plane.1 * py[i] + plane.2 - pz[i]) / nrm
            keep[i] = d < outlierM
            if keep[i] { kept += 1 }
        }
        if kept >= minPlanePoints, let refined = fit(px, py, pz, keep: keep) {
            plane = refined
        }

        let a = plane.0, b = plane.1, c = plane.2
        nrm = (a * a + b * b + 1).squareRoot()

        var sq = 0.0
        var used = 0
        for i in 0..<n where keep[i] {
            let d = (a * px[i] + b * py[i] + c - pz[i]) / nrm
            sq += d * d
            used += 1
        }
        r.planeRmsCm = used > 0 ? (sq / Double(used)).squareRoot() * 100 : 999
        if used == 0 || r.planeRmsCm > maxPlaneRmsM * 100 {
            r.note = "Surface d'appui non plane (±\(String(format: "%.1f", r.planeRmsCm)) cm) :"
                + " pose l'assiette sur une table dégagée et recule un peu."
            r.diag = diag(r, dw, dh, fx, fy)
            return r
        }

        /* Le plan ajusté est-il HORIZONTAL dans le monde réel ? La normale du
           plan est exprimée dans le repère de l'image (x droite, y bas, z
           devant) ; le repère caméra d'ARKit a y vers le haut et z vers
           l'arrière, d'où les deux signes inversés. On la fait passer en repère
           monde par la rotation de la pose, et l'axe y du monde est la verticale
           gravitaire — ARKit la connaît, elle est gratuite.

           C'est le contrôle qui manquait. Sans lui, une couronne mêlant table,
           sol et clavier produisait un plan « plausible » à 1,2 cm près, et tout
           le centre passait ensuite pour du relief. */
        let camNormal = simd_float3(Float(a), Float(-b), 1)
        let m = frame.camera.transform
        let rot = simd_float3x3(simd_float3(m.columns.0.x, m.columns.0.y, m.columns.0.z),
                                simd_float3(m.columns.1.x, m.columns.1.y, m.columns.1.z),
                                simd_float3(m.columns.2.x, m.columns.2.y, m.columns.2.z))
        let up = abs(simd_normalize(rot * camNormal).y)
        r.levelDeg = Double(acos(min(1, up))) * 180 / .pi
        if r.levelDeg > maxLevelDeg {
            r.note = "Le support détecté n'est pas horizontal (\(Int(r.levelDeg.rounded()))° de la table) :"
                + " vise une table dégagée, sans canapé ni bord de table dans le cadre."
            r.diag = diag(r, dw, dh, fx, fy)
            return r
        }

        /* Inclinaison du téléphone par rapport à la table : la normale du plan
           ajusté fait cet angle avec l'axe optique. À plat au-dessus de
           l'assiette, elle vaut zéro. */
        r.tiltDeg = acos(min(1, 1 / nrm)) * 180 / .pi
        if r.tiltDeg > maxTiltDeg {
            r.note = "Téléphone trop incliné (\(Int(r.tiltDeg.rounded()))°) :"
                + " tiens-le à plat, écran horizontal, juste au-dessus de l'assiette."
            r.diag = diag(r, dw, dh, fx, fy)
            return r
        }

        // ---- Centre : le relief au-dessus de ce plan ----
        var volume = 0.0, area = 0.0, heightSum = 0.0, maxHeight = 0.0
        var edgePixels = 0
        var depths = [Double]()
        depths.reserveCapacity((cx1 - cx0) * (cy1 - cy0))

        // Seuil de relief adossé au bruit réel de l'ajustement, pas à une
        // constante. Voir reliefNoiseFactor : c'est ce qui distingue un objet
        // d'une table que le capteur voit mal.
        let hMin = max(minHeightM, reliefNoiseFactor * r.planeRmsCm / 100)
        r.reliefMinMm = hMin * 1000

        for y in cy0..<cy1 {
            for x in cx0..<cx1 {
                let z = depthAt(x, y)
                if z <= 0 { continue }
                r.depthPixels += 1
                if confidenceAt(x, y) < minConfidence { continue }
                r.confident += 1
                if z < minDepthM || z > maxDepthM { continue }
                r.inRange += 1

                let qx = (Double(x) - cx) * z / fx
                let qy = (Double(y) - cy) * z / fy
                // Un point PLUS PRÈS de l'objectif que la table est au-dessus d'elle.
                let h = (a * qx + b * qy + c - z) / nrm
                if h < hMin || h > maxHeightM { continue }

                let pixelArea = (z / fx) * (z / fy)
                let len = (qx * qx + qy * qy + z * z).squareRoot()
                let cosv = len > 0 ? abs((-a * qx - b * qy + z) / (nrm * len)) : 1
                if cosv < minCos { continue }

                let flatArea = pixelArea / cosv
                volume += h * flatArea
                area += flatArea
                heightSum += h
                if h > maxHeight { maxHeight = h }
                depths.append(z)
                if x == cx0 || x == cx1 - 1 || y == cy0 || y == cy1 - 1 { edgePixels += 1 }
            }
        }

        /* L'objet doit tenir ENTIÈREMENT dans le cadre. S'il le traverse, on
           intègre un objet tronqué et rien ne le dit : le volume et la surface
           sont ceux de la portion visible, avec la même apparence de sérieux.

           Constaté sur six prises du même bol à la même distance : les trois où
           il débordait donnaient 184 à 211 cm² de surface, les trois où il
           tenait dans le cadre 157 à 169 cm² — 27 % d'écart sur un objet qui
           n'avait pas bougé, uniquement selon qu'il touchait le bord ou non.

           On compte les pixels de relief posés sur le pourtour de la zone
           intégrée. Quelques-uns sont du bruit ; au-delà de 4 % du périmètre,
           c'est un objet coupé. */
        let perimeter = max(1, 2 * ((cx1 - cx0) + (cy1 - cy0)) - 4)
        r.edgeRatio = Double(edgePixels) / Double(perimeter)
        if r.edgeRatio > maxEdgeRatio {
            r.samples = depths.count
            r.note = "L'objet dépasse du cadre : recule un peu ou recentre-le."
                + " Ce qui sort du cadre n'est pas mesuré, et le volume serait faux sans le dire."
            r.diag = diag(r, dw, dh, fx, fy)
            return r
        }

        let count = depths.count
        r.fillRatio = Double(count) / Double((cx1 - cx0) * (cy1 - cy0))
        if r.fillRatio > maxFillRatio {
            r.samples = count
            /* Volontairement, ce message ne dit plus « recule ». Le plan d'appui
               est ajusté sur le bandeau EXTÉRIEUR au cadre : reculer y fait
               entrer le bord de la table, puis le sol, ce qui aggrave
               exactement ce qu'on essaie de corriger. Sur une table ronde de
               60 cm, à 40 cm de distance, le bandeau déborde déjà. */
            r.note = "Presque toute la zone est vue comme du relief (\(Int((r.fillRatio * 100).rounded())) %) :"
                + " le plan d'appui est faux. Il faut de la table nue dans le bandeau entre les deux cadres —"
                + " ni bord de table, ni objet posé à côté."
            r.diag = diag(r, dw, dh, fx, fy)
            return r
        }
        if count < minSamples {
            r.samples = count
            r.note = "Aucun relief au centre (\(count) points) : centre l'assiette dans le cadre."
            r.diag = diag(r, dw, dh, fx, fy)
            return r
        }

        let med = median(depths)
        if med > maxUsefulDepthM {
            r.samples = count
            r.distanceCm = med * 100
            r.note = "Trop loin (\(Int((med * 100).rounded())) cm) : au-delà de 36 cm la mesure gonfle —"
                + " +22 % à 37 cm sur un objet de référence. Rapproche-toi à 30-33 cm."
            r.diag = diag(r, dw, dh, fx, fy)
            return r
        }
        let volumeCm3 = volume * 1e6
        let areaCm2 = area * 1e4

        /* Dernier filtre : la vraisemblance. Une assiette de repas tient dans
           quelques centaines de cm³ ; au-delà, ce n'est pas un plat copieux,
           c'est un plan d'appui faux. */
        if areaCm2 < minAreaCm2 || areaCm2 > maxAreaCm2
            || volumeCm3 < minVolumeCm3 || volumeCm3 > maxVolumeCm3 {
            r.samples = count
            r.note = "Mesure invraisemblable (\(Int(volumeCm3.rounded())) cm³ sur"
                + " \(Int(areaCm2.rounded())) cm²) : recule à 40-50 cm et recadre sur l'assiette seule."
            r.diag = diag(r, dw, dh, fx, fy)
            return r
        }

        r.ok = true
        r.samples = count
        r.volumeCm3 = volumeCm3
        r.areaCm2 = areaCm2
        r.heightMaxCm = maxHeight * 100
        r.heightMeanCm = (heightSum / Double(count)) * 100
        r.distanceCm = med * 100
        let fxPhoto = Double(intr[0][0]) * (Double(photoWidthPx) / Double(res.width))
        r.cmPerPixel = fxPhoto > 0 ? (med / fxPhoto) * 100 : 0
        r.diag = diag(r, dw, dh, fx, fy)
        /* Avis, pas rejet : la mesure reste affichée. L'ancien texte conseillait
           « 40-50 cm », ce que les mesures ont démenti — c'est justement la zone
           où l'erreur passe de −0,3 % à +22 %. */
        if med < bestDepthMinM {
            r.note = "Un peu près (\(Int((med * 100).rounded())) cm) : entre 30 et 33 cm la mesure est plus sûre."
        } else if med > bestDepthMaxM {
            r.note = "Un peu loin (\(Int((med * 100).rounded())) cm) : entre 30 et 33 cm la mesure est plus sûre."
        }
        return r
    }

    // MARK: - Algèbre

    /** Plan z = a·x + b·y + c par moindres carrés, éventuellement restreint. */
    private static func fit(_ px: [Double], _ py: [Double], _ pz: [Double],
                            keep: [Bool]?) -> (Double, Double, Double)? {
        var s11 = 0.0, s12 = 0.0, s13 = 0.0, s22 = 0.0, s23 = 0.0, s33 = 0.0
        var sz = 0.0, sxz = 0.0, syz = 0.0
        for i in 0..<pz.count {
            if let k = keep, !k[i] { continue }
            let x = px[i], y = py[i], z = pz[i]
            s11 += x * x; s12 += x * y; s13 += x
            s22 += y * y; s23 += y; s33 += 1
            sxz += x * z; syz += y * z; sz += z
        }
        if s33 < 3 { return nil }
        return solve3(s11, s12, s13, s12, s22, s23, s13, s23, s33, sxz, syz, sz)
    }

    /** Résolution d'un système 3×3 par élimination de Gauss avec pivot partiel. */
    private static func solve3(_ m11: Double, _ m12: Double, _ m13: Double,
                               _ m21: Double, _ m22: Double, _ m23: Double,
                               _ m31: Double, _ m32: Double, _ m33: Double,
                               _ r1: Double, _ r2: Double, _ r3: Double) -> (Double, Double, Double)? {
        var m = [[m11, m12, m13, r1], [m21, m22, m23, r2], [m31, m32, m33, r3]]
        for col in 0..<3 {
            var pivot = col
            for row in (col + 1)..<3 where abs(m[row][col]) > abs(m[pivot][col]) {
                pivot = row
            }
            if abs(m[pivot][col]) < 1e-9 { return nil }
            m.swapAt(col, pivot)
            for row in 0..<3 where row != col {
                let f = m[row][col] / m[col][col]
                for k in col..<4 { m[row][k] -= f * m[col][k] }
            }
        }
        return (m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2])
    }

    static func median(_ values: [Double]) -> Double {
        if values.isEmpty { return 0 }
        let sorted = values.sorted()
        return sorted[sorted.count / 2]
    }
}
