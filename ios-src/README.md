# Mesure LiDAR (iOS)

Portage de la mesure de volume vers ARKit. Le projet `ios/` n'est pas versionné
— Capacitor le régénère — donc seules ces sources le sont, et
`scripts/ios-sync.sh` les recopie dedans à chaque construction.

| Fichier | Rôle |
|---|---|
| `DepthMeasure.swift` | La physique : plan d'appui, intégration du relief, garde-fous |
| `DepthScanViewController.swift` | Écran de visée, mesure en direct, rafale de capture |
| `DepthScanPlugin.swift` | Pont Capacitor, exposé au JS sous le nom `DepthScan` |
| `GVBridgeViewController.swift` | Enregistre le plugin auprès du pont (indispensable) |

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

## Première mesure de volume par ce code

Brique couchée à plat sur une table dégagée, à 30 cm, inclinaison 16° :

| | Réel | Mesuré | Écart |
|---|---|---|---|
| Surface au sol | 183 cm² | 186 cm² | **+1,6 %** |
| Hauteur moyenne | 6,0 cm | 5,0 cm | −17 % |
| Volume | 1100 cm³ | 923 cm³ | **−16 %** |

La surface à 1,6 % près valide l'échelle absolue et les intrinsèques — c'est
exactement ce qu'ARCore n'a jamais atteint. Tout le déficit porte sur la
hauteur, et l'explication la plus probable est l'arrondi des arêtes vives par
un capteur de 256×192 : une brique n'est faite que d'arêtes. Sur des aliments,
sans angle franc, ce biais devrait être moindre — **à vérifier**, pas à
supposer.

Un seul objet ne fait pas une validation. Il en faut cinq, de tailles
différentes, avant de brancher quoi que ce soit sur l'estimateur.

## Ce que la campagne de mesures a appris

Dix prises de la même brique, sur un bureau en bois, ont donné :

| Distance | Volume | Écart |
|---|---|---|
| 29-33 cm (6 prises) | 923 à 1119 cm³ | **−0,3 % en moyenne**, dispersion 4,7 % |
| 34-36 cm (3 prises) | 1127 à 1182 cm³ | +2,5 % à +7,5 % |
| 37 cm (1 prise) | 1343 cm³ | +22 % |

La surface mesurée **double entre 32 et 37 cm** pour un objet immobile. La
distance n'est donc pas un conseil, c'est un paramètre : au-delà de 35 cm la
mesure dérive systématiquement vers le haut. La consigne affichée a été ramenée
de « 40-50 cm » à « 30-35 cm ».

Après correction du cadrage, huit prises entre 29 et 33 cm donnent **1109 cm³
en moyenne pour 1100 réels — +0,9 %, écart-type 2,2 %**, étendue 1067 à
1142 cm³. Le modèle de vision, lui, se trompe de ~20 % en médiane.

### Le volume est juste, la surface et la hauteur ne le sont pas

Sur ces mêmes prises, la surface annonce 210 à 227 cm² pour 183 réels
(**+16 à +24 %**) et la hauteur moyenne — volume ÷ surface — tombe à 5,0-5,3 cm
pour 6,0 (**−12 à −16 %**). Les deux sont franchement faux et le volume est
juste quand même.

Ce n'est pas une compensation heureuse, c'est une propriété. Le flou du capteur
sur les arêtes est à peu près symétrique : il étale l'objet vers l'extérieur en
ajoutant des pixels de faible hauteur, et rabote les pixels de pleine hauteur
près du bord. Une convolution symétrique **conserve l'intégrale** ∫h·dA. Le
volume y survit ; la surface, qui sort d'un seuillage, est gonflée du périmètre
multiplié par la largeur du flou (~5 mm ici, soit environ 3 pixels), et la
hauteur moyenne dégonflée d'autant.

**Seul le volume doit être transmis en aval.** `areaCm2` et `heightMeanCm` sont
des indicateurs de cadrage, pas des mesures — les passer à l'estimateur
reviendrait à lui donner une surface fausse de 20 %.

