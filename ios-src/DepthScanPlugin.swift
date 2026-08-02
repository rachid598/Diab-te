import ARKit
import Capacitor
import Foundation

/**
 Pont vers la mesure de profondeur ARKit.

 Le nom exposé au JS est `DepthScan`, identique au plugin Android. C'est
 délibéré : `js/native.js` appelle `Cap.DepthScan.available()` et
 `Cap.DepthScan.capture()`, et attend exactement les mêmes champs en retour.
 Le web ne sait donc pas sur quelle plateforme il tourne, et il n'a pas à le
 savoir — un seul chemin de code, deux implémentations natives.

 Tout reste facultatif. Sans LiDAR, sans ARKit, ou si la mesure échoue,
 l'appelant retombe sur la prise de photo normale.
 */
@objc(DepthScanPlugin)
public class DepthScanPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "DepthScanPlugin"
    public let jsName = "DepthScan"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "capture", returnType: CAPPluginReturnPromise)
    ]

    /**
     Le LiDAR est-il utilisable ici ?

     Pas d'attente ni de nouvel essai, contrairement à la version ARCore : il n'y
     a pas de service tiers à réveiller, pas d'installation à déclencher, pas de
     liste de compatibilité à consulter en ligne. Le capteur est présent ou non,
     et `supportsFrameSemantics` répond immédiatement.

     `installed` est renvoyé pour garder la forme du contrat Android, où il
     distinguait « appareil compatible » de « services ARCore installés ». Sur
     iOS les deux se confondent.
     */
    @objc func available(_ call: CAPPluginCall) {
        let hasARKit = ARWorldTrackingConfiguration.isSupported
        let hasDepth = hasARKit && ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
        call.resolve([
            "supported": hasDepth,
            "installed": hasDepth,
            "reason": hasDepth ? "LIDAR" : (hasARKit ? "SANS_LIDAR" : "SANS_ARKIT")
        ])
    }

    /** Ouvre l'écran de visée, rend la main quand l'utilisateur a capturé. */
    @objc func capture(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController else {
                call.reject("Interface indisponible.")
                return
            }
            let vc = DepthScanViewController()
            vc.modalPresentationStyle = .fullScreen
            /* `call` est capturé fortement par la fermeture : c'est ce qui le
               maintient en vie pendant que l'écran est affiché. Sans cette
               référence, la promesse JS ne se résoudrait jamais et le bouton
               resterait bloqué sans le moindre message. */
            vc.onDone = { payload in call.resolve(payload) }
            host.present(vc, animated: true)
        }
    }
}
