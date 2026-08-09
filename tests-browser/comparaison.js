'use strict';

/* Test navigateur de l'écran de comparaison.

   Pourquoi un navigateur et pas node --test : cet écran est produit par
   renderCompare, dans app.js, qui écrit du HTML et lit le DOM. C'est
   exactement la partie que la suite existante ne charge jamais — 4 000 lignes
   où vivent la plupart des défauts relevés à l'audit.

   Le point d'entrée est la reprise de session (diabete.encours.v1) : on écrit
   deux avis dans le stockage, on charge la page, et l'application reconstruit
   l'écran elle-même. On teste donc le vrai rendu, pas une imitation. */

const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8137;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json'
};

let echecs = 0;
function verifie(condition, message) {
  if (condition) { console.log('  ok   ' + message); return; }
  console.log('  ÉCHEC ' + message);
  echecs++;
}

/* Le total DOIT valoir la somme des aliments : l'application refuse un avis
   dont le total brut ne correspond pas à son détail, et elle a raison de le
   faire. Un jeu d'essai incohérent ne testerait que ce refus. */
function avis(provider, model, total, nomAliment) {
  var aliments = [[nomAliment, total]];
  return {
    ok: true, provider: provider,
    result: {
      totalCarbsG: total, rangeLowG: total - 8, rangeHighG: total + 8,
      overallConfidence: 'medium', model: model, seen: 'Une assiette.',
      items: aliments.map(function (a) {
        return { name: a[0], carbsG: a[1], estimatedMassG: a[1] * 2,
                 carbDensityPer100g: 50, confidence: 'medium' };
      })
    }
  };
}

function serveur() {
  return http.createServer(function (q, r) {
    const rel = decodeURIComponent(q.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const f = path.join(ROOT, rel);
    if (!f.startsWith(ROOT)) { r.writeHead(403); return r.end(); }
    fs.readFile(f, function (e, d) {
      if (e) { r.writeHead(404); return r.end(); }
      r.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'text/plain' });
      r.end(d);
    });
  });
}

async function ecran(page, liste) {
  await page.waitForLoadState('load');
  await page.evaluate(function (a) {
    localStorage.setItem('diabete.encours.v1',
      JSON.stringify({ ts: Date.now(), date: Date.now(), avis: a }));
  }, liste);
  await page.goto('http://localhost:' + PORT + '/');
  await page.waitForSelector('.cmp-table', { timeout: 5000 });
  return page.evaluate(function () {
    const r = document.getElementById('results');
    return { texte: r ? r.textContent : '', colonnes: document.querySelectorAll('.cmp-th').length };
  });
}

