'use strict';

/* La relance est testée à travers le VRAI chemin d'appel, pas sur une fonction
   isolée : le défaut qu'on a attrapé plusieurs fois dans ce projet n'est jamais
   « la fonction est fausse », c'est « la fonction juste n'est pas branchée ».

   On simule donc fetch() et on regarde combien de fois il est réellement
   appelé. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript } = require('./test-env');

const REPAS = {
  seen: 'Une assiette de riz.',
  items: [{ name: 'riz blanc', estimatedMassG: 200, carbDensityPer100g: 28,
            carbsG: 56, confidence: 'medium' }],
  totalCarbsG: 56, rangeLowG: 46, rangeHighG: 66, overallConfidence: 'medium'
};

// Réponse Gemini valide, enveloppée comme l'API le fait réellement.
function reponseOk() {
  return {
    ok: true, status: 200,
    text: () => Promise.resolve(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(REPAS) }] } }]
    }))
  };
}

function erreurApi(status, message) {
  return {
    ok: false, status: status,
    text: () => Promise.resolve(JSON.stringify({ error: { message: message } }))
  };
}

/* setTimeout accéléré : le délai de relance est réel dans l'app, inutile de le
   subir ici. On garde la même sémantique, seule la durée change. */
function env(reponses) {
  const appels = [];
  const sandbox = loadScript('js/estimator.js', {
    setTimeout: (fn) => { fn(); return 0; },
    fetch: function (url, opts) {
      appels.push({ url: url, opts: opts });
      const r = reponses[appels.length - 1];
      return (typeof r === 'function') ? r() : Promise.resolve(r);
    }
  });
  return { Estimator: sandbox.Estimator, appels: appels };
}

const IMAGE = [{ base64: 'AAAA', mediaType: 'image/jpeg' }];
const REGLAGES = { apiKeys: { gemini: 'k' }, models: { gemini: 'gemini-3.1-flash-lite' } };

test('une coupure passagère est rejouée, et le repas aboutit quand même', () => {
  const { Estimator, appels } = env([
    () => Promise.reject(new TypeError('fetch failed')),
    reponseOk()
  ]);
  return Estimator.estimateWith('gemini', IMAGE, { imageCount: 1 }, REGLAGES)
    .then(function (r) {
      assert.equal(appels.length, 2, 'exactement une relance');
      assert.equal(r.totalCarbsG, 56, 'et le résultat arrive');
    });
});

test('la lecture du corps interrompue est rejouée elle aussi', () => {
  /* Le cas réel : fetch() a réussi, les en-têtes sont arrivés, puis le réseau
     tombe pendant la descente du corps. C'est ce second aller-retour qui
     échappait à tous les filets. */
  const { Estimator, appels } = env([
    { ok: true, status: 200, text: () => Promise.reject(new TypeError('fetch failed')) },
    reponseOk()
  ]);
  return Estimator.estimateWith('gemini', IMAGE, { imageCount: 1 }, REGLAGES)
    .then(function (r) {
      assert.equal(appels.length, 2);
      assert.equal(r.totalCarbsG, 56);
    });
});

test('deux coupures d\'affilée renoncent, en disant qu\'on a déjà réessayé', () => {
  // Empiler les tentatives ferait attendre des minutes sans rien annoncer.
  const { Estimator, appels } = env([
    () => Promise.reject(new TypeError('fetch failed')),
    () => Promise.reject(new TypeError('fetch failed'))
  ]);
  return Estimator.estimateWith('gemini', IMAGE, { imageCount: 1 }, REGLAGES)
    .then(() => { throw new Error('aurait dû échouer'); },
      function (err) {
        assert.equal(appels.length, 2, 'une seule relance, pas une boucle');
        assert.equal(err.reseau, true, 'reconnaissable pour la mise en file d\'attente');
        assert.match(err.message, /déjà réessayé/,
          'sans ça on croit à une panne instantanée alors qu\'on a attendu deux fois');
      });
});

test('une clé invalide n\'est jamais rejouée', () => {
  // Elle échouerait exactement pareil, en faisant patienter pour rien.
  const { Estimator, appels } = env([erreurApi(401, 'invalid key')]);
  return Estimator.estimateWith('gemini', IMAGE, { imageCount: 1 }, REGLAGES)
    .then(() => { throw new Error('aurait dû échouer'); },
      function (err) {
        assert.equal(appels.length, 1);
        assert.equal(err.reseau, undefined, 'et ce n\'est pas une panne réseau');
        assert.match(err.message, /401|invalide/i);
      });
});

test('un quota atteint n\'est pas rejoué non plus', () => {
  const { Estimator, appels } = env([erreurApi(429, 'rate limited')]);
  return Estimator.estimateWith('gemini', IMAGE, { imageCount: 1 }, REGLAGES)
    .then(() => { throw new Error('aurait dû échouer'); },
      function (err) {
        assert.equal(appels.length, 1);
        assert.match(err.message, /429|quota/i);
      });
});

test('OpenRouter est protégé lui aussi — c\'est là que la panne a été vue', () => {
  /* Sans ce test, retirer la relance du chemin OpenAI/OpenRouter passait
     inaperçu : les autres cas ne couvrent que Gemini. Or c'est précisément sur
     OpenRouter que la coupure a été rencontrée en vrai. */
  const { Estimator, appels } = env([
    () => Promise.reject(new TypeError('fetch failed')),
    { ok: true, status: 200,
      text: () => Promise.resolve(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(REPAS) } }]
      })) }
  ]);
  return Estimator.estimateWith('openrouter', IMAGE, { imageCount: 1 },
    { apiKeys: { openrouter: 'k' }, models: { openrouter: 'x-ai/grok-4.5' } })
    .then(function (r) {
      assert.equal(appels.length, 2, 'la relance est branchée sur ce chemin aussi');
      assert.equal(r.totalCarbsG, 56);
      assert.match(appels[0].url, /openrouter\.ai/);
    });
});

test('Claude est protégé lui aussi', () => {
  const { Estimator, appels } = env([
    () => Promise.reject(new TypeError('fetch failed')),
    { ok: true, status: 200,
      text: () => Promise.resolve(JSON.stringify({
        content: [{ type: 'text', text: JSON.stringify(REPAS) }]
      })) }
  ]);
  return Estimator.estimateWith('claude', IMAGE, { imageCount: 1 },
    { apiKeys: { claude: 'k' }, models: { claude: 'claude-opus-5' } })
    .then(function (r) {
      assert.equal(appels.length, 2);
      assert.equal(r.totalCarbsG, 56);
    });
});

test('le message réseau reste lisible, jamais le jargon du navigateur', () => {
  const { Estimator } = env([
    () => Promise.reject(new TypeError('Failed to fetch')),
    () => Promise.reject(new TypeError('Failed to fetch'))
  ]);
  return Estimator.estimateWith('gemini', IMAGE, { imageCount: 1 }, REGLAGES)
    .then(() => { throw new Error('aurait dû échouer'); },
      function (err) {
        assert.doesNotMatch(err.message, /failed to fetch/i,
          'c\'est précisément le message incompréhensible qu\'on a vu à l\'écran');
        assert.match(err.message, /connexion/i);
      });
});
