'use strict';

/* Les cinq scénarios de l'audit, reproduits tels quels.

   Ce fichier existe parce que ces défauts n'étaient pas des fautes de frappe :
   chacun produisait un nombre affiché comme vérifié, destiné à être saisi dans
   une pompe. Un test qui échoue ici veut dire que le mot « confirmé » ment de
   nouveau. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript } = require('./test-env');

const { Estimator } = loadScript('js/estimator.js');

function repas(items, total) {
  return {
    seen: 'Une assiette',
    items: items,
    totalCarbsG: total,
    rangeLowG: Math.max(0, total - 10),
    rangeHighG: total + 10,
    overallConfidence: 'medium'
  };
}
const riz = (over) => Object.assign({
  name: 'riz blanc', estimatedMassG: 100, carbDensityPer100g: 28,
  carbsG: 28, proteinG: 3, fatG: 1, kcal: 130, confidence: 'medium'
}, over || {});

test('renommer un aliment retire le chiffre au lieu de le laisser confirmable', () => {
  // Ce que fait l'interface : le nom change, les glucides ne bougent pas.
  const avant = Estimator.recompute(repas([riz()], 28));
  assert.equal(avant.blocking.length, 0, 'un repas sain ne doit rien bloquer');

  const renomme = Estimator.recompute(repas(
    [riz({ name: 'flocons d\'avoine', needsNutrition: true, renamedFrom: 'riz blanc' })], 28));
  assert.ok(renomme.blocking.length > 0, 'un renommage doit bloquer le résultat');
  assert.match(renomme.blocking.join(' '), /renomm/i);
  assert.match(renomme.blocking.join(' '), /riz blanc/, 'le blocage nomme l\'aliment d\'origine');
});

test('reprendre les glucides à la main lève le blocage du renommage', () => {
  const repris = Estimator.recompute(repas(
    [riz({ name: 'flocons d\'avoine', carbsG: 60, estimatedMassG: 80, carbDensityPer100g: 75 })], 60));
  assert.equal(repris.blocking.length, 0);
});

test('une contradiction masse x densite assez forte bloque, elle n\'alerte plus', () => {
  // 100 g à 28 g/100 g donnent 28 g. En annoncer 90 n'est pas un arrondi.
  const faux = Estimator.recompute(repas([riz({ carbsG: 90 })], 90));
  assert.ok(faux.blocking.length > 0, 'la contradiction doit bloquer');
  assert.match(faux.blocking.join(' '), /28/, 'le blocage montre le calcul attendu');

  // Un écart modéré reste une simple alerte : bloquer sur un arrondi rendrait
  // l'application inutilisable, et on cesserait de lire les blocages.
  const limite = Estimator.recompute(repas([riz({ carbsG: 40 })], 40));
  assert.equal(limite.blocking.length, 0, 'un écart modéré ne doit pas bloquer');
  assert.ok(limite.alerts.length > 0, 'mais il doit alerter');
});

test('la fusion refuse deux avis qui ne décrivent pas le même repas', () => {
  assert.equal(Estimator.mergeAllowed(20, 200, 20, 25), false, '20 et 200 ne se moyennent pas');
  assert.equal(Estimator.mergeAllowed(200, 260, 20, 25), false,
    'sous le seuil relatif, mais 60 g d\'écart absolu');
  assert.equal(Estimator.mergeAllowed(48, 54, 20, 25), true, 'deux avis proches fusionnent');
  assert.equal(Estimator.mergeAllowed(48, 0, 20, 25), false, 'un avis nul ne fusionne pas');
  assert.equal(Estimator.mergeAllowed(48, null, 20, 25), false);
  // Le seuil configuré doit réellement décider, pas seulement s'afficher.
  assert.equal(Estimator.mergeAllowed(50, 60, 5, 25), false, 'seuil serré : refus');
  assert.equal(Estimator.mergeAllowed(50, 60, 40, 25), true, 'seuil large : accord');
});

test('deux routes vers le même modèle ne font pas deux avis', () => {
  assert.equal(Estimator.sameUnderlyingModel(
    ['gemini-3.1-flash-lite', 'google/gemini-3.1-flash-lite']), true);
  assert.equal(Estimator.sameUnderlyingModel(
    ['gemini-3.1-flash-lite', 'x-ai/grok-4.5']), false);
  assert.equal(Estimator.sameUnderlyingModel(
    ['gemini-3.1-flash-lite', 'x-ai/grok-4.5', 'anthropic/claude-opus-5']), false);
  assert.equal(Estimator.sameUnderlyingModel(
    ['claude-opus-5', 'anthropic/claude-opus-5']), true, 'route directe et route OpenRouter');
  assert.equal(Estimator.sameUnderlyingModel(['', '']), false, 'un modèle inconnu ne compte pas');
  assert.equal(Estimator.sameUnderlyingModel(null), false);
});
