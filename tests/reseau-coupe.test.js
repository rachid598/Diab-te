'use strict';

/* Le scénario réel : l'analyse tourne, OpenRouter met une minute, le téléphone
   bascule du Wi-Fi à la 4G — et l'assiette est déjà entamée, la photo n'est plus
   refaisable.

   Deux défauts se cumulaient. fetch() résout dès l'arrivée des EN-TÊTES : la
   lecture du corps est un second aller-retour, non couvert par le filet de
   fetchWithTimeout, et son échec remontait en clair (« fetch failed »). Puis ce
   libellé n'était pas reconnu comme une panne réseau, donc l'app ne proposait
   même pas de garder le repas. Message incompréhensible, analyse perdue. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript } = require('./test-env');

const { Queue } = loadScript('js/queue.js');

test('les libellés de panne réseau des trois moteurs sont reconnus', () => {
  // Chrome / Android WebView, Node-undici, WebKit-iOS. Les trois formulations
  // décrivent la même chose ; seule la première était couverte.
  assert.equal(Queue.isNetworkError(new Error('Failed to fetch')), true);
  assert.equal(Queue.isNetworkError(new Error('fetch failed')), true, 'l\'ordre des mots change');
  assert.equal(Queue.isNetworkError(new Error('Load failed')), true, 'Safari / iOS');
  assert.equal(Queue.isNetworkError(new Error('NetworkError when attempting to fetch')), true);
  assert.equal(Queue.isNetworkError(new Error('net::ERR_CONNECTION_RESET')), true);
});

test('le drapeau posé par l\'estimateur prime sur le libellé', () => {
  /* C'est le vrai correctif : ne plus dépendre de l'orthographe d'un message
     d'erreur, qui change d'un moteur et d'une version à l'autre. */
  const err = new Error('Réponse interrompue en cours de lecture.');
  err.reseau = true;
  assert.equal(Queue.isNetworkError(err), true);

  const muet = new Error('bruit total sans aucun mot-clé');
  muet.reseau = true;
  assert.equal(Queue.isNetworkError(muet), true);
});

test('un TypeError nu vient forcément d\'un fetch qui n\'a pas abouti', () => {
  const t = new TypeError('');
  assert.equal(Queue.isNetworkError(t), true);
});

test('une erreur d\'API n\'est PAS une panne réseau', () => {
  /* Rejouer plus tard une clé invalide ou un quota atteint échouerait
     exactement pareil : proposer de garder le repas serait une fausse promesse. */
  const cle = new Error('Clé API invalide'); cle.status = 401;
  const quota = new Error('Quota atteint'); quota.status = 429;
  const requete = new Error('Paramètre refusé'); requete.status = 400;
  assert.equal(Queue.isNetworkError(cle), false);
  assert.equal(Queue.isNetworkError(quota), false);
  assert.equal(Queue.isNetworkError(requete), false);
});

test('une panne du fournisseur, elle, mérite un nouvel essai', () => {
  const cinq = new Error('Bad gateway'); cinq.status = 502;
  const lent = new Error('Request timeout'); lent.status = 408;
  assert.equal(Queue.isNetworkError(cinq), true);
  assert.equal(Queue.isNetworkError(lent), true);
});

test('hors ligne, tout échec est un échec réseau', () => {
  const Hors = loadScript('js/queue.js', { navigator: { onLine: false } }).Queue;
  assert.equal(Hors.isNetworkError(new Error('n\'importe quoi')), true);
});

test('sans erreur, rien à mettre de côté', () => {
  assert.equal(Queue.isNetworkError(null), false);
  assert.equal(Queue.isNetworkError(undefined), false);
});