## Le liquide n'est pas mesuré, et rien ne le signale

Bol en porcelaine posé sur le bureau, jamais déplacé entre les deux séries,
trois prises chacune à 34-36 cm :

| | Prises | Moyenne |
|---|---|---|
| Vide | 538 · 574 · 539 | 550 cm³ |
| + 300 g d'eau troublée au lait | 664 · 665 · 641 | 657 cm³ |

**Différence : 106 cm³ pour 300 versés**, à ±14 cm³ près. Un tiers du liquide.

Ce qui compte n'est pas l'écart, c'est qu'aucun indicateur ne l'annonce. Sur la
série pleine : `ecart 0.1cm`, `horiz 0deg`, `bord 0%`, `incl 2-3deg`, et une
dispersion de **2,1 %** — la meilleure répétabilité de toute la campagne. Le
capteur renvoie même *plus* de points fiables plein que vide (6284 contre
5290). Il est confiant, reproductible, et faux d'un facteur trois.

Les garde-fous écrits jusqu'ici détectent un mauvais cadrage, un plan d'appui
faux, un objet coupé. **Aucun ne détecte une physique fausse**, et il n'est pas
évident qu'un seul le puisse : une surface liquide est un miroir pour
l'infrarouge, elle ne rétrodiffuse pas mais réfléchit, et ce qui revient est la
distance au plafond via le miroir. Le niveau est lu trop bas, sans dropout ni
perte de confiance.

Conséquence directe : **la validation sur la brique ne suffit pas à autoriser
le branchement sur l'estimateur.** Un objet mat et convexe se mesure à 1 % près,
un contenu liquide à 65 % près, et rien à l'écran ne distingue les deux cas.

### Deux contraintes invisibles, corrigées après coup

**Le plan d'appui n'est pas ajusté là où on vise.** Il l'est sur la couronne :
tout ce qui est hors du cadre intérieur, jusqu'à 94 % de la carte. Sur une
table ronde à 40 cm, cette couronne déborde sur le bord de table puis sur le
sol — et le message d'erreur conseillait alors de *reculer*, ce qui y faisait
entrer davantage. Un second cadre l'affiche désormais, et le message a été
réécrit.

À noter : l'aperçu est en remplissage, donc **environ 6 cm de couronne de
chaque côté sortent de l'écran** à 31 cm de distance. Les bords haut et bas du
cadre extérieur sont visibles, les bords latéraux non — c'est la géométrie, pas
un défaut d'affichage.

**Le seuil de relief doit suivre le bruit du plan.** Fixé à 4 mm alors que
l'ajustement laissait 6 mm d'écart-type sur une table vernie, il comptait la
moitié de la table nue comme du relief : taux de remplissage bloqué à 74-79 %
quel que soit le cadrage, garde-fou qui se déclenchait sur du bruit, et
572 cm³ annoncés pour 1100 quand une mesure passait. Le seuil vaut désormais
2,5 écarts-types du plan, avec 4 mm comme plancher. Il est affiché dans le
diagnostic (`seuil Xmm`).

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
« Automatically manage signing » → choisir son équipe. Puis *File → Add Files
to "App"…*, ajouter les `.swift` de `ios/App/App/` en cochant « Add to targets:
App » et en **décochant « Copy items if needed »**. Enfin sélectionner l'iPhone
branché et appuyer sur ▶.

### Deux pièges, tous deux silencieux

**Capacitor ne découvre pas les plugins écrits dans la cible de l'app.** Sans
`GVBridgeViewController`, tout compile, l'app se lance, et le pont répond
« DepthScan plugin is not implemented on ios » — sans qu'aucune étape n'ait
échoué. Le script branche ce contrôleur dans Main.storyboard.

**« Copy items if needed » duplique les fichiers.** Xcode en dépose une copie
dans `ios/App/`, pas dans `ios/App/App/`, et c'est cette copie-là que le projet
compile ensuite. Le script écrit dans `ios/App/App/` : il annonce
« Injection », la construction réussit, et l'app exécute l'ancien code
indéfiniment. Un *Clean Build Folder* n'y change rien — il recompile à fond le
mauvais fichier. Trois cycles perdus avant qu'un `find` ne montre les deux
chemins. Le script aligne désormais toutes les copies qu'il trouve sous `ios/`,
mais si un jour une mesure refuse obstinément de changer de comportement,
commencer par :

