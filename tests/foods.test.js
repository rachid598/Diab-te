'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript, plain } = require('./test-env');

function loadFoods(Storage) {
  return loadScript('js/foods.js', Storage ? { Storage } : {}).Foods;
}

test('la base locale expose des repères moyens identifiables et valides', () => {
  const Foods = loadFoods();
  assert.ok(Foods.all.length >= 100);

  const ids = new Set();
  Foods.all.forEach((food) => {
    assert.match(food.id, /^local:[a-z0-9-]+$/);
    assert.equal(ids.has(food.id), false, `identifiant dupliqué : ${food.id}`);
    ids.add(food.id);
    assert.ok(food.n && food.cat);
    assert.ok(Number.isFinite(food.carb) && food.carb >= 0 && food.carb <= 100);
    assert.ok(Array.isArray(food.portions) && food.portions.length > 0);
    assert.deepEqual(plain(food.meta), {
      source: 'local-generic-average',
      label: 'Repère moyen embarqué',
      approximate: true
    });
    // Les synonymes de recherche ne deviennent pas une identité nutritionnelle.
    assert.equal(Object.hasOwn(food, 'aliases'), false);
  });

  ['Boulgour (cuit)', 'Polenta (cuite)', 'Nouilles (cuites)', 'Mangue',
    'Framboises', 'Myrtilles', 'Skyr nature', 'Aubergine (cuite)',
    'Potiron / courge (cuits)'].forEach((name) => {
    assert.ok(Foods.all.some((food) => food.n === name), `${name} absent`);
  });

  const beer = Foods.all.find((food) => food.n === 'Bière');
  assert.deepEqual(plain(beer.portions), [['1 demi (25 cl)', 250], ['1 pinte (50 cl)', 500]]);
});

test('la recherche normalise ligatures, accents, apostrophes et tirets', () => {
  const Foods = loadFoods();
  assert.equal(Foods.search('oeuf')[0].n, 'Œuf');
  assert.equal(Foods.search('oeufs')[0].n, 'Œuf');
  assert.equal(Foods.search('BOEUF')[0].n, 'Bœuf (viande)');
  assert.equal(Foods.search('petit beurre')[0].n, 'Biscuit sec (type petit-beurre)');
  assert.equal(Foods.search('petit-beurre')[0].n, 'Biscuit sec (type petit-beurre)');
  assert.equal(Foods.search('flocons d’avoine')[0].n, "Flocons d'avoine");
  assert.equal(Foods.search('lait demi ecreme')[0].n, 'Lait demi-écrémé');
});

test('les mots peuvent être saisis dans un autre ordre et les alias restent ciblés', () => {
  const Foods = loadFoods();
  assert.equal(Foods.search('riz cuit blanc')[0].n, 'Riz blanc (cuit)');
  assert.equal(Foods.search('beurre jambon')[0].n, 'Sandwich jambon-beurre');
  assert.equal(Foods.search('spaghetti')[0].n, 'Pâtes (cuites)');

  const potato = Foods.search('pdt');
  assert.equal(potato[0].n, 'Pomme de terre (cuite)');
  assert.equal(potato.some((food) => food.n === 'Frites'), false);
  assert.notEqual(
    Foods.all.find((food) => food.n === 'Frites').id,
    Foods.all.find((food) => food.n === 'Pomme de terre (cuite)').id
  );
});

test('le classement privilégie le nom exact et reste compatible avec les catégories', () => {
  const Foods = loadFoods();
  assert.equal(Foods.search('pomme')[0].n, 'Pomme');

  const filtered = Foods.search('cuit blanc', 'Féculents');
  assert.equal(filtered[0].n, 'Riz blanc (cuit)');
  assert.ok(filtered.every((food) => food.cat === 'Féculents'));
  assert.deepEqual(plain(Foods.search('', 'Protéines')), plain(Foods.all.filter((food) => food.cat === 'Protéines')));
});

test('les aliments personnels participent à la recherche sans modifier la base', () => {
  const custom = {
    id: 'c-test', n: 'Riz familial épicé', cat: 'Perso', carb: 31,
    portions: [['1 bol', 180]], custom: true
  };
  const Foods = loadFoods({ getCustomFoods() { return [custom]; } });

  assert.equal(Foods.search('epice familial')[0].id, 'c-test');
  assert.equal(Foods.activeCategories()[1], 'Perso');
  assert.equal(Foods.all.some((food) => food.id === 'c-test'), false);
});

test('les produits connus facultatifs sont cherchables sans reprendre leurs portions OFF', () => {
  const Foods = loadFoods({
    getCustomFoods() { return []; },
    getProducts() {
      return {
        '3012345678901': {
          n: 'Biscuits cacao', brand: 'Marque Zed', carb: '67.5',
          serving: 250, portions: [['portion OFF', 250]], source: 'off',
          pack: { total: 300, unite: 'g', unitesSuggerees: 12, labelSuggere: 'biscuit' }
        },
        '2012345678902': {
          n: 'Yaourt de la maison', brand: '', carb: 8,
          serving: 999, source: 'perso'
        },
        invalide: { n: 'Sans valeur', carb: null }
      };
    }
  });

  const off = Foods.search('zed marque')[0];
  assert.equal(off.n, 'Biscuits cacao');
  assert.equal(off.id, 'product:3012345678901');
  assert.equal(off.packaged, true);
  assert.equal(off.source, 'off');
  assert.deepEqual(plain(off.pack), {
    total: 300,
    unite: 'g',
    unitesSuggerees: 12,
    parUniteSuggeree: null,
    labelSuggere: 'biscuit',
    suggestionConflit: false
  });
  assert.equal(Object.hasOwn(off, 'serving'), false);
  assert.deepEqual(plain(off.portions), []);
  assert.deepEqual(plain(off.meta), {
    source: 'openfoodfacts-cache',
    label: 'Produit OpenFoodFacts en cache',
    approximate: true
  });
  assert.equal(Foods.search('3012345678901')[0].id, off.id);

  const personal = Foods.search('yaourt maison')[0];
  assert.equal(personal.id, 'product:2012345678902');
  assert.equal(personal.packaged, true);
  assert.equal(personal.source, 'perso');
  assert.deepEqual(plain(personal.portions), []);
  assert.deepEqual(plain(personal.meta), {
    source: 'personal-label',
    label: "Valeur recopiée de l'étiquette",
    approximate: false
  });

  assert.equal(Foods.activeCategories().filter((cat) => cat === 'Produits connus').length, 1);
  assert.equal(Foods.search('', 'Produits connus').length, 2);
  assert.equal(Foods.search('').some((food) => food.cat === 'Produits connus'), false);
});

test('getProducts accepte aussi une liste, déduplique les codes et reste optionnel', () => {
  const withoutProducts = loadFoods({ getCustomFoods() { return []; } });
  assert.doesNotThrow(() => withoutProducts.combined());
  assert.equal(withoutProducts.activeCategories().includes('Produits connus'), false);

  const Foods = loadFoods({
    getCustomFoods() { return []; },
    getProducts() {
      return [
        { n: 'Produit un', carb: 12, code: '12345678', source: 'off' },
        { n: 'Doublon', carb: 99, code: '12345678', source: 'off' },
        { n: '', carb: 10, code: '87654321' },
        { n: 'Glucides invalides', carb: 101, code: '87654322' }
      ];
    }
  });
  assert.equal(Foods.search('', 'Produits connus').length, 1);
  assert.equal(Foods.search('produit un')[0].n, 'Produit un');
});
