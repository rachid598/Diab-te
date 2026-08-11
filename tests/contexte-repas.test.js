'use strict';

/* Le contexte est du texte envoyé au modèle : il oriente un nombre destiné à une
   pompe. Deux risques opposés, et les deux sont testés ici.

   Trop peu : le bloc n'est pas branché et l'information n'arrive jamais.
   Trop : on affirme un lieu qu'on ne connaît pas, ou on glisse une consigne
   chiffrée (« ajoute 20 % au restaurant ») qui serait une calibration inventée —
   exactement le reproche qu'on fait au champ serving_size d'OpenFoodFacts. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript } = require('./test-env');

const { Estimator } = loadScript('js/estimator.js');

const a = (h) => new Date(2026, 7, 10, h, 30).getTime();

test('le moment du repas suit l\'heure', () => {
  assert.equal(Estimator.mealMoment(a(7)), 'petit-déjeuner');
  assert.equal(Estimator.mealMoment(a(12)), 'déjeuner');
  assert.equal(Estimator.mealMoment(a(20)), 'dîner');
});

test('entre deux repas, on dit « collation » plutôt que d\'inventer', () => {
  // 16 h n'est ni un déjeuner ni un dîner. Nommer un repas au hasard donnerait
  // au modèle une portion de référence fausse.
  assert.equal(Estimator.mealMoment(a(16)), 'collation');
  assert.equal(Estimator.mealMoment(a(2)), 'collation');
  assert.equal(Estimator.mealMoment(a(23)), 'collation');
});

test('un horodatage absent ou absurde ne bloque rien', () => {
  assert.equal(typeof Estimator.mealMoment(undefined), 'string');
  assert.equal(typeof Estimator.mealMoment(Date.now()), 'string');
});

test('le lieu apparaît dans le bloc, avec ce qu\'il implique', () => {
  const bloc = Estimator.contextBlock({ mealAt: a(20), venue: 'restaurant' });
  assert.match(bloc, /CONTEXTE DU REPAS : dîner, au restaurant\./);
  assert.match(bloc, /plus grandes/, 'ce que le lieu implique est explicité');
  assert.match(bloc, /l’image qui a raison|l'image qui a raison/,
    'la photo garde le dernier mot');
});

test('aucun chiffre de correction n\'est soufflé au modèle', () => {
  /* Écrire « ajoute 20 % » fabriquerait une calibration qu'on n'a jamais
     mesurée. Le seul pourcentage légitime dans un prompt vient de
     calibrationBlock, calculé sur les repas RÉELLEMENT pesés. */
  ['maison', 'restaurant', 'cantine'].forEach((v) => {
    const bloc = Estimator.contextBlock({ mealAt: a(12), venue: v });
    assert.doesNotMatch(bloc, /\d\s*%/, v + ' ne doit contenir aucun pourcentage');
    assert.doesNotMatch(bloc, /\bmultipli|\bajoute\s+\d/i, v + ' ne doit dicter aucun calcul');
  });
});

test('sans lieu choisi, on ne prétend pas savoir où tu es', () => {
  const bloc = Estimator.contextBlock({ mealAt: a(12), venue: '' });
  assert.match(bloc, /déjeuner/, 'l\'heure, elle, est connue');
  assert.doesNotMatch(bloc, /maison|restaurant|cantine/);
});

test('un lieu inconnu est ignoré, pas recopié dans le prompt', () => {
  // Une valeur venant d'un stockage corrompu ne doit pas atteindre le modèle.
  const bloc = Estimator.contextBlock({ mealAt: a(12), venue: 'chez mamie' });
  assert.doesNotMatch(bloc, /mamie/);
});

test('le bloc arrive réellement dans le prompt photo', () => {
  // Une fonction juste mais non branchée ne sert à rien : c'est le défaut que
  // le test navigateur a déjà attrapé une fois sur l'écran de comparaison.
  const prompt = Estimator.buildPhotoPrompt({
    imageCount: 1, referenceMode: 'none', viewMeasurements: [],
    mealAt: a(20), venue: 'restaurant'
  });
  assert.match(prompt, /CONTEXTE DU REPAS : dîner, au restaurant/);
  assert.match(prompt, /Réponds uniquement avec le JSON\.$/,
    'et il reste avant la consigne finale');
});

test('le prompt photo reste inchangé quand rien n\'est connu du contexte', () => {
  // mealAt absent → l'heure courante s'applique : le bloc existe toujours, mais
  // il ne doit jamais nommer de lieu non choisi.
  const prompt = Estimator.buildPhotoPrompt({
    imageCount: 1, referenceMode: 'none', viewMeasurements: []
  });
  assert.doesNotMatch(prompt, /au restaurant|à la maison|à la cantine/);
});
