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

function mesureCarte(viewIndex, width) {
  const shared = {
    cardRequested: true, cardVerified: true, cardFresh: true,
    cardSchema: 'glucovision-card-v2', cardName: 'glucovision-card-v2',
    scaleSource: 'card', cardTrackingMethod: 'FULL_TRACKING', cardObservations: 4,
    cardWidthCm: 8.56, cardHeightCm: 5.398
  };
  return {
    viewIndex: viewIndex,
    depth: Object.assign({
      scaleOk: true, fresh: true, cardMode: true,
      fieldWidthCm: width, fieldHeightCm: 20,
      distanceCm: 62, cmPerPixel: 0.02
    }, shared),
    reference: Object.assign({ mode: 'glucovision-card-v2' }, shared)
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

async function ecran(page, liste, contexte) {
  await page.waitForLoadState('load');
  await page.evaluate(function (payload) {
    localStorage.setItem('diabete.encours.v1',
      JSON.stringify({ ts: Date.now(), date: Date.now(), avis: payload.avis,
                       ctx: payload.ctx || {} }));
  }, { avis: liste, ctx: contexte || {} });
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
  await new Promise(function (res) { srv.listen(PORT, '127.0.0.1', res); });
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

  /* Parcours Carte GlucoVision avec un pont Android déterministe. On remplace
     uniquement native.js sur cette page isolée : tout le DOM et app.js restent
     ceux réellement publiés.

     Le build simulé est volontairement énorme plutôt qu'un numéro de version
     réel : un chiffre comme 2084 se fige au moment de l'écriture du test et
     retombe SOUS le plancher dès que MIN_NATIVE_BUILD est relevé — c'est
     exactement ce qui a fait échouer ce test au moment de faire remonter le
     plancher pour la nouvelle carte. Un grand nombre reste valide quelle que
     soit la prochaine version. */
  console.log('\nCarte GlucoVision :');
  const BUILD_SIMULE = 999999999;
  const cardPage = await ctx.newPage();
  await cardPage.route('**/js/native.js*', function (route) {
    return route.fulfill({ status: 200, contentType: 'text/javascript', body: `
      (function () {
        window.__depthCaptureRequests = [];
        window.__depthCaptureCount = 0;
        window.__shareFileCalls = [];
        // Contrôlable depuis le test : simule l'échec de la feuille de partage
        // Android, pour vérifier le repli vers Documents.
        window.__shareFileShouldFail = false;
        window.__saveToDocumentsShouldFail = false;
        window.__saveToDocumentsCalls = [];
        window.__downloadAnchorClicks = 0;
        document.addEventListener('click', function (event) {
          var target = event.target && event.target.closest && event.target.closest('a[download]');
          if (target) window.__downloadAnchorClicks += 1;
        }, true);
        function jpeg() {
          var c = document.createElement('canvas'); c.width = 640; c.height = 480;
          var x = c.getContext('2d'); x.fillStyle = '#7a5635'; x.fillRect(0, 0, 640, 480);
          return c.toDataURL('image/jpeg', 0.82).split(',')[1];
        }
        function capture(options) {
          window.__depthCaptureRequests.push(options);
          window.__depthCaptureCount += 1;
          var n = window.__depthCaptureCount;
          var depth = {
            jpegBase64: jpeg(), scaleOk: true, fresh: true,
            fieldWidthCm: n === 1 ? 30 : 27, fieldHeightCm: 20,
            distanceCm: 62, cmPerPixel: n === 1 ? 0.02 : 0.018,
            cardRequested: true, cardVerified: true, cardFresh: true,
            cardSchema: 'glucovision-card-v2', cardName: 'glucovision-card-v2',
            scaleSource: 'card', cardTrackingMethod: 'FULL_TRACKING',
            cardObservations: 4, cardWidthCm: 8.56, cardHeightCm: 5.398,
            observations: 4, parallaxCm: 20
          };
          if (window.__depthIncomplete) {
            delete depth.cardObservations; delete depth.cardTrackingMethod;
            delete depth.cardWidthCm; delete depth.cardHeightCm;
          }
          return Promise.resolve({
            urls: ['data:image/jpeg;base64,' + depth.jpegBase64],
            depth: Object.assign({ cardMode: options && options.cardMode === true }, depth)
          });
        }
        window.Native = {
          isApp: true, platform: 'android',
          ready: function () { return Promise.resolve(true); },
          markReady: function () { return Promise.resolve(true); },
          appBuild: function () { return Promise.resolve(${BUILD_SIMULE}); },
          writeStartupReport: function () { return Promise.resolve('ok'); },
          selfCheck: function () { return {}; }, selfCheckLine: function () { return 'ok'; },
          onResume: function () {}, onLaunchAction: function () {},
          camera: { capture: function () { return Promise.resolve([]); },
                    pickMany: function () { return Promise.resolve([]); } },
          depth: { available: function () { return Promise.resolve({ supported: true, installed: true }); },
                   capture: capture },
          secure: { load: function () { return Promise.resolve({}); },
                    save: function () { return Promise.resolve(true); } },
          photos: { src: function () { return ''; }, save: function () { return Promise.resolve(null); },
                    remove: function () { return Promise.resolve(true); },
                    prune: function () { return Promise.resolve(0); },
                    size: function () { return Promise.resolve(0); } },
          notify: { permission: function () { return Promise.resolve(false); },
                    schedule: function () { return Promise.resolve(false); },
                    cancel: function () { return Promise.resolve(false); } },
          update: { check: function () { return Promise.resolve({ kind: 'current' }); },
                    download: function () { return Promise.resolve(null); },
                    apply: function () { return Promise.resolve(false); } },
          httpJson: function () { return Promise.reject(new Error('offline test')); },
          saveToDocuments: function (name) {
            window.__saveToDocumentsCalls.push(name);
            if (window.__saveToDocumentsShouldFail) return Promise.resolve(null);
            return Promise.resolve({ uri: '/documents/' + name, directory: 'DOCUMENTS' });
          },
          shareFile: function (name, content, title) {
            window.__shareFileCalls.push({ name: name, content: content, title: title });
            if (window.__shareFileShouldFail) return Promise.resolve({ ok: false, error: 'test' });
            return Promise.resolve({ ok: true });
          }
        };
      })();
    ` });
  });
  await cardPage.goto('http://localhost:' + PORT + '/');
  // BUILD_SIMULE passé en argument : waitForFunction s'exécute côté page,
  // sans accès à la portée Node où la constante est déclarée.
  await cardPage.waitForFunction(function (build) {
    return document.getElementById('app-version').textContent.indexOf('APK ' + build) !== -1;
  }, BUILD_SIMULE);
  await cardPage.click('#reference-card > summary');
  await cardPage.selectOption('#reference-mode', 'glucovision-card-v2');
  await cardPage.waitForSelector('#btn-depth:not([hidden])');
  verifie(await cardPage.isVisible('#glucovision-card-guide'),
    'sélectionner Carte révèle la checklist guidée');
  verifie(/BÊTA TERRAIN/.test(await cardPage.locator('#glucovision-card-guide').innerText()),
    'la carte v2 reste explicitement marquée bêta jusqu’au test sur téléphone');
  verifie(await cardPage.locator('a[href="https://policies.google.com/privacy"]').count() === 1,
    'la divulgation ARCore renvoie vers la confidentialité de Google');

  /* Ancien bouton : <a href download>. Dans l'APK, cette ancre écrivait dans un
     dossier interne à la WebView qu'aucun gestionnaire de fichiers ne montre —
     le fichier existait, mais restait introuvable. On vérifie ici le
     remplacement : la feuille de partage native est réellement invoquée, avec
     le contenu SVG réel (pas un texte de substitution), pas une simple ancre.

     Le pré-chargement du SVG est asynchrone et n'expose aucun signal externe
     (aucun hook de test dans le code de production) : si le premier clic tombe
     avant qu'il n'aboutisse, le bouton avertit poliment « pas encore prête » —
     ce cas est lui-même couvert en retentant après une courte pause. */
  await cardPage.click('#reference-download');
  const pasEncorePret = await cardPage.evaluate(function () {
    var t = document.getElementById('toast');
    return !t.hidden && /pas encore fini de charger/i.test(t.textContent || '');
  });
  if (pasEncorePret) {
    verifie(true, 'un clic avant la fin du pré-chargement prévient plutôt que d’échouer');
    await cardPage.waitForTimeout(300);
    await cardPage.click('#reference-download');
  }
  await cardPage.waitForFunction(function () {
    return window.__shareFileCalls.length === 1;
  }, null, { timeout: 5000 });
  const partage = await cardPage.evaluate(function () { return window.__shareFileCalls[0]; });
  verifie(partage.name === 'glucovision-card-v2.svg', 'le fichier partagé porte le nom v2');
  verifie(/<svg[\s\S]*viewBox=/.test(partage.content || ''),
    'le contenu partagé est le vrai SVG de la carte, pas un texte de substitution');
  verifie(/carte repère[\s\S]*v2/i.test(partage.title || ''),
    'le titre du partage identifie sans ambiguïté la carte v2');

  // Repli : la feuille de partage échoue (courant sur certains téléphones sans
  // application compatible) → écriture dans Documents → message qui dit où.
  await cardPage.evaluate(function () { window.__shareFileShouldFail = true; });
  await cardPage.click('#reference-download');
  await cardPage.waitForFunction(function () {
    var t = document.getElementById('toast');
    return !t.hidden && /documents/i.test(t.textContent || '');
  }, null, { timeout: 5000 });
  verifie(true, 'le repli Documents est proposé quand le partage échoue, avec le chemin utilisé');

  // Si aucun stockage public n'est accessible, l'APK doit annoncer l'échec.
  // Une ancre <a download> dans la WebView serait un faux succès vers un
  // emplacement invisible et ne doit surtout pas être invoquée.
  await cardPage.evaluate(function () { window.__saveToDocumentsShouldFail = true; });
  await cardPage.click('#reference-download');
  await cardPage.waitForFunction(function () {
    var t = document.getElementById('toast');
    return !t.hidden && /impossible[\s\S]*aucun fichier/i.test(t.textContent || '');
  }, null, { timeout: 5000 });
  const echecPublic = await cardPage.evaluate(function () {
    return {
      documentsCalls: window.__saveToDocumentsCalls.length,
      anchorClicks: window.__downloadAnchorClicks
    };
  });
  verifie(echecPublic.documentsCalls === 2 && echecPublic.anchorClicks === 0,
    'l’échec du stockage public est explicite, sans téléchargement WebView silencieux');
  await cardPage.evaluate(function () {
    window.__shareFileShouldFail = false;
    window.__saveToDocumentsShouldFail = false;
  });
  await cardPage.click('#btn-depth');
  await cardPage.waitForFunction(function () { return document.querySelectorAll('#thumbs .thumb').length === 1; });
  await cardPage.click('#btn-depth');
  await cardPage.waitForFunction(function () { return document.querySelectorAll('#thumbs .thumb').length === 2; });
  const cardCapture = await cardPage.evaluate(function () {
    return {
      requests: window.__depthCaptureRequests,
      result: document.getElementById('depth-result').textContent
    };
  });
  verifie(cardCapture.requests.length === 2 &&
      cardCapture.requests.every(function (r) { return r && r.cardMode === true; }),
    'chaque Photo mesurée appelle le natif avec {cardMode:true}');
  verifie(/2 vues mesurées/.test(cardCapture.result),
    'deux captures distinctes restent deux métadonnées par vue');
  await cardPage.selectOption('#reference-mode', 'none');
  verifie(await cardPage.isHidden('#btn-depth') && await cardPage.isHidden('#depth-result'),
    'revenir au mode rapide masque l’action et ignore les anciennes mesures');

  await cardPage.click('#clear-photos');
  await cardPage.selectOption('#reference-mode', 'glucovision-card-v2');
  await cardPage.evaluate(function () { window.__depthIncomplete = true; });
  await cardPage.click('#btn-depth');
  await cardPage.waitForSelector('#depth-result.d-warn:not([hidden])');
  const incompleteDepth = await cardPage.textContent('#depth-result');
  verifie(!/échelle ARCore vérifiées/i.test(incompleteDepth || '') &&
      /Aucune mesure utilisée/i.test(incompleteDepth || ''),
    'une réponse native incomplète n’est jamais présentée comme vérifiée');
  await cardPage.close();

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

  /* Cas réel relevé sur un plateau de restaurant : 127 g contre 196 g, soit
     ~7 unités d'insuline d'écart. Dire « 69 g de différence » n'aide personne ;
     nommer le poste qui les porte se vérifie en regardant la corbeille. */
  console.log('\nD\'où vient l\'écart entre deux avis :');
  const restauGemini = avis('gemini', 'gemini-3.1-flash-lite', 127,
    [['Riz blanc cuit', 42], ['Frites avec sauce', 45],
     ['Poisson frit', 15], ['Oignons frits', 25]]);
  const restauGrok = avis('openrouter', 'x-ai/grok-4.5', 196,
    [['Riz blanc long grain cuit', 56], ['frites nature', 95],
     ['Poisson frit', 20], ['Oignons frits', 25]]);
  vu = await ecran(page, [restauGemini, restauGrok]);
  const ecartTexte = await page.textContent('.cmp-gap');
  verifie(/Les avis divergent nettement/.test(vu.texte),
    'la divergence est toujours annoncée');
  verifie(/frites/i.test(ecartTexte),
    'le poste qui porte l’écart est nommé');
  const premier = await page.textContent('.cmp-gap li:first-child');
  verifie(/frites/i.test(premier) && /50 g/.test(premier),
    'et il arrive en tête, chiffré : ' + premier.replace(/\s+/g, ' ').trim());
  verifie(/Riz blanc/i.test(ecartTexte),
    'les libellés « Riz blanc cuit » et « Riz blanc long grain cuit » sont regroupés');
  verifie(!/Oignons/i.test(ecartTexte),
    'un aliment sur lequel les deux avis s’accordent n’encombre pas la liste');

  /* Ne pas voir un aliment est une divergence, pas une donnée manquante :
     la colonne qui l'ignore compte 0 g, et on dit laquelle. */
  const sansFrites = avis('claude', 'claude-opus-5', 82,
    [['Riz blanc cuit', 47], ['Poisson frit', 35]]);
  await ecran(page, [restauGemini, restauGrok, sansFrites]);
  const trois = await page.textContent('.cmp-gap');
  verifie(/non compté par/i.test(trois),
    'un aliment absent d’une colonne est signalé comme non compté');
  verifie(/Opus 5/.test(trois),
    'et la colonne qui l’ignore est nommée : ' + trois.replace(/\s+/g, ' ').trim().slice(0, 120));

  /* Hors-domaine : le banc ne couvre que 20–130 g. Le calcul est vérifié côté
     node ; ici on vérifie que l'écran le dit, une seule fois pour le repas. */
  console.log('\nRepas hors du domaine mesuré :');
  const grosRepas = avis('openrouter', 'x-ai/grok-4.5', 196,
    [['riz', 100], ['frites', 96]]);
  grosRepas.result.outOfDomain = ['196 g de glucides (banc mesuré jusqu\'à 130 g)'];
  const petitRepas = avis('gemini', 'gemini-3.1-flash-lite', 48, riz);
  petitRepas.result.outOfDomain = [];
  vu = await ecran(page, [petitRepas, grosRepas]);
  verifie(/hors du domaine mesuré/i.test(vu.texte),
    'le repas hors domaine est signalé sur l’écran de comparaison');
  verifie(/banc mesuré jusqu.à 130 g/i.test(vu.texte),
    'et la raison chiffrée est donnée');
  verifie(await page.locator('#results .warn-box').filter({ hasText: 'hors du domaine' }).count() === 1,
    'une seule fois pour le repas, pas une par colonne');

  vu = await ecran(page, [avis('gemini', 'gemini-3.1-flash-lite', 48, riz),
                          avis('openrouter', 'x-ai/grok-4.5', 50, riz)]);
  verifie(!/hors du domaine/i.test(vu.texte),
    'une assiette ordinaire ne déclenche aucun bandeau hors domaine');

  const mealAtConserve = 1786406400000;
  await ecran(page, [avis('gemini', 'gemini-3.1-flash-lite', 48, riz),
                      avis('openrouter', 'x-ai/grok-4.5', 50, riz)], {
    notes: 'contexte persistant unique', imageCount: 0,
    mealAt: mealAtConserve, venue: 'restaurant', clarificationAnswered: true
  });
  const contexteSauve = await page.evaluate(function () {
    const h = JSON.parse(localStorage.getItem('diabete.history.v1') || '[]');
    const e = h.filter(function (x) {
      return x.input && x.input.notes === 'contexte persistant unique';
    })[0];
    return e ? {
      venue: e.venue, mealAt: e.input.mealAt, inputVenue: e.input.venue,
      clarificationAnswered: e.input.clarificationAnswered
    } : null;
  });
  verifie(!!contexteSauve && contexteSauve.venue === 'restaurant' &&
      contexteSauve.inputVenue === 'restaurant' && contexteSauve.mealAt === mealAtConserve &&
      contexteSauve.clarificationAnswered === true,
    'heure, lieu et clarification survivent à une comparaison restaurée et à son brouillon');

  await ecran(page, [avis('gemini', 'gemini-3.1-flash-lite', 48, riz),
                      avis('openrouter', 'x-ai/grok-4.5', 50, riz)], {
    notes: 'contrat carte multi-vues', imageCount: 2,
    referenceMode: 'glucovision-card-v2',
    viewMeasurements: [mesureCarte(1, 30), mesureCarte(2, 27)]
  });
  const carteSauvee = await page.evaluate(function () {
    const h = JSON.parse(localStorage.getItem('diabete.history.v1') || '[]');
    const e = h.filter(function (x) {
      return x.input && x.input.notes === 'contrat carte multi-vues';
    })[0];
    return e && e.input ? e.input : null;
  });
  verifie(!!carteSauvee && carteSauvee.referenceMode === 'glucovision-card-v2' &&
      carteSauvee.viewMeasurements.length === 2 &&
      carteSauvee.viewMeasurements[0].viewIndex === 1 &&
      carteSauvee.viewMeasurements[1].viewIndex === 2 &&
      carteSauvee.viewMeasurements[1].depth.fieldWidthCm === 27,
    'comparaison et historique conservent les deux contrats natifs sans troncature');

  const preuveIncomplete = mesureCarte(1, 30);
  delete preuveIncomplete.depth.cardObservations;
  delete preuveIncomplete.depth.cardTrackingMethod;
  delete preuveIncomplete.depth.cardWidthCm;
  await ecran(page, [avis('gemini', 'gemini-3.1-flash-lite', 48, riz),
                      avis('openrouter', 'x-ai/grok-4.5', 50, riz)], {
    notes: 'contrat carte forge', imageCount: 1,
    referenceMode: 'glucovision-card-v2', viewMeasurements: [preuveIncomplete]
  });
  const carteForgee = await page.evaluate(function () {
    const h = JSON.parse(localStorage.getItem('diabete.history.v1') || '[]');
    const e = h.filter(function (x) {
      return x.input && x.input.notes === 'contrat carte forge';
    })[0];
    return e && e.input ? e.input : null;
  });
  verifie(!!carteForgee && carteForgee.referenceMode === 'glucovision-card-v2' &&
      Array.isArray(carteForgee.viewMeasurements) && carteForgee.viewMeasurements.length === 0,
    'une preuve carte incomplète est retirée des reprises et de l’historique');

  const ancienneCarte = mesureCarte(1, 30);
  ancienneCarte.depth.cardSchema = 'glucovision-card-v1';
  ancienneCarte.depth.cardName = 'glucovision-card';
  ancienneCarte.reference.mode = 'glucovision-card-v1';
  ancienneCarte.reference.cardSchema = 'glucovision-card-v1';
  ancienneCarte.reference.cardName = 'glucovision-card';
  await ecran(page, [avis('gemini', 'gemini-3.1-flash-lite', 48, riz),
                      avis('openrouter', 'x-ai/grok-4.5', 50, riz)], {
    notes: 'ancienne carte v1', imageCount: 1,
    referenceMode: 'glucovision-card-v1', viewMeasurements: [ancienneCarte]
  });
  const legacyClosed = await page.evaluate(function () {
    const h = JSON.parse(localStorage.getItem('diabete.history.v1') || '[]');
    const e = h.filter(function (x) {
      return x.input && x.input.notes === 'ancienne carte v1';
    })[0];
    return e && e.input ? e.input : null;
  });
  verifie(!!legacyClosed && legacyClosed.referenceMode === 'none' &&
      Array.isArray(legacyClosed.viewMeasurements) && legacyClosed.viewMeasurements.length === 0,
    'une preuve v1 restaurée perd tout privilège métrique au lieu d’être promue en v2');

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
    const url = new URL(route.request().url());
    const query = url.searchParams.get('search_terms') || '';
    const raceProduct = query === 'ancienne' ? {
      code: '1111111111111', product_name_fr: 'Ancien résultat', brands: 'Test',
      quantity: '100 g', product_quantity: 100, product_quantity_unit: 'g',
      nutriments: { carbohydrates_100g: 10 }
    } : query === 'nouvelle' ? {
      code: '2222222222222', product_name_fr: 'Nouveau résultat', brands: 'Test',
      quantity: '100 g', product_quantity: 100, product_quantity_unit: 'g',
      nutriments: { carbohydrates_100g: 20 }
    } : null;
    return route.fulfill({
      delay: query === 'ancienne' ? 250 : 10,
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        products: raceProduct ? [raceProduct] : [{
          code: '7622210449283', product_name_fr: 'Biscuits test', brands: 'Marque',
          quantity: '300 g e', product_quantity: 300, product_quantity_unit: 'g',
          nutriments: { carbohydrates_100g: 70 }
        }]
      })
    });
  });
  await page.goto('http://localhost:' + PORT + '/');
  await page.click('.tab[data-tab="manual"]');
  await page.click('.mode-btn[data-mode="produit"]');

  // La réponse lente de l'ancienne recherche ne doit jamais écraser la plus récente.
  await page.fill('#off-search', 'ancienne');
  await page.click('#off-search-btn');
  await page.fill('#off-search', 'nouvelle');
  await page.click('#off-search-btn');
  await page.waitForFunction(function () {
    const box = document.getElementById('off-results');
    return box && /Nouveau résultat/.test(box.textContent);
  }, null, { timeout: 5000 });
  await page.waitForTimeout(350);
  const rechercheFinale = await page.textContent('#off-results');
  verifie(/Nouveau résultat/.test(rechercheFinale) && !/Ancien résultat/.test(rechercheFinale),
    'une ancienne recherche lente ne remplace pas les résultats de la plus récente');

  await page.fill('#off-search', 'biscuits');
  await page.click('#off-search-btn');
  await page.waitForSelector('.off-item', { timeout: 5000 });
  await page.click('.off-item .food-label');
  await page.waitForSelector('#portion-card:not([hidden])', { timeout: 5000 });

  const poids = await page.inputValue('#portion-total');
  verifie(poids === '300', 'le poids du paquet est prérempli depuis la base : ' + poids);
  verifie(await page.isDisabled('#portion-add'),
    'sans nombre d’unités, on ne peut rien ajouter');

  await page.fill('#portion-units', '15');
  await page.fill('#portion-label', 'biscuits');
  await page.fill('#portion-eat', '2');
  const calcul = await page.textContent('#portion-result');
  /* Cas demandé : 300 g / 15 biscuits = 20 g ; deux biscuits = 40 g ;
     à 70 g/100 g, le résultat exact est 28 g de glucides. */
  verifie(/20 g/.test(calcul), 'le poids d’une unité est calculé : ' + calcul.replace(/\s+/g, ' '));
  verifie(/28 g de glucides/.test(calcul), 'et les glucides des 2 unités aussi');
  verifie(/1 biscuit =/.test(calcul) && /2 biscuits =/.test(calcul),
    'le singulier et le pluriel sont corrects');

  await page.click('#portion-add');
  await page.waitForSelector('.manual-row', { timeout: 5000 });
  const ligne = await page.textContent('.manual-row');
  verifie(/28 g/.test(ligne), 'la ligne du repas porte les mêmes glucides : ' + ligne.replace(/\s+/g, ' '));
  verifie(await page.isHidden('#portion-card'), 'la carte se referme après ajout');

  // Le second scan du même produit doit déjà connaître le nombre d'unités.
  await page.click('.off-item .food-label');
  await page.waitForSelector('#portion-card:not([hidden])', { timeout: 5000 });
  const memoire = await page.inputValue('#portion-units');
  verifie(memoire === '15', 'le nombre d’unités est retenu pour ce code-barres : ' + memoire);

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

  // Une recherche publique par nom ne doit pas contourner la correction perso.
  await page.click('#portion-close');
  await page.route('**/world.openfoodfacts.org/**', function (route) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      products: [{
        code: '9999999999999', product_name_fr: 'Gâteau public', brands: 'Base publique',
        quantity: '400 g', product_quantity: 400, product_quantity_unit: 'g',
        nutriments: { carbohydrates_100g: 20 }
      }]
    }) });
  });
  await page.fill('#off-search', 'gateau');
  await page.click('#off-search-btn');
  await page.waitForSelector('.off-item', { timeout: 5000 });
  await page.click('.off-item .food-label');
  await page.waitForSelector('#portion-card:not([hidden])', { timeout: 5000 });
  verifie(/Gâteau de mamie/.test(await page.textContent('#portion-name')) &&
      /60 g/.test(await page.textContent('#portion-carb')),
    'la valeur personnelle 60 g/100 g gagne aussi après une recherche OFF par nom');

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

  /* Question de clarification. La logique de filtrage est couverte par
     tests/clarification.test.js ; ce qui ne se vérifie qu'ici, c'est qu'elle
     s'affiche AVANT le chiffre, que « je ne sais pas » la referme sans casser
     le résultat, et qu'une réponse remplit bien la description. */
  console.log('\nQuestion de clarification :');
  /* Repas en mode DESCRIPTION : une relance y est toujours possible, alors
     qu'après une reprise photo les images ne sont plus en mémoire et la carte
     est délibérément masquée (un bouton qui ne peut pas tenir sa promesse est
     pire que pas de bouton). */
  const question = {
    question: 'Sous les fruits rouges, c’est du yaourt ou du porridge ?',
    options: ['Yaourt', 'Porridge'], impactCarbsG: 22
  };
  const dateQuestion = await page.evaluate(function (clar) {
    const h = JSON.parse(localStorage.getItem('diabete.history.v1') || '[]');
    const date = Date.now() + 5000;
    h.unshift({
      date: date, source: 'texte', draft: true, confirmed: false,
      totalCarbsG: 24, parts: 2, provider: 'gemini', model: 'gemini-3.1-flash-lite',
      seen: 'Un bol de préparation blanche avec des fruits rouges.',
      items: [{ name: 'porridge', carbsG: 24, portion: 'un bol' }],
      input: { notes: 'un bol avec des fruits rouges', extras: '', imageCount: 0 },
      resultSnapshot: {
        totalCarbsG: 24, rangeLowG: 18, rangeHighG: 30,
        overallConfidence: 'medium', model: 'gemini-3.1-flash-lite', fromText: true,
        seen: 'Un bol de préparation blanche avec des fruits rouges.',
        items: [{ name: 'porridge', carbsG: 24, estimatedMassG: 200,
                  carbDensityPer100g: 12, confidence: 'medium' }],
        clarification: clar
      }
    });
    localStorage.setItem('diabete.history.v1', JSON.stringify(h));
    return date;
  }, question);
  await page.goto('http://localhost:' + PORT + '/');
  await page.click('.tab[data-tab="history"]');
  await page.locator('.history-head[data-open="' + dateQuestion + '"]').click();
  await page.waitForSelector('.history-resume[data-resume="' + dateQuestion + '"]');
  await page.locator('.history-resume[data-resume="' + dateQuestion + '"]').click();
  await page.waitForSelector('.clarif-card', { timeout: 5000 });

  verifie(/yaourt/i.test(await page.textContent('.clarif-q')),
    'la question du modèle est affichée');
  verifie(/22 g/.test(await page.textContent('.clarif-card')),
    'et l’enjeu chiffré est montré');
  verifie(await page.evaluate(function () {
    const res = document.getElementById('results');
    const carte = document.querySelector('.clarif-card');
    const chiffre = document.querySelector('.hero-carbs');
    if (!carte || !chiffre) return false;
    // Lire la question APRÈS avoir recopié le chiffre ne sert à rien.
    return !!(carte.compareDocumentPosition(chiffre) & Node.DOCUMENT_POSITION_FOLLOWING) &&
           res.contains(carte);
  }), 'elle est placée avant le chiffre, pas après');

  await page.click('.clarif-skip');
  verifie(await page.locator('.clarif-card').count() === 0,
    '« je ne sais pas » referme la question');
  verifie(/24/.test(await page.textContent('.hero-carbs')),
    'et le résultat reste utilisable');

  /* Une réponse ne vaut que pour le repas en cours : elle doit garder son heure
     et son lieu, puis autoriser une nouvelle question au repas suivant. */
  console.log('\nCycle complet de clarification :');
  await page.evaluate(function () {
    const key = 'diabete.settings.v1';
    const s = JSON.parse(localStorage.getItem(key) || '{}');
    s.provider = 'gemini';
    s.verificationMode = 'off';
    s.verifyProvider = '';
    s.venue = 'restaurant';
    s.apiKeys = Object.assign({}, s.apiKeys || {}, { gemini: 'cle-test' });
    localStorage.setItem(key, JSON.stringify(s));
  });
  await page.goto('http://localhost:' + PORT + '/');
  await page.evaluate(function (clar) {
    window.__clarifCalls = [];
    window.Estimator.estimate = function (images, ctx) {
      window.__clarifCalls.push(JSON.parse(JSON.stringify(ctx)));
      var total = window.__clarifCalls.length === 2 ? 30 : 24;
      var parAliment = total / 3;
      return Promise.resolve({
        totalCarbsG: total, rangeLowG: total - 6, rangeHighG: total + 6,
        overallConfidence: 'medium', model: 'gemini-3.1-flash-lite',
        provider: 'gemini', fromText: true, seen: 'Un bol avec des fruits rouges.',
        blocking: [], alerts: [], clarification: clar,
        items: ['porridge', 'fruits rouges', 'lait'].map(function (name) {
          return { name: name, carbsG: parAliment, estimatedMassG: 100,
                   carbDensityPer100g: parAliment, confidence: 'medium', assumptions: '' };
        })
      });
    };
  }, question);
  await page.click('.mode-btn[data-mode="texte"]');
  await page.fill('#user-notes', 'premier bol avec fruits rouges');
  await page.click('#estimate-btn');
  await page.waitForSelector('.clarif-card', { timeout: 5000 });
  const historiqueAvantReponse = await page.evaluate(function () {
    const h = JSON.parse(localStorage.getItem('diabete.history.v1') || '[]');
    return { count: h.length, date: h[0] && h[0].date, total: h[0] && h[0].totalCarbsG };
  });
  await page.locator('.clarif-opt').first().click();
  await page.waitForFunction(function () { return window.__clarifCalls.length === 2; });
  await page.waitForFunction(function () { return !document.querySelector('.clarif-card'); });
  const memeRepas = await page.evaluate(function () {
    return window.__clarifCalls.map(function (x) {
      return { mealAt: x.mealAt, venue: x.venue,
               clarificationAnswered: x.clarificationAnswered === true };
    });
  });
  verifie(memeRepas[0].mealAt === memeRepas[1].mealAt &&
      memeRepas[0].venue === 'restaurant' && memeRepas[1].venue === 'restaurant' &&
      !memeRepas[0].clarificationAnswered && memeRepas[1].clarificationAnswered,
    'la réponse relance strictement le même repas sans reposer la question');
  const historiqueApresReponse = await page.evaluate(function () {
    const h = JSON.parse(localStorage.getItem('diabete.history.v1') || '[]');
    return { count: h.length, date: h[0] && h[0].date, total: h[0] && h[0].totalCarbsG };
  });
  verifie(historiqueApresReponse.count === historiqueAvantReponse.count &&
      historiqueApresReponse.date === historiqueAvantReponse.date &&
      historiqueAvantReponse.total === 24 && historiqueApresReponse.total === 30,
    'la réponse met à jour le même brouillon au lieu de laisser l’ancien chiffre');

  await page.fill('#user-notes', 'deuxième repas complètement différent');
  await page.click('#estimate-btn');
  await page.waitForFunction(function () { return window.__clarifCalls.length === 3; });
  await page.waitForSelector('.clarif-card', { timeout: 5000 });
  verifie(await page.evaluate(function () {
    return window.__clarifCalls[2].clarificationAnswered !== true;
  }), 'un nouveau repas peut recevoir sa propre question de clarification');

  /* Repli automatique vers un second fournisseur : le cas d'usage exact
     évoqué en discussion (clé Gemini à sec en plein repas) est simulé en
     faisant échouer le fournisseur principal avec la même erreur 429 que
     produirait un vrai quota dépassé. */
  console.log('\nRepli automatique vers un second fournisseur :');
  await page.evaluate(function () {
    const key = 'diabete.settings.v1';
    const s = JSON.parse(localStorage.getItem(key) || '{}');
    s.provider = 'gemini';
    s.fallbackProvider = 'openrouter';
    s.verificationMode = 'off';
    s.verifyProvider = '';
    s.apiKeys = Object.assign({}, s.apiKeys || {}, { gemini: 'cle-test', openrouter: 'cle-secours' });
    localStorage.setItem(key, JSON.stringify(s));
  });
  await page.goto('http://localhost:' + PORT + '/');
  await page.evaluate(function () {
    window.__secoursAppeleAvec = null;
    window.Estimator.estimate = function () {
      var err = new Error('Quota / débit atteint (429). Patiente ~1 min puis réessaie.');
      err.status = 429;
      return Promise.reject(err);
    };
    window.Estimator.estimateWith = function (provider) {
      window.__secoursAppeleAvec = provider;
      return Promise.resolve({
        totalCarbsG: 32, rangeLowG: 26, rangeHighG: 38,
        overallConfidence: 'medium', model: 'x-ai/grok-4.5',
        provider: provider, fromText: true, seen: 'Une salade composée.',
        blocking: [], alerts: [], clarification: null,
        items: [{ name: 'salade composée', carbsG: 32, estimatedMassG: 200,
                  carbDensityPer100g: 16, confidence: 'medium', assumptions: '' }]
      });
    };
  });
  await page.click('.mode-btn[data-mode="texte"]');
  await page.fill('#user-notes', 'salade composée pour tester le repli');
  await page.click('#estimate-btn');
  await page.waitForSelector('#results .safety-banner', { timeout: 5000 });
  verifie(await page.evaluate(function () { return window.__secoursAppeleAvec; }) === 'openrouter',
    'le secours OpenRouter est appelé quand Gemini échoue');
  const bandeauRepli = await page.textContent('#results .safety-banner');
  verifie(/gemini/i.test(bandeauRepli) && /openrouter/i.test(bandeauRepli),
    'le bandeau nomme le fournisseur en défaut et celui qui a répondu');
  verifie(/32/.test(await page.textContent('.hero-carbs')),
    'le chiffre affiché est bien celui du fournisseur de secours');

  /* Sans clé de secours utilisable, l'échec du principal ne doit JAMAIS être
     masqué : c'est l'erreur réelle (ici la clé Gemini) qui doit atteindre
     l'utilisateur, pas un silence ni une fausse réussite. */
  console.log('\nSans clé de secours, l\'erreur du fournisseur principal n\'est pas masquée :');
  await page.evaluate(function () {
    const key = 'diabete.settings.v1';
    const s = JSON.parse(localStorage.getItem(key) || '{}');
    s.provider = 'gemini';
    s.fallbackProvider = 'openrouter';
    s.verificationMode = 'off';
    s.verifyProvider = '';
    s.apiKeys = Object.assign({}, s.apiKeys || {}, { gemini: 'cle-test', openrouter: '' });
    localStorage.setItem(key, JSON.stringify(s));
  });
  await page.goto('http://localhost:' + PORT + '/');
  await page.evaluate(function () {
    window.__secoursAppele = false;
    window.Estimator.estimate = function () {
      var err = new Error('Clé API invalide, expirée ou sans accès (401).');
      err.status = 401;
      return Promise.reject(err);
    };
    window.Estimator.estimateWith = function () {
      window.__secoursAppele = true;
      return Promise.reject(new Error('ne doit jamais être appelé'));
    };
  });
  await page.click('.mode-btn[data-mode="texte"]');
  await page.fill('#user-notes', 'repas pour tester l\'absence de secours');
  await page.click('#estimate-btn');
  await page.waitForFunction(function () {
    const t = document.getElementById('toast');
    return t && !t.hidden;
  }, { timeout: 5000 });
  verifie(await page.evaluate(function () { return window.__secoursAppele; }) === false,
    'sans clé OpenRouter enregistrée, le secours n\'est jamais appelé');
  verifie(/401|clé API invalide/i.test(await page.textContent('#toast')),
    'et c\'est bien l\'erreur du fournisseur principal qui remonte, pas un message générique');

  verifie(erreursJs.length === 0, 'aucune erreur JavaScript : ' + (erreursJs[0] || '—'));

  await nav.close();
  srv.close();
  console.log(echecs ? '\nÉCHEC : ' + echecs + ' vérification(s)' : '\nToutes les vérifications passent.');
  process.exit(echecs ? 1 : 0);
})().catch(function (e) {
  console.error('Test navigateur interrompu :', e.message);
  process.exit(1);
});
