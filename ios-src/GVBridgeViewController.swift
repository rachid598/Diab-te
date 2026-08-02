import Capacitor
import UIKit

/**
 Enregistre DepthScanPlugin auprès du pont Capacitor.

 Ce fichier existe pour une raison précise, et c'est celle qui a coûté le plus
 de temps : Capacitor ne découvre PAS tout seul les plugins écrits dans la
 cible de l'application. Les plugins livrés en paquet npm sont trouvés par le
 balayage des modules ; ceux qu'on écrit soi-même dans App/ doivent être
 déclarés à la main, sinon le proxy JavaScript existe, l'appel part, et le pont
 répond « DepthScan plugin is not implemented on ios ». Le code compile
 parfaitement, l'app se lance, et rien n'indique nulle part ce qui manque.

 La méthode capacitorDidLoad est appelée une fois le pont prêt, avant le
 chargement de la page web — donc avant que js/native.js interroge le plugin.
 */
class GVBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(DepthScanPlugin())
    }
}
