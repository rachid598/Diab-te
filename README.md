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
| **Android (APK)** | **[glucovision.apk](https://github.com/rachid598/Diab-te/releases/download/apk-latest/glucovision.apk)** — lien permanent, toujours le dernier build |

L'APK se met à jour **tout seul** : il vérifie au lancement s'il existe une version plus
récente du contenu web, la télécharge et propose « Actualiser ». Une réinstallation n'est
nécessaire que si une capacité **native** est ajoutée. Un bouton
*Réglages → Vérifier les mises à jour* force le contrôle et dit précisément où ça bloque.

---

## Trois façons d'estimer

**📷 Photo** — une à six vues du repas. Un **objet-repère de taille connue** posé à côté de
l'assiette (par défaut la pompe MiniMed 780G, 96,8 × 53,6 × 24,9 mm) permet au modèle de
calibrer l'échelle et de *mesurer* les portions au lieu de les deviner. Les trois dimensions
sont données, pas seulement deux : posée à plat, la pompe est aussi la seule **règle
verticale** de l'image, et la hauteur est justement ce qu'une photo de dessus ne montre pas.

**✍️ Description** — aucune photo : tu écris ce que tu manges. Le modèle interprète les
portions courantes françaises. La marge d'erreur est structurellement plus large, et l'app
le dit au lieu de le masquer.

**🥖 Manuel** — base d'aliments hors ligne, produits emballés via
[OpenFoodFacts](https://world.openfoodfacts.org) (recherche par nom ou scan de code-barres),
repas fréquents enregistrés. Fonctionne sans réseau et sans clé API.

## Comment la précision est obtenue

La difficulté n'est pas de reconnaître l'aliment, c'est d'**estimer la portion**. La méthode
est imposée au modèle comme consigne :

1. **Calibrer l'échelle** sur l'objet-repère, puis mesurer chaque aliment en centimètres.
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

**Le repère doit être réellement trouvé.** Le modèle déclare s'il a effectivement localisé
l'objet-repère. Sinon la marge d'erreur reste large et un bandeau le signale — plutôt
qu'une fausse précision affichée au moment exact où une dose se calcule.

**Contrôle de vraisemblance.** Recoupement arithmétique local de chaque aliment : densité
hors bornes, glucides incohérents avec masse × densité, glucides supérieurs au poids de
l'aliment, total absurde. Aucun appel réseau, aucun coût.

**Vérification croisée, aliment par aliment.** Un second modèle estime le même repas en
parallèle. L'app compare les totaux **et le contenu** : deux modèles peuvent tomber sur
70 g pour des raisons opposées, et annoncer « confirmé » là-dessus serait une fausse
assurance. Elle dit alors précisément *« l'autre modèle voit du pain que le premier ignore »*.

**Inventaire de ce qui a été vu.** Une phrase décrivant l'assiette, chaque aliment avec sa
portion retenue et l'hypothèse faite, l'échelle utilisée. C'est ce qui permet de repérer une
confusion avant de doser.

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
| **Google** (Gemini) | [aistudio.google.com](https://aistudio.google.com/app/apikey) | ~0,002 $ (3.1 Flash-Lite) |
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
le prix de Gemini 3.1 Flash-Lite, qui se trompe de 10,0 g en 4 secondes. Claude Sonnet 5
(14,5 g) est derrière Qwen 3.7 Flash, 79× moins cher. **Aucun écart entre deux modèles
voisins n'est statistiquement significatif** à cette taille d'échantillon — d'où la règle
retenue : à précision indistinguable, le moins cher et le plus rapide. Le défaut Gemini est
donc passé de 3.6 Flash (qui sous-estimait de 30 %) à **3.1 Flash-Lite**.

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

## Suivi de la consommation

Les Réglages affichent le nombre d'appels réellement effectués dans le mois, par modèle, et
le coût approximatif d'après les tarifs publics. Le prix est appliqué à l'affichage et non
enregistré : corriger un tarif ne réécrit pas l'historique.

## Confidentialité

Tout reste sur l'appareil : réglages, historique, photos, aliments personnalisés. Les photos
ne partent que vers le fournisseur d'IA choisi, le temps de l'estimation. Aucun compte,
aucune télémétrie, aucun serveur intermédiaire.

⚠️ L'**export de sauvegarde contient les clés API** en clair, pour qu'une restauration soit
immédiate lors d'un changement d'appareil. Le fichier est nommé
`glucovision-sauvegarde-PRIVEE-<date>.json` : il ne doit pas être partagé.

## Développement

```bash
npm install                       # dépendances Capacitor + esbuild
npx http-server -p 8080           # servir en local ; aucune étape de build pour le web
bash scripts/build-plugins.sh     # après un changement de version de plugin Capacitor
bash scripts/build-www.sh         # prépare www/ pour l'APK
node scripts/render-icons.mjs     # régénère les PNG d'icônes depuis icons/*.svg
```

JavaScript sans dépendance à l'exécution (modules IIFE exposant des globales), aucun
transpileur, aucun framework. L'APK est produit par GitHub Actions (Capacitor 8, Node 22) :
l'APK est publié sous le tag `apk-latest`, le bundle de mise à jour sous `ota-latest`.

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
| `bench/` | banc d'essai hors ligne sur Nutrition5k (voir [BENCHMARK.md](BENCHMARK.md)) |

---

Projet personnel, sans garantie. Ce n'est pas un produit certifié et il ne doit pas être
présenté comme tel.

*Prends soin de toi. En cas de doute sur une dose : glycémie + jugement + équipe soignante.*
