'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript, plain } = require('./test-env');

const { ManualCalc } = loadScript('js/manual.js');

test('le mode manuel refuse les grammes négatifs, infinis ou démesurés', () => {
  assert.equal(ManualCalc.normalizeGrams('-1'), null);
  assert.equal(ManualCalc.normalizeGrams(Infinity), null);
  assert.equal(ManualCalc.normalizeGrams('5001'), null);
  assert.equal(ManualCalc.normalizeGrams('12,5'), 12.5);
});

test('la somme des lignes vaut toujours exactement le total affiché', () => {
  const got = ManualCalc.calculate([
    { name: 'A', grams: 1, carb: 60 },
    { name: 'B', grams: 1, carb: 60 }
  ]);
  assert.equal(got.ok, true);
  assert.equal(got.totalCarbsG, 1);
  assert.equal(got.rows.reduce((sum, row) => sum + row.carbsG, 0), 1);
  assert.deepEqual(plain(got.rows.map((row) => row.carbsG)), [1, 0]);
});

test('un total manuel supérieur à 400 g est bloqué avant enregistrement', () => {
  const got = ManualCalc.calculate([
    { name: 'Sucre', grams: 401, carb: 100 }
  ]);
  assert.equal(got.ok, false);
  assert.match(got.errors.join(' '), /supérieur à 400/i);
});

test('une densité nutritionnelle invalide ne produit pas un faux total', () => {
  const got = ManualCalc.calculate([{ name: 'Produit', grams: 100, carb: 120 }]);
  assert.equal(got.ok, false);
  assert.equal(got.totalCarbsG, 0);
  assert.match(got.errors.join(' '), /100 g invalides/i);
});
