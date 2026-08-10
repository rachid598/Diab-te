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
  var aliments = Array.isArray(nomAliment) ? nomAliment : [[nomAliment, total]];
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
    const wrap = document.querySelector('.cmp-tablewrap');
    const table = document.querySelector('.cmp-table');
    const headers = Array.from(document.querySelectorAll('.cmp-th'));
    const labels = Array.from(document.querySelectorAll('.cmp-use')).map(function (b) {
      return b.getAttribute('aria-label');
    });
    return {
      texte: r ? r.textContent : '',
      colonnes: headers.length,
      cartes: document.querySelectorAll('.cmp-card').length,
      aliments: document.querySelectorAll('.cmp-food-list').length,
      scroll: !!wrap && wrap.scrollWidth > wrap.clientWidth + 1,
      tableWidth: table ? Math.round(table.getBoundingClientRect().width) : 0,
      wrapWidth: wrap ? Math.round(wrap.getBoundingClientRect().width) : 0,
      modelWidths: headers.map(function (h) { return Math.round(h.getBoundingClientRect().width); }),
      sticky: getComputedStyle(document.querySelector('.cmp-metric')).position,
      regionLabelled: !!wrap && wrap.getAttribute('role') === 'region' &&
        wrap.getAttribute('aria-labelledby') === 'cmp-title' && wrap.tabIndex === 0,
      caption: !!document.querySelector('.cmp-table caption'),
      buttonLabels: labels
    };
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
  /* Le téléphone peut rester réglé en thème clair : GlucoVision garde
     volontairement son identité sombre et ses contrastes dans ce cas. */
  const ctx = await nav.newContext({ viewport: { width: 390, height: 844 },
                                     colorScheme: 'light', serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const erreursJs = [];
  page.on('pageerror', function (e) { erreursJs.push(e.message); });
  await page.goto('http://localhost:' + PORT + '/');

  const theme = await page.evaluate(function () {
    const body = getComputedStyle(document.body);
    const root = getComputedStyle(document.documentElement);
    const card = getComputedStyle(document.querySelector('.card'));
    return {
      bodyBg: body.backgroundColor,
      bodyText: body.color,
      cardBg: card.backgroundColor,
      scheme: root.colorScheme,
      meta: document.querySelector('meta[name="theme-color"]').content,
      pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  });
  console.log('Thème sombre :');
  verifie(theme.bodyBg === 'rgb(6, 9, 16)' && /dark/.test(theme.scheme),
    'le thème reste sombre même si le téléphone demande le mode clair');
  verifie(theme.bodyText === 'rgb(245, 248, 252)' && theme.meta.toLowerCase() === '#060910',
    'le texte et la barre système utilisent les couleurs du design system');
  verifie(!theme.pageOverflow, 'la page ne déborde pas horizontalement à 390 px');

  await page.click('#open-settings');
  await page.waitForFunction(function () {
    return document.activeElement && document.activeElement.id === 'close-settings';
  });
  let modalState = await page.evaluate(function () {
    const modal = document.getElementById('settings-modal');
    return {
      focus: document.activeElement && document.activeElement.id,
      inert: document.querySelector('main').inert,
      unnamed: Array.from(modal.querySelectorAll('input,select,textarea')).filter(function (el) {
        if (el.hidden || el.closest('[hidden]')) return false;
        return !el.labels || el.labels.length === 0;
      }).map(function (el) { return el.id; })
    };
  });
  verifie(modalState.focus === 'close-settings' && modalState.inert,
    'la modale reçoit le focus et rend l’arrière-plan inerte');
  verifie(modalState.unnamed.length === 0,
    'chaque champ visible des réglages possède un libellé accessible');
  await page.keyboard.press('Shift+Tab');
  verifie(await page.evaluate(function () {
    return document.getElementById('settings-modal').contains(document.activeElement);
  }), 'Tab reste enfermé dans la modale');
  await page.keyboard.press('Escape');
  await page.waitForFunction(function () {
    return document.getElementById('settings-modal').hidden &&
      document.activeElement && document.activeElement.id === 'open-settings';
  });
  verifie(true, 'Échap ferme la modale et rend le focus au bouton Réglages');

  const riz = 'riz blanc';
  const pain = 'pain baguette';

  console.log('Écran de comparaison :');

  let vu = await ecran(page, [avis('gemini', 'gemini-3.1-flash-lite', 48, riz),
                              avis('openrouter', 'x-ai/grok-4.5', 50, pain)]);
  verifie(vu.colonnes === 2, 'deux avis produisent deux colonnes');
  verifie(!/Avis concordants/.test(vu.texte),
    'même total sur des aliments différents n’est PAS annoncé concordant');
  verifie(/aliments|quantités/i.test(vu.texte),
    'et le désaccord de contenu est affiché explicitement');
  verifie(vu.aliments === 2, 'le détail alimentaire des deux avis est visible avant Retenir');
  verifie(vu.cartes === 0, 'la comparaison reste un tableau, jamais des cartes empilées');
  verifie(vu.regionLabelled && vu.caption, 'le tableau est une région accessible et nommée');
  verifie(new Set(vu.buttonLabels).size === 2 && vu.buttonLabels.every(Boolean),
    'chaque bouton Retenir nomme son modèle');

  vu = await ecran(page, [avis('gemini', 'gemini-3.1-flash-lite', 48, riz),
                          avis('openrouter', 'x-ai/grok-4.5', 50, riz)]);
  verifie(/Avis concordants/.test(vu.texte),
    'même total ET mêmes aliments reste concordant');

  vu = await ecran(page, [
    avis('gemini', 'gemini-3.1-flash-lite', 50, [[riz, 40], [pain, 10]]),
    avis('openrouter', 'x-ai/grok-4.5', 52, [[riz, 10], [pain, 42]])
  ]);
  verifie(!/Avis concordants/.test(vu.texte),
    'mêmes noms et même total, mais répartition opposée, ne sont PAS concordants');
  verifie(/calculs différents/i.test(vu.texte),
    'la compensation entre aliments est expliquée');

  vu = await ecran(page, [avis('gemini', 'gemini-3.1-flash-lite', 48, riz),
                          avis('openrouter', 'google/gemini-3.1-flash-lite', 50, riz)]);
  verifie(/même modèle/i.test(vu.texte),
    'deux routes vers le même modèle sont dénoncées');
  verifie(!/Avis concordants/.test(vu.texte),
    'deux routes vers le même modèle ne reçoivent jamais le statut vert');

  vu = await ecran(page, [avis('gemini', 'gemini-3.1-flash-lite', 48, riz),
                          avis('openrouter', 'x-ai/grok-4.5', 50, riz),
                          avis('claude', 'claude-opus-5', 46, riz)]);
  verifie(vu.colonnes === 3, 'un troisième avis ajoute une colonne');
  verifie(vu.scroll, 'à 390 px, les trois colonnes restent lisibles grâce au défilement');
  verifie(Math.min.apply(null, vu.modelWidths) >= 120,
    'aucune colonne modèle n’est comprimée sous 120 px : ' + vu.modelWidths.join('/'));
  verifie(vu.sticky === 'sticky', 'la colonne des mesures reste visible pendant le défilement');
  verifie(!/moyenne\s+\d+/i.test(vu.texte),
    'une divergence ne propose plus de moyenne chiffrée');

  const comparaisonEnAttente = await page.evaluate(function () {
    const h = JSON.parse(localStorage.getItem('diabete.history.v1') || '[]');
    return h.filter(function (e) { return e.choiceRequired === true; })[0] || null;
  });
  verifie(!!comparaisonEnAttente,
    'le brouillon technique indique qu’aucune colonne n’a encore été retenue');
  await page.click('.tab[data-tab="history"]');
  await page.locator('.history-head[data-open="' + comparaisonEnAttente.date + '"]').click();
  verifie(await page.locator('.history-confirm[data-confirm="' + comparaisonEnAttente.date + '"]').count() === 0,
    'l’historique ne permet pas de confirmer arbitrairement le premier avis');
  verifie(/Comparaison non tranchée/.test(await page.textContent('#history-list')),
    'l’historique explique qu’un choix explicite est encore requis');
  await page.click('.tab[data-tab="analyze"]');

  await page.setViewportSize({ width: 320, height: 844 });
  vu = await ecran(page, [avis('gemini', 'gemini-3.1-flash-lite', 48, riz),
                          avis('openrouter', 'x-ai/grok-4.5', 50, riz),
                          avis('claude', 'claude-opus-5', 46, riz)]);
  verifie(vu.scroll && vu.tableWidth > vu.wrapWidth,
    'à 320 px, le tableau défile au lieu d’écraser les colonnes (' +
      vu.tableWidth + ' > ' + vu.wrapWidth + ')');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.cmp-use').nth(1).click();
  await page.waitForSelector('#reopen-compare', { timeout: 5000 });
  verifie(/3 colonnes/.test(await page.textContent('#reopen-compare')),
    'après Retenir, les trois colonnes restent accessibles');
  await page.click('#reopen-compare');
  await page.waitForSelector('.cmp-table');
  verifie(await page.locator('.cmp-th').count() === 3,
    'Revoir restaure bien toutes les colonnes, sans perdre un avis');

  /* Une colonne est une preuve d'origine, pas une vue vivante du résultat
     choisi. Corriger ensuite la portion retenue ne doit donc jamais réécrire
     l'archive ni l'avis conservé dans l'historique. */
  await page.locator('.cmp-use').first().click();
  await page.waitForSelector('.item-grams-edit');
  await page.locator('.item-grams-edit').first().fill('140');
  await page.locator('.item-grams-edit').first().dispatchEvent('change');
  await page.click('#reopen-compare');
  await page.waitForSelector('.cmp-table');
  const totalOriginal = await page.locator('.cmp-row-main .cmp-td').first().textContent();
  verifie(/48/.test(totalOriginal || '') && !/70/.test(totalOriginal || ''),
    'corriger le résultat retenu ne modifie pas sa colonne originale');
  const avisArchive = await page.evaluate(function () {
    const h = JSON.parse(localStorage.getItem('diabete.history.v1') || '[]');
    return h[0] && h[0].opinions && h[0].opinions[0]
      ? h[0].opinions[0].totalCarbsG : null;
  });
  verifie(avisArchive === 48,
    'l’historique garde lui aussi la valeur originale de la colonne (48 g)');

  /* Reprendre un autre brouillon est un changement de repas. Les colonnes du
     précédent ne doivent jamais suivre et permettre de remplacer le nouveau
     repas par un ancien avis. */
  const dateBrouillonB = await page.evaluate(function () {
    const h = JSON.parse(localStorage.getItem('diabete.history.v1') || '[]');
    const date = Date.now() + 1000;
    h.unshift({
      date: date, source: 'texte', draft: true, confirmed: false,
      totalCarbsG: 30, parts: 3, provider: 'gemini', model: 'gemini-3.1-flash-lite',
      seen: 'Brouillon B, soupe de lentilles',
      items: [{ name: 'lentilles', carbsG: 30, portion: 'une assiette' }],
      input: { notes: 'soupe de lentilles', extras: '', imageCount: 0 },
      resultSnapshot: {
        totalCarbsG: 30, rangeLowG: 22, rangeHighG: 38,
        overallConfidence: 'medium', model: 'gemini-3.1-flash-lite',
        seen: 'Brouillon B, soupe de lentilles', fromText: true,
        items: [{ name: 'lentilles', carbsG: 30, estimatedMassG: 150,
                  carbDensityPer100g: 20, confidence: 'medium' }]
      }
    });
    localStorage.setItem('diabete.history.v1', JSON.stringify(h));
    return date;
  });
  await page.goto('http://localhost:' + PORT + '/');
  /* Attente que showVersion() ait tourné, donc que l'initialisation soit finie.
     Le numéro n'est PAS écrit en dur : il l'était (« Version 80 »), et le test
     tombait alors à chaque montée de version pour une raison sans rapport avec
     ce qu'il vérifie. Ce qui fait office de signal, c'est qu'un numéro ait
     remplacé le « Version… » du HTML statique. */
  await page.waitForFunction(function () {
    const v = document.getElementById('app-version');
    return v && /Version\s+\d+/.test(v.textContent || '');
  }, null, { timeout: 5000 });
  await page.click('.tab[data-tab="history"]');
  await page.locator('.history-head[data-open="' + dateBrouillonB + '"]').click();
  await page.waitForSelector('.history-resume[data-resume="' + dateBrouillonB + '"]');
  await page.locator('.history-resume[data-resume="' + dateBrouillonB + '"]').click();
  await page.waitForSelector('#confirm-result');
  verifie(await page.locator('#reopen-compare').count() === 0,
    'reprendre le brouillon B ne montre aucune colonne du repas A');
  verifie(/30/.test(await page.textContent('.hero-carbs')) &&
      /Brouillon B/.test(await page.textContent('#results')),
    'la reprise conserve bien le chiffre et le contenu du brouillon B');

  /* Confirmer un choix n'autorise pas les choix futurs à hériter de cette
     confirmation. Une autre colonne signifie un autre chiffre à revérifier. */
  vu = await ecran(page, [avis('gemini', 'gemini-3.1-flash-lite', 48, riz),
                          avis('openrouter', 'x-ai/grok-4.5', 50, riz),
                          avis('claude', 'claude-opus-5', 46, riz)]);
  await page.locator('.cmp-use').first().click();
  if (await page.locator('#dominant-ok').count()) await page.click('#dominant-ok');
  await page.click('#confirm-result');
  verifie(await page.locator('#confirm-result').isDisabled(),
    'le premier choix peut être confirmé');
  await page.click('#reopen-compare');
  await page.locator('.cmp-use').nth(1).click();
  verifie(!(await page.locator('#confirm-result').isDisabled()) &&
      /Confirmer ce repas/.test(await page.textContent('#confirm-result')),
    'retenir une autre colonne redemande explicitement une confirmation');
  const nouvelEtat = await page.evaluate(function () {
    const h = JSON.parse(localStorage.getItem('diabete.history.v1') || '[]');
    return h[0] || null;
  });
  verifie(!!nouvelEtat && nouvelEtat.totalCarbsG === 50 &&
      nouvelEtat.draft === true && nouvelEtat.confirmed === false &&
      nouvelEtat.choiceRequired === false,
    'le nouveau choix est sauvegardé comme brouillon non confirmé');

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

  /* Lieu du repas. La logique est testée dans tests/contexte-repas.test.js ;
     ce qui ne peut se vérifier qu'ici, c'est que la puce est branchée, qu'elle
     survit à un rechargement, et qu'un second appui la désélectionne. */
  console.log('\nLieu du repas :');
  await page.goto('http://localhost:' + PORT + '/');
  await page.waitForSelector('.venue-chip', { timeout: 5000 });
  verifie(await page.evaluate(function () {
    return document.querySelectorAll('.venue-chip.on').length === 0;
  }), 'au départ, aucun lieu n’est affirmé');

  await page.click('.venue-chip[data-venue="restaurant"]');
  verifie(await page.evaluate(function () {
    var c = document.querySelector('.venue-chip[data-venue="restaurant"]');
    return c.classList.contains('on') && c.getAttribute('aria-pressed') === 'true';
  }), 'un appui sélectionne le lieu, y compris pour un lecteur d’écran');

  await page.goto('http://localhost:' + PORT + '/');
  await page.waitForSelector('.venue-chip', { timeout: 5000 });
  verifie(await page.evaluate(function () {
    return document.querySelector('.venue-chip[data-venue="restaurant"]').classList.contains('on');
  }), 'le choix survit au rechargement');

  await page.click('.venue-chip[data-venue="restaurant"]');
  verifie(await page.evaluate(function () {
    return document.querySelectorAll('.venue-chip.on').length === 0;
  }), 'un second appui revient à « je ne dis rien »');

  await page.click('.venue-chip[data-venue="maison"]');
  await page.click('.venue-chip[data-venue="cantine"]');
  verifie(await page.evaluate(function () {
    var on = document.querySelectorAll('.venue-chip.on');
    return on.length === 1 && on[0].getAttribute('data-venue') === 'cantine';
  }), 'un seul lieu à la fois');

  verifie(erreursJs.length === 0, 'aucune erreur JavaScript : ' + (erreursJs[0] || '—'));

  await nav.close();
  srv.close();
  console.log(echecs ? '\nÉCHEC : ' + echecs + ' vérification(s)' : '\nToutes les vérifications passent.');
  process.exit(echecs ? 1 : 0);
})().catch(function (e) {
  console.error('Test navigateur interrompu :', e.message);
  process.exit(1);
});
