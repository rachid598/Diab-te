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
  const page = await nav.newPage({ viewport: { width: 390, height: 844 } });
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

  verifie(erreursJs.length === 0, 'aucune erreur JavaScript : ' + (erreursJs[0] || '—'));

  await nav.close();
  srv.close();
  console.log(echecs ? '\nÉCHEC : ' + echecs + ' vérification(s)' : '\nToutes les vérifications passent.');
  process.exit(echecs ? 1 : 0);
})().catch(function (e) {
  console.error('Test navigateur interrompu :', e.message);
  process.exit(1);
});