(async function () {
  const srv = serveur();
  await new Promise(function (res) { srv.listen(PORT, res); });
  /* PW_CHROMIUM : chemin d'un Chromium déjà présent sur la machine. Sert au
     développement local, où la version de Playwright peut ne pas correspondre
     aux navigateurs installés. En CI la variable est absente et Playwright
     utilise le navigateur qu'il a téléchargé lui-même. */
  const nav = await chromium.launch(
    process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  /* serviceWorkers bloqués : au premier contrôle de la page, le worker déclenche
     un rechargement unique (registerSW). Ce rechargement arrivait au milieu d'un
     page.evaluate et faisait échouer le test une fois sur deux, sans rapport
     avec ce qu'il vérifie. Le worker n'est pas le sujet ici. */
  const ctx = await nav.newContext({ viewport: { width: 390, height: 844 },
                                     serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const erreursJs = [];
  page.on('pageerror', function (e) { erreursJs.push(e.message); });
  await page.goto('http://localhost:' + PORT + '/');

  const riz = 'riz blanc';
  const pain = 'pain baguette';

  console.log('Écran de comparaison :');

  let vu = await ecran(page, [avis('gemini', 'gemini-3.1-flash-lite', 48, riz),
                              avis('openrouter', 'x-ai/grok-4.5', 50, pain)]);
  verifie(vu.colonnes === 2, 'deux avis produisent deux colonnes');
  verifie(!/Avis concordants/.test(vu.texte),
    'même total sur des aliments différents n’est PAS annoncé concordant');
  verifie(/aliments différents/i.test(vu.texte),
    'et le désaccord de contenu est affiché explicitement');

  vu = await ecran(page, [avis('gemini', 'gemini-3.1-flash-lite', 48, riz),
                          avis('openrouter', 'x-ai/grok-4.5', 50, riz)]);
  verifie(/Avis concordants/.test(vu.texte),
    'même total ET mêmes aliments reste concordant');

  vu = await ecran(page, [avis('gemini', 'gemini-3.1-flash-lite', 48, riz),
                          avis('openrouter', 'google/gemini-3.1-flash-lite', 50, riz)]);
  verifie(/même modèle/i.test(vu.texte),
    'deux routes vers le même modèle sont dénoncées');

  vu = await ecran(page, [avis('gemini', 'gemini-3.1-flash-lite', 48, riz),
                          avis('openrouter', 'x-ai/grok-4.5', 50, riz),
                          avis('claude', 'claude-opus-5', 46, riz)]);
  verifie(vu.colonnes === 3, 'un troisième avis ajoute une colonne');

  /* Lien APK : on ne peut pas atteindre depuis un navigateur les branches
     « à jour / plus récent » (elles dépendent du build natif installé), mais on
     peut vérifier ce qui casse en silence — un href jamais rempli, un sélecteur
     renommé, une exception dans le clic. */
  console.log('\nTéléchargement de l’APK :');
  await page.route('**/apk-codex/apk.json', function (route) {
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ appId: 'io.github.rachid598.glucovision', appVersion: 99,
                             versionCode: 2099, versionName: '1.99.0', sha256: 'abcdef0123456789' })
    });
  });
  await page.goto('http://localhost:' + PORT + '/');
  await page.waitForSelector('#apk-link', { state: 'attached', timeout: 5000 });
  const href = await page.getAttribute('#apk-link', 'href');
  verifie(/releases\/download\/apk-codex\/glucovision\.apk$/.test(href || ''),
    'le lien de téléchargement pointe vers l’APK du canal : ' + href);

  /* Clic programmé : le bloc vit dans la modale de réglages, repliée au
     chargement. On teste le gestionnaire, pas le chemin de navigation. */
  await page.evaluate(function () { document.getElementById('check-apk').click(); });
  await page.waitForFunction(function () {
    const el = document.getElementById('apk-status');
    return el && !el.hidden && !/Lecture de la version/.test(el.textContent);
  }, null, { timeout: 5000 });
  const etat = await page.textContent('#apk-status');
  verifie(/1\.99\.0/.test(etat), 'la version publiée est lue et affichée : ' + etat.slice(0, 80));
  verifie(/abcdef012345/.test(etat), 'l’empreinte SHA-256 est montrée pour vérification');

  /* Calcul de portion. Le chiffre produit ici finit dans une pompe à insuline :
     il ne suffit pas que l'arithmétique soit juste dans portion.js, il faut que
     ce soit bien elle qui soit branchée aux champs et au bouton. */
  console.log('\nCalcul de portion :');
  await page.route('**/world.openfoodfacts.org/**', function (route) {
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        products: [{
          code: '7622210449283', product_name_fr: 'Biscuits test', brands: 'Marque',
          quantity: '500 g e', product_quantity: 500, product_quantity_unit: 'g',
          nutriments: { carbohydrates_100g: 70 }
        }]
      })
    });
  });
  await page.goto('http://localhost:' + PORT + '/');
  await page.click('.tab[data-tab="manual"]');
  await page.click('.mode-btn[data-mode="produit"]');
  await page.fill('#off-search', 'biscuits');
  await page.click('#off-search-btn');
  await page.waitForSelector('.off-item', { timeout: 5000 });
  await page.click('.off-item .food-label');
  await page.waitForSelector('#portion-card:not([hidden])', { timeout: 5000 });

  const poids = await page.inputValue('#portion-total');
  verifie(poids === '500', 'le poids du paquet est prérempli depuis la base : ' + poids);
  verifie(await page.isDisabled('#portion-add'),
    'sans nombre d’unités, on ne peut rien ajouter');

  await page.fill('#portion-units', '12');
  await page.fill('#portion-label', 'biscuits');
  await page.fill('#portion-eat', '2');
  const calcul = await page.textContent('#portion-result');
  /* 500/12 = 41,666… g par biscuit ; 2 biscuits = 83,3 g ; à 70 g/100 g → 58 g.
     L'affichage arrondit au dixième comme partout ailleurs dans l'app, mais le
     calcul, lui, garde la valeur exacte — d'où 58 et non 59. */
  verifie(/41,7 g/.test(calcul), 'le poids d’une unité est calculé : ' + calcul.replace(/\s+/g, ' '));
  verifie(/58 g de glucides/.test(calcul), 'et les glucides des 2 unités aussi');
  verifie(/1 biscuit =/.test(calcul) && /2 biscuits =/.test(calcul),
    'le singulier et le pluriel sont corrects');

  await page.click('#portion-add');
  await page.waitForSelector('.manual-row', { timeout: 5000 });
  const ligne = await page.textContent('.manual-row');
  verifie(/58 g/.test(ligne), 'la ligne du repas porte les mêmes glucides : ' + ligne.replace(/\s+/g, ' '));
  verifie(await page.isHidden('#portion-card'), 'la carte se referme après ajout');

  // Le second scan du même produit doit déjà connaître le nombre d'unités.
  await page.click('.off-item .food-label');
  await page.waitForSelector('#portion-card:not([hidden])', { timeout: 5000 });
  const memoire = await page.inputValue('#portion-units');
  verifie(memoire === '12', 'le nombre d’unités est retenu pour ce code-barres : ' + memoire);

  /* Code-barres inconnu. Jusqu'ici c'était un cul-de-sac : « introuvable », et
     débrouille-toi. Le produit recopié une fois doit être reconnu ensuite. */
  console.log('\nCode-barres inconnu :');
  await page.unroute('**/world.openfoodfacts.org/**');
  await page.route('**/api/v2/product/**', function (route) {
    return route.fulfill({ status: 404, contentType: 'application/json',
                           body: JSON.stringify({ status: 0 }) });
  });
  await page.goto('http://localhost:' + PORT + '/');
  await page.click('.tab[data-tab="manual"]');
  await page.click('.mode-btn[data-mode="produit"]');
  await page.click('#barcode-btn');
  await page.fill('#barcode-manual', '9999999999999');
  await page.click('#barcode-manual-go');
  await page.waitForSelector('#barcode-unknown:not([hidden])', { timeout: 5000 });
  verifie(true, 'un code absent d’OpenFoodFacts propose la saisie de l’étiquette');

  await page.fill('#bu-name', 'Gâteau de mamie');
  await page.fill('#bu-carb', '60');
  await page.fill('#bu-pack', '400');
  await page.click('#bu-save');
  await page.waitForSelector('#portion-card:not([hidden])', { timeout: 5000 });
  const saisi = await page.textContent('#portion-name');
  verifie(/Gâteau de mamie/.test(saisi), 'le produit saisi ouvre le calcul de portion : ' + saisi);
  verifie(await page.inputValue('#portion-total') === '400',
    'le poids du paquet saisi est repris');

  // Second scan du même code : plus aucune question, alors que le réseau dit toujours 404.
  await page.click('#barcode-btn');
  await page.fill('#barcode-manual', '9999999999999');
  await page.click('#barcode-manual-go');
  await page.waitForSelector('#portion-card:not([hidden])', { timeout: 5000 });
  verifie(await page.isHidden('#barcode-unknown'),
    'au second scan, le produit est reconnu sans rien redemander');
  verifie(/Gâteau de mamie/.test(await page.textContent('#portion-name')),
    'et c’est bien le produit enregistré');

  verifie(erreursJs.length === 0, 'aucune erreur JavaScript : ' + (erreursJs[0] || '—'));

  await nav.close();
  srv.close();
  console.log(echecs ? '\nÉCHEC : ' + echecs + ' vérification(s)' : '\nToutes les vérifications passent.');
  process.exit(echecs ? 1 : 0);
})().catch(function (e) {
  console.error('Test navigateur interrompu :', e.message);
  process.exit(1);
});
