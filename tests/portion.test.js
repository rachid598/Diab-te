'use strict';

/* Ces calculs produisent le nombre de glucides qui sera saisi dans une pompe.
   Un facteur d'échelle faux ici ne se voit nulle part ailleurs : le résultat a
   toujours l'air d'un résultat. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript, plain } = require('./test-env');

const { Portion } = loadScript('js/portion.js');

test('un multipack annonce lui-même son nombre d\'unités', () => {
  assert.deepEqual(plain(Portion.parseQuantity('12 x 25 g')),
    { total: 300, unites: 12, parUnite: 25, unite: 'g' });
  assert.deepEqual(plain(Portion.parseQuantity('6x125g')),
    { total: 750, unites: 6, parUnite: 125, unite: 'g' });
  assert.deepEqual(plain(Portion.parseQuantity('4 × 100 g')),
    { total: 400, unites: 4, parUnite: 100, unite: 'g' });
});

test('une quantité simple donne le poids du paquet, sans inventer d\'unités', () => {
  // « e » est la marque d'estimation métrologique européenne, pas une unité.
  assert.deepEqual(plain(Portion.parseQuantity('300 g e')),
    { total: 300, unites: null, parUnite: null, unite: 'g' });
  assert.deepEqual(plain(Portion.parseQuantity('154g')),
    { total: 154, unites: null, parUnite: null, unite: 'g' });
  assert.equal(Portion.parseQuantity('1,5 kg').total, 1500);
});

test('un volume reste un volume', () => {
  // Convertir des ml en g suppose une densité de 1. C'est faux pour une huile
  // ou un sirop, et la dose serait fausse sans que rien ne le signale.
  assert.equal(Portion.parseQuantity('1 l').unite, 'ml');
  assert.equal(Portion.parseQuantity('1 l').total, 1000);
  assert.equal(Portion.parseQuantity('50 cl').total, 500);
  assert.equal(Portion.parseQuantity('33cl').unite, 'ml');
});

test('un texte inexploitable ne devient pas un chiffre', () => {
  assert.equal(Portion.parseQuantity(''), null);
  assert.equal(Portion.parseQuantity(null), null);
  assert.equal(Portion.parseQuantity('sachet familial'), null);
  assert.equal(Portion.parseQuantity('12 biscuits'), null, 'sans unité de masse, on ne sait pas');
});

test('le poids d\'une unité, ou rien', () => {
  assert.equal(Portion.parUnite(500, 12), 41.67);
  assert.equal(Portion.parUnite(300, 12), 25);
  assert.equal(Portion.parUnite(500, 0), null, 'pas de division par zéro');
  assert.equal(Portion.parUnite(0, 12), null);
  assert.equal(Portion.parUnite(500, null), null);
  assert.equal(Portion.parUnite('500', '12'), 41.67, 'les champs de saisie donnent du texte');
  assert.equal(Portion.parUnite(500, -3), null);
});

test('l\'exemple demandé : boîte de 500 g, 12 biscuits, j\'en mange 2', () => {
  const r = Portion.calcule(500, 12, 2, 70);
  assert.equal(r.parUnite, 41.67);
  assert.equal(r.quantite, 83.34);
  // 83,34 g à 70 g/100 g = 58,3 g de glucides.
  assert.equal(r.glucides, 58.34);
});

test('une saisie incomplète ne produit aucun résultat', () => {
  // Afficher un demi-calcul serait pire que rien : le chiffre serait recopié.
  assert.equal(Portion.calcule(500, 12, 0, 70), null, 'zéro unité mangée');
  assert.equal(Portion.calcule(500, null, 2, 70), null, 'nombre d\'unités inconnu');
  assert.equal(Portion.calcule(null, 12, 2, 70), null, 'poids du paquet inconnu');
  assert.equal(Portion.calcule(500, 12, 2, null).glucides, null,
    'sans glucides connus, la quantité reste calculée mais pas la dose');
});

test('une fraction d\'unité est acceptée', () => {
  // Un demi-pain pita, un tiers de tablette : c'est un cas courant.
  const r = Portion.calcule(200, 4, 0.5, 50);
  assert.equal(r.quantite, 25);
  assert.equal(r.glucides, 12.5);
});

test('les glucides ne sont arrondis qu\'une fois', () => {
  // Arrondir à l'entier ici, puis à l'affichage, décalerait le total du repas.
  assert.equal(Portion.glucides(83.34, 70), 58.34);
  assert.equal(Portion.glucides(0, 70), 0);
  assert.equal(Portion.glucides(100, 0), 0, 'un aliment sans glucides en donne zéro');
  assert.equal(Portion.glucides(-5, 70), null);
});
