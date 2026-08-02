# Mesure LiDAR (iOS)

Portage de la mesure de volume vers ARKit. Le projet `ios/` n'est pas versionné
— Capacitor le régénère — donc seules ces sources le sont, et
`scripts/ios-sync.sh` les recopie dedans à chaque construction.

| Fichier | Rôle |
|---|---|
| `DepthMeasure.swift` | La physique : plan d'appui, intégration du relief, garde-fous |
| `DepthScanViewController.swift` | Écran de visée, mesure en direct, rafale de capture |
| `DepthScanPlugin.swift` | Pont Capacitor, exposé au JS sous le nom `DepthScan` |

Le nom `DepthScan` et les champs renvoyés sont identiques à ceux du plugin
Android. `js/native.js` n'a donc rien à changer : il ne sait pas sur quelle
plateforme il tourne.

## Pourquoi ce portage existe

La version ARCore est gelée derrière un réglage désactivé par défaut. Elle a
traversé dix versions et six bogues réels sans jamais produire un volume
validé, parce que le capteur lui-même n'était pas à la hauteur : ARCore déduit
la profondeur du **mouvement** du téléphone, ce qui exige de la texture et du
déplacement, et se dégrade sans le signaler en dessous de 50 cm.

Le LiDAR mesure un **temps de vol**. Test de validation, sur une brique de lait
de 195 × 94 × 60 mm mesurée au ruban :

| Arête | Ruban | Measure (30 cm) | Measure (50 cm) | Écart |
|---|---|---|---|---|
| Hauteur | 195 mm | 190 mm | 190 mm | −2,6 % |
| Largeur | 94 mm | 90 mm | 90 mm | −4,3 % |
| Profondeur | 60 mm | 60 mm | 60 mm | 0 % |

Moins de 5 % d'écart, et surtout **aucune dérive entre 30 et 50 cm** — c'était
précisément le point où ARCore s'effondrait. C'est ce résultat, et lui seul, qui
a autorisé l'écriture du code.

Réserve : les deux écarts vont dans le même sens (−5 mm, −4 mm). Un biais
systématique, pas du bruit. Il peut venir du LiDAR comme du placement des points
dans l'app Measure — on ne sait pas encore, et **aucune correction constante n'a
été appliquée** tant que ce n'est pas tranché sur des volumes connus.

## Ce qui change par rapport à ARCore

- **Aucune consigne de mouvement.** Immobile fonctionne. La version Android
  demandait de balayer le téléphone — et pendant plusieurs versions disait
  l'inverse, ce qui était le contraire de ce qu'il fallait faire.
- **Distance minimale 15 cm** au lieu de 35 cm.
- **Rafale de 9 mesures**, médiane retenue, dispersion signalée. Il faut au
  moins 5 mesures valables sur 9 ; en dessous, la photo est renvoyée **sans**
  volume plutôt qu'avec un volume douteux.
- **Confiance sur 3 niveaux** (`ARConfidenceLevel`) au lieu de 0-255.

Tout le reste est conservé tel quel : ajustement du plan d'appui sur la
couronne de l'image plutôt que sur la détection de plans, reprise de
l'ajustement après rejet des aberrants, rejet des pixels rasants, limite
d'inclinaison à 35°, et bornes de vraisemblance sur la surface et le volume.

## Construire

Prérequis : macOS, Xcode, `brew install node cocoapods`.

```
npm install
bash scripts/ios-sync.sh
npx cap open ios
```

Dans Xcode, une seule fois : cible **App** → *Signing & Capabilities* →
« Automatically manage signing » → choisir son équipe. Puis sélectionner
l'iPhone branché et appuyer sur ▶.

Ensuite, à chaque modification : `bash scripts/ios-sync.sh` puis ▶.

## Statut

**Spike non validé.** Le code n'a jamais été compilé ni exécuté — il a été écrit
sur une machine Linux, sans compilateur Swift. Il reste à :

1. le faire compiler ;
2. mesurer 5 objets de volume connu (brique de lait, bol d'eau pesé, boîte
   rectangulaire, etc.) et comparer ;
3. **seulement alors** décider de le brancher sur l'estimateur.

Tant que l'étape 2 n'est pas faite, aucun volume ne doit être transmis au
modèle : une mesure fausse présentée comme une donnée physique est pire que pas
de mesure du tout, parce qu'elle sert ensuite à calculer des glucides.
