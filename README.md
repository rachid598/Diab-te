# GlucoVision — Estimateur de glucides 🩸

Application web (PWA) qui estime les **glucides d'un repas à partir d'une photo** et les
convertit en **parts de glucides** (1 part = 10 g par défaut) à saisir dans une pompe à
insuline. Pensée pour l'**insulinothérapie fonctionnelle** (diabète de type 1).

> ⚠️ **Avertissement médical.** Cet outil est une **aide à l'estimation**, pas un dispositif
> médical. Toute estimation de glucides à partir d'une photo comporte une marge d'erreur
> (les meilleures méthodes tournent autour de 5 à 15 g d'erreur, ce n'est **pas** infaillible).
> Vérifie toujours le résultat avec ton propre jugement avant de doser, contrôle ta glycémie,
> et ne modifie jamais tes réglages sans ton équipe soignante. Tu restes responsable de la
> dose finale.

---

## Comment ça marche (la méthode)

La précision d'une estimation photo repose surtout sur **l'estimation de la portion/volume**,
pas sur la reconnaissance de l'aliment. L'app applique donc une méthode structurée, envoyée
comme consigne au modèle de vision :

1. **Identifier** chaque composant du repas.
2. **Estimer le volume** de chacun — en s'appuyant sur un **objet-repère de taille connue**
   présent dans la photo (carte bancaire, fourchette, pièce de 2 €, ou diamètre d'assiette),
   et en **croisant plusieurs angles** (vue de dessus + vue de côté).
3. **Convertir le volume en masse** selon la densité et la consistance (riz aéré vs compact,
   friture gorgée d'huile, sauce…).
4. **Appliquer la densité glucidique** (g de glucides pour 100 g) de l'aliment *tel que consommé*.
5. **Sommer** et compter les **glucides cachés** (sauces sucrées, panure, sucre, boissons).

Pour réduire les erreurs, l'app :

- affiche une **fourchette basse–haute** et un **niveau de confiance** (jamais un faux chiffre
  « précis ») ;
- permet de **corriger la portion** de chaque aliment à la main (le total se recalcule) ;
- gère **plusieurs angles** de la même assiette ;
- garde un **historique** pour comparer estimations et réalité et affiner ton œil ;
- propose un **mode manuel hors-ligne** (base d'aliments) qui ne nécessite aucune clé API.

L'app affiche **grammes + parts** ; c'est **ta pompe qui calcule le bolus**. Aucune dose
d'insuline n'est suggérée.

---

## Mise en route

### 1. Obtenir une clé API (pour le mode photo)

Le mode photo utilise un modèle de **vision**. Par défaut : **Claude (Anthropic)**.

- **Claude** : crée une clé sur [console.anthropic.com](https://console.anthropic.com) →
  colle-la dans **Réglages**. Modèle recommandé : `claude-sonnet-5` (bon rapport
  précision/coût) ; `claude-opus-4-8` pour un maximum de précision.
- **OpenAI** (alternative) : crée une clé sur
  [platform.openai.com/api-keys](https://platform.openai.com/api-keys), choisis le fournisseur
  *OpenAI* dans les Réglages, modèle `gpt-4o`.
  > Note : « Codex » est un modèle de *code*, il ne lit pas les images — il faut un modèle de
  > vision comme `gpt-4o`.

La clé est stockée **uniquement sur ton appareil** (localStorage). Les photos ne sont envoyées
qu'au fournisseur d'IA choisi, en appel direct depuis le navigateur — rien ne transite par un
serveur tiers.

### 2. Lancer l'app

La caméra exige un **contexte sécurisé** (HTTPS ou `localhost`).

**En local :**

```bash
# depuis le dossier du projet
python3 -m http.server 8000
# puis ouvre http://localhost:8000  (la caméra marche sur localhost)
```

**Hébergement gratuit (recommandé) — GitHub Pages :**

1. Pousse ce dépôt sur GitHub.
2. *Settings → Pages → Build and deployment → Source: Deploy from a branch*, branche
   `main` (ou ta branche), dossier `/root`.
3. Ouvre l'URL fournie sur ton téléphone → **Ajouter à l'écran d'accueil** pour l'installer
   comme une app.

---

## Utilisation

1. Onglet **📷 Photo** → prends 1 à 4 photos (idéalement dessus + côté), avec un objet-repère.
2. Sélectionne l'objet-repère, ajoute d'éventuelles précisions (« riz ~150 g cuit »).
3. **Estimer les glucides** → l'app affiche parts + grammes + fourchette + détail par aliment.
4. Ajuste une portion si besoin, puis saisis le chiffre dans ta pompe.
5. **✍️ Manuel** : mode hors-ligne sans IA. **🕑 Historique** : tes estimations passées.

---

## Réglages

- **Fournisseur / clé / modèle** de vision.
- **Taille d'une part** : 10 g (France, défaut), 12 g ou 15 g — modifiable.
- **Arrondi des parts** au 0,5 le plus proche.

---

## Confidentialité & sécurité

- Aucune donnée n'est stockée sur un serveur : réglages, historique et clé restent dans le
  navigateur de l'appareil.
- Les appels IA vont **directement** au fournisseur que tu choisis, avec ta propre clé.
- ⚠️ Comme il s'agit d'une app **personnelle** côté navigateur, ta clé API est présente dans la
  page. C'est acceptable pour un usage privé sur ton téléphone. Pour un usage partagé/public,
  il faudrait passer par un petit serveur relais (proxy) qui garde la clé côté serveur.

---

## Migration vers une APK Android (plus tard)

L'app est une PWA 100 % statique, donc simple à empaqueter :

- **Le plus simple — PWABuilder / Bubblewrap (TWA)** : va sur
  [pwabuilder.com](https://www.pwabuilder.com), entre l'URL GitHub Pages, télécharge le paquet
  Android (TWA). Les icônes et le manifeste sont déjà prêts.
- **Plus de contrôle — Capacitor** :
  ```bash
  npm init -y && npm i @capacitor/core @capacitor/cli @capacitor/camera
  npx cap init "GlucoVision" com.example.diabete --web-dir=.
  npx cap add android && npx cap open android
  ```
  Capacitor régénère les icônes natives et permet d'utiliser la caméra native.

---

## Structure du projet

```
index.html            Interface (FR)
css/styles.css         Styles (mobile-first, clair/sombre)
js/storage.js          Réglages + historique (localStorage)
js/foods.js            Base glucidique hors-ligne (mode manuel)
js/estimator.js        Prompt + appels API vision (Claude / OpenAI) + garde-fous
js/camera.js           Capture, compression des photos
js/app.js              Orchestration de l'UI
manifest.webmanifest   Manifeste PWA
service-worker.js      Cache hors-ligne de la coquille
icons/                 Icônes (SVG + PNG 192/512/maskable/180)
```

---

*Prends soin de toi. En cas de doute sur une dose : glycémie + jugement + équipe soignante.*