```
find ios -name "DepthMeasure.swift"
```

Ensuite, à chaque modification : `bash scripts/ios-sync.sh` puis ▶.

## Statut

**Compilé, exécuté, partiellement validé — non branché.**

Ce qui est acquis :

- Sur un objet **mat, convexe, posé à plat** entre 29 et 33 cm : 1109 cm³ pour
  1100 réels sur huit prises, écart-type 2,2 %. Le modèle de vision se trompe
  de ~20 % en médiane. Le gain est d'un ordre de grandeur.
- Seul le **volume** est exploitable ; la surface est haute de 20 %, la hauteur
  moyenne basse d'autant.
- Au-delà de 36 cm la mesure dérive et est refusée.

Ce qui bloque le branchement :

- Sur un **contenu liquide**, la mesure ne voit qu'un tiers du volume — et
  aucun indicateur ne le signale, la répétabilité étant même meilleure que sur
  la brique. Un plat en sauce, une soupe, un yaourt brillant relèvent
  probablement du même cas.
- Il manque la mesure d'un **contenu opaque et mat** de volume connu
  (compote, yaourt) pour savoir si l'échec porte sur les liquides seuls ou sur
  toutes les formes creuses remplies.

Tant que ce point n'est pas tranché, aucun volume n'est transmis au modèle :
une mesure fausse présentée comme une donnée physique est pire que pas de
mesure du tout, parce qu'elle sert ensuite à calculer des glucides. Et le cas
du bol montre qu'elle peut être fausse en ayant l'air parfaite.

## Ce qui EST branché : l'échelle

Le volume butait de toute façon sur un obstacle que la validation ne pouvait
pas lever : il mesure **le contenant plus la nourriture**. Devant un vrai
repas, on ne peut pas soustraire l'assiette — le protocole vide/plein est un
étalonnage de laboratoire, pas un usage.

L'échelle n'a pas ce problème. `fieldWidthCm` est la largeur réelle, en cm,
couverte par la photo transmise. Elle ne vient que de la distance et des
intrinsèques : ni seuillage, ni hypothèse de forme, ni dépendance au contenu ou
au récipient. C'est ce que ce capteur mesure le mieux, et c'est exactement
l'information qui manque à un modèle de vision — sur une photo, une coupelle
cadrée serré et une assiette de 28 cm se ressemblent.

Deux conséquences dans le code :

- **L'échelle survit au refus du volume.** Support non horizontal, zone trop
  remplie, objet coupé par le cadre : ces rejets invalident une intégration de
  relief, pas une distance. Et c'est le cas courant en usage réel, où le repas
  remplit le cadre.
- **Elle ne resserre pas la fourchette d'erreur.** Elle est juste, mais elle ne
  dit rien de la hauteur — l'inconnue d'une vue de dessus — ni de la densité de
  l'aliment. Resserrer afficherait une précision que la mesure ne porte pas.

### Le piège de l'orientation

`imageResolution` et les intrinsèques sont donnés en **paysage** : `res.width`
est le grand côté, `intr[0][0]` sa focale. La photo livrée au JavaScript est
pivotée en portrait (`.oriented(.right)`), donc sa largeur épouse le **petit**
côté, gouverné par `intr[1][1]` et `res.height`.

Le calcul d'origine croisait les deux et surestimait l'échelle d'un facteur
4/3, soit **33 %**. Tant que le chiffre n'était qu'affiché sous la photo, la
faute est passée inaperçue pendant toute la campagne ; transmise à
l'estimateur, elle aurait grossi chaque portion d'un tiers. Le diagnostic
affiche désormais `champ` (paysage, capteur) et `photo` (portrait, image
livrée) côte à côte — ils diffèrent de 4/3, et c'est normal.
