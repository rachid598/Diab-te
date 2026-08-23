# GlucoVision — Estimateur de glucides 🩸

Estime les **glucides d'un repas à partir d'une photo** (ou d'une simple description écrite)
et les convertit en **grammes et en parts** à saisir dans une pompe à insuline. Pensée pour
l'**insulinothérapie fonctionnelle** (diabète de type 1), utilisable en PWA ou en
application Android.

> ⚠️ **Avertissement médical.** Cet outil est une **aide à l'estimation**, pas un dispositif
> médical. Toute estimation de glucides à partir d'une photo comporte une marge d'erreur.
> L'app **ne propose jamais de dose** : elle donne une quantité de glucides, c'est la pompe
> qui dose. Vérifie toujours le résultat avec ton propre jugement avant de saisir, contrôle
> ta glycémie, et ne modifie jamais tes réglages sans ton équipe soignante. Tu restes
> responsable de la dose finale.

## 📥 Utiliser l'app

| | |
|---|---|
| **Web (PWA)** | **[rachid598.github.io/Diab-te](https://rachid598.github.io/Diab-te/)** — installable depuis le navigateur |
| **Android (APK de test ARCore)** | **[glucovision.apk](https://github.com/rachid598/Diab-te/releases/download/apk-codex/glucovision.apk)** — branche et canal uniques `codex`, signé comme l'application existante |

L'APK se met à jour **tout seul** : il vérifie au lancement s'il existe une version plus
récente du contenu web, la télécharge et propose « Actualiser ». Une réinstallation n'est
nécessaire que si une capacité **native** est ajoutée. Un bouton
*Réglages → Vérifier les mises à jour* force le contrôle et dit précisément où ça bloque.

Le dépôt ne maintient plus deux versions concurrentes « avec » et « sans » relief. La
branche unique **`codex`** produit la même application Android et conserve le même
`applicationId`, la même clé de signature et le même canal OTA. ARCore est une capacité
**optionnelle** dans cet APK : le parcours photo classique reste disponible si le téléphone
n'est pas compatible, si la carte n'est pas suivie ou si l'utilisateur ne l'active pas.

---

## Trois modes, dont deux parcours photo

**📷 Photo libre** — une à six vues du repas, sans matériel particulier. Deux angles
complémentaires — dessus puis vue oblique — restent plus utiles qu'une rafale presque
identique. Ce parcours ne revendique aucune échelle métrique : les portions restent estimées
visuellement.

**▰ Photo avec carte repère (v2 — bêta terrain)** — télécharge
**[la carte GlucoVision v2 imprimable](glucovision-card.svg)**, imprime-la sur papier mat à
**100 % sans ajustement**, puis vérifie avec une règle que sa ligne témoin mesure exactement
50 mm. Pose-la entièrement visible, à plat et sur le même plan que le repas ; ne la tiens pas
en main et ne la masque pas avec l'assiette. Elle fournit au traitement un motif connu et une
taille physique de 85,60 × 53,98 mm. Elle ne pèse pas les aliments, ne connaît pas leur
densité et ne transforme pas une photo en mesure médicale. Si elle n'est pas détectée de
façon fiable, le résultat doit rester une estimation photo libre.

Le motif v2 est volontairement asymétrique, mat et riche en détails non répétitifs, avec des
teintes choisies pour rester contrastées même converties en niveaux de gris — c'est ainsi
qu'ARCore lit l'image. À chaque publication, la CI régénère le PNG Android depuis cet unique
SVG, exige une correspondance octet par octet, puis exécute réellement le binaire officiel
`arcoreimg` livré dans le SDK ARCore tag 1.54.0 de
[google-ar/arcore-android-sdk](https://github.com/google-ar/arcore-android-sdk), vérifié par
SHA-256 (l'exécutable se présente lui-même comme version 1.2). La publication est bloquée
sous le seuil recommandé de **75** et le score
mesuré est écrit dans le résumé du build. Ce score peut varier selon la version ou la
plateforme de l'outil et évalue la facilité de suivi du fichier numérique, **pas** le taux de
détection imprimé ni la précision des glucides ou des portions.

- SVG imprimable v2 : `3b283263c6ddf366a50da1225e4456f93176573c3ee93e65e9064caad1ddf78f`
- PNG v2 embarqué : `53ec79a2c5952673baa4ce0847428abd7215cd37ad16981161509d8371da854c`

Dans l'APK Android compatible, le bouton optionnel **Photo mesurée** suit la carte avec
ARCore et calcule le plan métrique à partir de sa pose. Il transmet l'échelle du champ
photographié seulement si la carte est encore visible, en suivi complet, fraîche et stable
sur plusieurs observations pour cette vue précise. Si la profondeur ARCore est aussi
disponible, elle doit concorder avec la carte avant que le relief expérimental soit conservé.
Le volume n'est jamais converti directement en masse ou en glucides.
La mention bêta ne sera retirée qu'après le
**[protocole de validation sur carte imprimée et téléphone réel](CARTE-TEST-TERRAIN.md)**.

**✍️ Description** — aucune photo : tu écris ce que tu manges. Le modèle interprète les
portions courantes françaises. La marge d'erreur est structurellement plus large, et l'app
le dit au lieu de le masquer.

**🥖 Manuel** — base d'aliments hors ligne, produits emballés via
[OpenFoodFacts](https://world.openfoodfacts.org) (recherche par nom ou scan de code-barres),
repas fréquents enregistrés. Fonctionne sans réseau et sans clé API.

Pour un paquet, l'app sait maintenant calculer une consommation en unités : indique par
exemple **300 g, 15 biscuits, j'en mange 2** et elle calcule **40 g de produit puis 28 g de
glucides** si l'étiquette annonce 70 g/100 g. Un compte trouvé automatiquement dans une
fiche produit reste une suggestion à confirmer : « 2 × 250 g » peut décrire deux
sachets, pas deux biscuits. Le poids direct d'une unité est aussi accepté. Les produits
scannés et les corrections personnelles enrichissent la recherche locale du téléphone.

## Comment la précision est obtenue

La difficulté n'est pas de reconnaître l'aliment, c'est d'**estimer la portion**. La méthode
est imposée au modèle comme consigne :

1. **N'accepter que l'échelle native de la carte vérifiée pour la vue concernée** ; une carte
   simplement visible n'est pas une mesure. Sans preuve native, annoncer que la portion reste
   estimée à vue.
2. **Croiser les angles** pour la hauteur, invisible sur une vue de dessus seule.
3. **Volume → masse** via la densité et la consistance (riz aéré ou tassé, mie dense, friture).
4. **Masse × densité glucidique**, sans oublier les glucides cachés (sauces, panure, sucre).
5. **Resserrer l'incertitude** au maximum honnête, sans la gonfler « par sécurité ».

### Les garde-fous

**La photo est contrôlée avant l'appel.** Netteté (variance du laplacien) et exposition
sont mesurées **en local**, en quelques millisecondes et sans aucun appel réseau. Une vue
floue ou écrasée est signalée sur sa propre vignette — avant de payer une estimation qu'on
saura mauvaise vingt secondes plus tard, sans savoir que la cause était la photo.

**La deuxième vue est encouragée.** Sur une photo unique, l'épaisseur est déduite et non
vue : c'est la principale source d'erreur sur une portion. L'app le dit dès la première
vue, au moment où l'on peut encore agir.

**Le modèle ne décide jamais si le repère est valide.** ARCore doit confirmer localement la
carte, son identité, sa pose, sa fraîcheur et sa stabilité dans la photo concernée. Les champs
`referenceFound` ou `referenceUsed` que le modèle pourrait inventer sont ignorés. Sans cette
preuve native, la marge d'erreur reste celle d'une photo libre.

**Contrôle de vraisemblance.** Le total brut, sa fourchette et la somme des aliments sont
validés avant affichage. Une réponse incohérente ou supérieure à 400 g est bloquée au lieu
d'être proposée. La fourchette affichée vient des erreurs observées au banc d'essai, pas de
la confiance que le modèle s'attribue. Aucun appel réseau, aucun coût.

**Vérification croisée, aliment par aliment.** Un second modèle estime le même repas en
parallèle. L'app compare les totaux **et le contenu** : deux modèles peuvent tomber sur
70 g pour des raisons opposées, et annoncer « confirmé » là-dessus serait une fausse
assurance. Elle dit alors précisément *« l'autre modèle voit du pain que le premier ignore »*.

**D'où vient l'écart.** Quand plusieurs avis divergent, l'app ne se contente plus d'annoncer
la différence : elle aligne les aliments d'une colonne à l'autre et nomme les postes qui la
portent — *« frites : 45 g (Gemini) → 95 g (Grok), 50 g d'écart »*. Un total qui diffère de
69 g ne se vérifie pas ; une corbeille de frites, si. Un aliment compté par un seul modèle
est signalé comme tel, parce que ne pas le voir est une divergence, pas une donnée manquante.

**Repas hors du domaine mesuré.** Le banc d'essai ne contient que des assiettes de 20 à 130 g
de glucides et de 2 à 7 aliments. Au-delà — un plateau de restaurant, par exemple — la
fourchette et la fiabilité affichées viennent de plats plus simples et n'ont jamais été
vérifiées sur ce type de repas. L'app le dit au lieu de les présenter comme acquis.

**Inventaire de ce qui a été vu.** Une phrase décrivant l'assiette, chaque aliment avec sa
portion retenue et l'hypothèse faite, l'échelle utilisée. C'est ce qui permet de repérer une
confusion avant de doser. Toute portion au-dessus de 10 g de glucides doit porter son
**ancrage** — dimensions en cm ou décompte d'unités —, et non une portion type mémorisée :
deux modèles qui partent de la même moyenne se trompent ensemble sans que rien ne le signale.

**Reconnaissance d'un repas déjà mangé.** Si le plat ressemble vraiment à un repas passé
dont la valeur réelle a été relevée, l'app affiche l'écart constaté ce jour-là. Une mesure
sur ce plat précis vaut mieux qu'un biais moyen. Comparaison locale : recouvrement des noms
d'aliments et proximité du total, les deux étant nécessaires.

**Relance sur un autre modèle sans reprendre la photo.** Un résultat douteux se rejoue
depuis les images déjà en mémoire, avec n'importe quel modèle configuré, sans modifier les
réglages par défaut.

**Banc d'essai des modèles.** Rejoue d'anciens repas — photo conservée **et** valeur réelle
pesée, lue sur l'emballage ou calculée — sur plusieurs modèles, et classe chacun par son
écart moyen à cette valeur. Aucun classement public ne dit quel modèle lit le mieux *ton*
assiette ; celui-ci le mesure. Chaque essai est un vrai appel : le coût est annoncé avant.

**La source des valeurs réelles est qualifiée.** Pesée, étiquette, recette calculée ou
estimation personnelle. Seules les trois premières calibrent le modèle et arbitrent le banc
d'essai : corriger une estimation avec une autre estimation amplifie du bruit au lieu de le
réduire.

**Calibration personnelle.** Les écarts constatés entre estimations passées et valeurs
réelles saisies sont transmis au modèle, par catégorie d'aliment — « les féculents sont
sous-estimés de 20 % » est exploitable, une moyenne globale ne l'est pas.

## Ce que l'app donne aussi

- **Index et charge glycémiques** depuis une table de référence locale (valeurs mesurées et
  publiées, pas retrouvées de mémoire par un modèle). La charge est mise en avant car elle
  tient compte de la portion.
- **Vitesse d'absorption** du repas — rapide, progressive ou retardée. C'est une propriété
  du repas, **pas une prédiction de glycémie** : celle-là demanderait le capteur et
  l'insuline active, que la pompe possède et l'app non.
- **Rappel de contrôle** programmé après le repas, calé sur la vitesse d'absorption (Android).
- **Synthèse pour le médecin** — document autonome et lisible, sans dose ni glycémie.
- **Apprentissage post-repas** : saisis les glucides réels quand tu les connais, l'app en
  déduit tes écarts habituels.
- **Sauvegarde automatique** de chaque estimation, pour qu'un oubli ne fasse pas perdre le
  repas ni l'apprentissage.

## Fournisseurs d'IA

Une clé personnelle, appelée directement depuis l'appareil. **Rien ne transite par un
serveur intermédiaire** en dehors du fournisseur choisi.

| Fournisseur | Où obtenir une clé | Coût indicatif par estimation |
|---|---|---|
| **Anthropic** (Claude) | [console.anthropic.com](https://console.anthropic.com/settings/keys) | ~0,018 $ (Sonnet 5) |
| **Google** (Gemini) | [aistudio.google.com](https://aistudio.google.com/app/apikey) | ~0,002 $ (3.1 Flash-Lite) — facturation obligatoire depuis l'UE |
| **OpenAI** (ChatGPT) | [platform.openai.com](https://platform.openai.com/api-keys) | ~0,012 $ |
| **OpenRouter** (tous modèles) | [openrouter.ai/keys](https://openrouter.ai/keys) | de ~0,0005 $ à ~0,10 $ selon le modèle |

⚠️ L'abonnement **ChatGPT Plus/Pro ne donne pas accès à l'API** — c'est une facturation
séparée. Idem pour Claude Pro.

Le coût dérisoire d'OpenRouter est ce qui rend la **vérification croisée systématique**
tenable : environ 70 estimations pour 1 $ avec Qwen3-VL 235B Thinking, 2500 avec Qwen 3.7
Flash.

## Quel modèle choisir — la mesure, pas la réputation

Les modèles proposés dans les Réglages portent leur **erreur mesurée**, pas une étiquette
commerciale. Elle vient d'un banc d'essai sur 44 plats du jeu de données
[Nutrition5k](https://github.com/google-research-datasets/Nutrition5k) (Google Research),
pesés ingrédient par ingrédient, passés au prompt exact de l'application. Protocole complet,
résultats et réserves : **[BENCHMARK.md](BENCHMARK.md)**.

Deux enseignements ont changé les réglages par défaut :

**Le prix n'achète pas la précision.** Claude Opus 5 se trompe de 12,0 g en moyenne pour 35×
le prix de Gemini 3.1 Flash-Lite, qui se trompe de 10,9 g en 3,5 secondes. Claude Sonnet 5
(14,5 g) est derrière Qwen 3.7 Flash, 79× moins cher. **Aucun écart entre deux modèles
voisins n'est statistiquement significatif** à cette taille d'échantillon — d'où la règle
retenue : à précision indistinguable, le moins cher et le plus rapide. Le défaut Gemini est
donc passé de 3.6 Flash (qui sous-estimait de 30 %) à **3.1 Flash-Lite**.

**Le plafond est plus bas qu'il n'y paraît.** Sur des assiettes simples, un diététicien
professionnel se trompe de 14,8 g en moyenne, et une personne diabétique estimant son propre
repas de 21 à 28 g. À 10,9 g, l'estimation est donc déjà au niveau d'un professionnel : la
marge qui reste sur ce type de plat est mince, et les progrès sont à chercher ailleurs — sur
les repas composés, où plus aucune vérité terrain publique n'existe. Chiffres et réserves :
**[BENCHMARK.md](BENCHMARK.md)**.

**Deux avis moyennés valent mieux que le meilleur des deux.** Les erreurs de Gemini 3.1
Flash-Lite et de Qwen3-VL 235B Thinking sont faiblement corrélées (r = +0,30) et de sens
opposé. Leur moyenne bat chacun des deux sur les deux manches du banc (6,8 g contre 8,7 et
11,9 sur la manche de validation). Le réglage existe — *Second avis → moyenne des deux* —
et reste **désactivé par défaut** : le gain n'est pas significatif à n = 38, et ce réglage
déplace le nombre saisi dans la pompe.

Aucune migration automatique de modèle n'accompagne cette version. Un modèle qui fonctionne
n'est pas remplacé dans le dos de l'utilisateur : le changement se fait dans les Réglages.

## Capacités natives (Android)

L'APK n'est pas qu'un habillage : il lève des limites réelles du navigateur.

- **Plus de blocage CORS** — les requêtes partent du code natif, ce qui rend à nouveau
  utilisables des services que le navigateur refusait.
- **Appareil photo du système** — pleine résolution, une seule compression au lieu de deux.
- **Stockage sans quota** — les photos sont de vrais fichiers ; fini le rognage de
  l'historique imposé par la limite de localStorage.
- **Clés API dans le Keystore**, chiffrées par le matériel du téléphone.
- **Notifications programmées** fiables, déclenchées par le système.
- **File d'attente hors-ligne** — au restaurant sans réseau, le repas est gardé et analysé
  au retour de la connexion.
- **Raccourcis** — appui long sur l'icône pour ouvrir directement l'appareil photo.
- **Carte ARCore expérimentale** — échelle issue de la pose d'une carte dédiée, acceptée
  uniquement en suivi complet, frais et stable. La profondeur n'ajoute un relief que si sa
  géométrie concorde avec celle de la carte.

## Suivi de la consommation

Les Réglages affichent le nombre d'appels réellement effectués dans le mois, par modèle, et
le coût approximatif d'après les tarifs publics. Le prix est appliqué à l'affichage et non
enregistré : corriger un tarif ne réécrit pas l'historique.

## Confidentialité

Les réglages, l'historique, les photos et les aliments personnalisés sont conservés sur
l'appareil par GlucoVision. Lors d'une estimation, les photos et le texte partent directement
vers le fournisseur d'IA choisi : aucun serveur GlucoVision ne sert d'intermédiaire et aucune
télémétrie n'est ajoutée, mais le fournisseur applique ses propres règles de traitement et de
conservation.

L'**export de sauvegarde exclut toujours les clés API**. Sur Android, elles restent dans le
Keystore du téléphone ; après un changement d'appareil, il faut donc les renseigner de
nouveau. Les photos originales de l'APK ne sont pas incluses dans le JSON (les repas et les
éventuelles petites vignettes web le sont). L'APK exclut également toutes les données de la
sauvegarde cloud et du transfert automatique Android : le passage vers un autre téléphone se
fait donc par cet export explicite. L'historique reste personnel et peut contenir des
informations de santé : garde le fichier de sauvegarde dans un emplacement privé.

## Développement

```bash
npm ci                            # dépendances Capacitor + esbuild verrouillées
npm test                          # garde-fous JS, stockage et géométrie ARCore
npx http-server -p 8080           # servir en local ; aucune étape de build pour le web
bash scripts/build-plugins.sh     # après un changement de version de plugin Capacitor
bash scripts/build-www.sh         # prépare www/ pour l'APK
node scripts/render-card.mjs      # régénère le PNG Android depuis l'unique SVG de la carte
npm run card:check                # vérifie que le PNG committé est exactement ce rendu
node scripts/render-icons.mjs     # régénère les PNG d'icônes depuis icons/*.svg
```

JavaScript sans dépendance à l'exécution (modules IIFE exposant des globales), aucun
transpileur, aucun framework. L'APK est produit par GitHub Actions (Capacitor 8, Node 22)
**uniquement depuis `codex`**. Toute autre branche est refusée avant le build. L'APK est
publié sous `apk-codex` et le manifeste web sous `ota-codex`. Chaque archive OTA versionnée
(`ota-v73`, etc.) est immuable et vérifiée par SHA-256 avant installation. Les anciens
canaux de variantes restent des archives de téléchargement ; ils ne sont plus alimentés.

| Fichier | Rôle |
|---|---|
| `js/estimator.js` | prompts, appels aux quatre fournisseurs, normalisation, garde-fous |
| `js/storage.js` | persistance, calibration personnelle, sauvegarde/restauration |
| `js/gi.js` | table locale d'index glycémiques |
| `js/foods.js` | base glucidique hors-ligne du mode manuel |
| `js/native.js` | pont unique vers Capacitor, avec repli web transparent |
| `js/camera.js` | capture et compression des images |
| `js/off.js` | accès à OpenFoodFacts |
| `js/queue.js` | file d'attente hors-ligne |
| `js/report.js` | synthèse pour la consultation |
| `js/bench.js` | banc d'essai sur les repas de l'utilisateur |
| `js/app.js` | interface |
| `glucovision-card.svg` | source canonique vectorielle de la carte v2, à imprimer à 100 %, 85,60 × 53,98 mm |
| `android-card/glucovision-card.png` | rendu déterministe de ce SVG, embarqué dans l'APK |
| `CARTE-TEST-TERRAIN.md` | protocole nécessaire avant de retirer la mention bêta |
| `bench/` | banc d'essai hors ligne sur Nutrition5k (voir [BENCHMARK.md](BENCHMARK.md)) |

---

Projet personnel, sans garantie. Ce n'est pas un produit certifié et il ne doit pas être
présenté comme tel.

*Prends soin de toi. En cas de doute sur une dose : glycémie + jugement + équipe soignante.*
