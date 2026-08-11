'use strict';

/* Ces calculs produisent le nombre de glucides qui sera saisi dans une pompe.
   Un facteur d'échelle faux ici ne se voit nulle part ailleurs : le résultat a
   toujours l'air d'un résultat. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript, plain } = require('./test-env');

const { Portion } = loadScript('js/portion.js');

function proche(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon,
    `${actual} devrait être proche de ${expected}`);
}

test('un multipack ne fait que suggérer son nombre d\'unités', () => {
  assert.deepEqual(plain(Portion.parseQuantity('12 x 25 g')),
    { total: 300, unitesSuggerees: 12, parUniteSuggeree: 25,
      label: '', unite: 'g', confirme: false });
  assert.deepEqual(plain(Portion.parseQuantity('6x125g')),
    { total: 750, unitesSuggerees: 6, parUniteSuggeree: 125,
      label: '', unite: 'g', confirme: false });
  assert.deepEqual(plain(Portion.parseQuantity('4 × 100 g')),
    { total: 400, unitesSuggerees: 4, parUniteSuggeree: 100,
      label: '', unite: 'g', confirme: false });
  assert.equal(Portion.parseQuantity('2 x 250 g').confirme, false,
    'deux sachets ne doivent jamais être pris automatiquement pour deux biscuits');
});

test('une quantité simple donne le poids du paquet, sans inventer d\'unités', () => {
  // « e » est la marque d'estimation métrologique européenne, pas une unité.
  assert.deepEqual(plain(Portion.parseQuantity('300 g e')),
    { total: 300, unitesSuggerees: null, parUniteSuggeree: null,
      label: '', unite: 'g', confirme: false });
  assert.deepEqual(plain(Portion.parseQuantity('154g')),
    { total: 154, unitesSuggerees: null, parUniteSuggeree: null,
      label: '', unite: 'g', confirme: false });
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
  assert.deepEqual(plain(Portion.parseQuantity('12 biscuits')),
    { total: null, unitesSuggerees: 12, parUniteSuggeree: null,
      label: 'biscuit', unite: 'g', confirme: false },
    'le compte est utile comme suggestion, mais ne suffit pas au calcul');
});

test('le texte libre comprend un vrai nombre de biscuits autour du poids total', () => {
  assert.deepEqual(plain(Portion.parseQuantity('15 biscuits - 300 g')),
    { total: 300, unitesSuggerees: 15, parUniteSuggeree: null,
      label: 'biscuit', unite: 'g', confirme: false });
  assert.deepEqual(plain(Portion.parseQuantity('15 biscuits x 20 g')),
    { total: 300, unitesSuggerees: 15, parUniteSuggeree: 20,
      label: 'biscuit', unite: 'g', confirme: false });
});

test('le poids d\'une unité reste exact, ou rien', () => {
  proche(Portion.parUnite(500, 12), 500 / 12);
  assert.equal(Portion.parUnite(300, 12), 25);
  assert.equal(Portion.parUnite(500, 0), null, 'pas de division par zéro');
  assert.equal(Portion.parUnite(0, 12), null);
  assert.equal(Portion.parUnite(500, null), null);
  proche(Portion.parUnite('500', '12'), 500 / 12);
  assert.equal(Portion.parUnite(500, -3), null);
});

test('l\'exemple demandé : boîte de 500 g, 12 biscuits, j\'en mange 2', () => {
  const r = Portion.calcule(500, 12, 2, 70);
  proche(r.parUnite, 500 / 12);
  proche(r.quantite, 500 / 12 * 2);
  proche(r.glucides, 500 / 12 * 2 * 0.7);
});

test('le cas demandé : paquet de 15 biscuits, j\'en mange 2', () => {
  const r = Portion.calcule(300, 15, 2, 70);
  assert.equal(r.parUnite, 20);
  assert.equal(r.quantite, 40);
  assert.equal(r.glucides, 28);
});

test('un poids direct par biscuit fonctionne sans poids total du paquet', () => {
  const r = Portion.calculeUnites({
    methode: 'unite', parUnite: 18.5, mange: 2, pour100: 64
  });
  assert.equal(r.parUnite, 18.5);
  assert.equal(r.quantite, 37);
  assert.equal(r.glucides, 23.68);
});

test('une saisie incomplète ne produit aucun résultat', () => {
  // Afficher un demi-calcul serait pire que rien : le chiffre serait recopié.
  assert.equal(Portion.calcule(500, 12, 0, 70), null, 'zéro unité mangée');
  assert.equal(Portion.calcule(500, null, 2, 70), null, 'nombre d\'unités inconnu');
  assert.equal(Portion.calcule(null, 12, 2, 70), null, 'poids du paquet inconnu');
  assert.equal(Portion.calcule(500, 12, 2, null), null,
    'sans glucides connus, aucun résultat présenté comme complet');
});

test('une fraction d\'unité est acceptée', () => {
  // Un demi-pain pita, un tiers de tablette : c'est un cas courant.
  const r = Portion.calcule(200, 4, 0.5, 50);
  assert.equal(r.quantite, 25);
  assert.equal(r.glucides, 12.5);
});

test('les glucides ne sont arrondis qu\'une fois', () => {
  // Arrondir à l'entier ici, puis à l'affichage, décalerait le total du repas.
  assert.equal(Portion.glucides(83.34, 70), 58.338);
  assert.equal(Portion.glucides(0, 70), 0);
  assert.equal(Portion.glucides(100, 0), 0, 'un aliment sans glucides en donne zéro');
  assert.equal(Portion.glucides(-5, 70), null);
});

test('un nombre d\'unités de paquet est entier et un dépassement est signalé', () => {
  assert.equal(Portion.calcule(300, 15.5, 2, 70), null);
  assert.equal(Portion.calcule(300, 15, 16, 70).depassePaquet, true);
});
