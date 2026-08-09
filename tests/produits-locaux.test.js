'use strict';

/* La base locale de produits est ce qui rend le scan utilisable quand
   OpenFoodFacts est en panne — ce qui arrive — ou quand il n'y a pas de réseau
   dans la cuisine — ce qui arrive aussi.

   Le point sensible : une saisie personnelle vient de l'emballage qu'on avait
   sous les yeux, une réponse d'OpenFoodFacts d'un inconnu. La première ne doit
   jamais être écrasée par la seconde, ni perdue à la purge. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript, plain } = require('./test-env');

function neuf() { return loadScript('js/storage.js').Storage; }

const biscuits = { n: 'Biscuits sablés', brand: 'Marque', carb: 70 };

test('un produit enregistré se relit tel quel', () => {
  const S = neuf();
  assert.equal(S.setProduct('3017620422003', biscuits, 'off'), true);
  const p = S.getProduct('3017620422003');
  assert.equal(p.n, 'Biscuits sablés');
  assert.equal(p.carb, 70);
  assert.equal(p.source, 'off');
  assert.equal(p.code, '3017620422003');
});

test('le code est normalisé : espaces et tirets ne créent pas de doublons', () => {
  const S = neuf();
  S.setProduct('3017620422003', biscuits, 'off');
  assert.ok(S.getProduct(' 3017-620-422003 '), 'même produit, saisie différente');
  assert.equal(S.countProducts(), 1);
});

test('une saisie personnelle n\'est pas écrasée par la base publique', () => {
  // Tu as lu l'étiquette. OpenFoodFacts a été rempli par quelqu'un d'autre.
  const S = neuf();
  S.setProduct('123', { n: 'Mon gâteau', carb: 42 }, 'perso');
  assert.equal(S.setProduct('123', { n: 'Autre chose', carb: 10 }, 'off'), false);
  const p = S.getProduct('123');
  assert.equal(p.n, 'Mon gâteau');
  assert.equal(p.carb, 42);
  // Mais toi, tu peux te corriger.
  assert.equal(S.setProduct('123', { n: 'Mon gâteau', carb: 45 }, 'perso'), true);
  assert.equal(S.getProduct('123').carb, 45);
});

test('un produit sans glucides exploitables n\'entre pas dans la base', () => {
  // Enregistrer 0 par défaut donnerait une dose d'insuline nulle sur un gâteau.
  const S = neuf();
  assert.equal(S.setProduct('1', { n: 'X', carb: null }, 'perso'), false);
  assert.equal(S.setProduct('2', { n: 'X', carb: 140 }, 'perso'), false, 'plus de 100 g/100 g');
  assert.equal(S.setProduct('3', { n: 'X', carb: -5 }, 'perso'), false);
  assert.equal(S.setProduct('4', { n: '   ', carb: 20 }, 'perso'), false, 'sans nom');
  assert.equal(S.setProduct('', { n: 'X', carb: 20 }, 'perso'), false, 'sans code');
  assert.equal(S.countProducts(), 0);
});

test('une entrée corrompue est ignorée, pas servie à moitié', () => {
  const S = loadScript('js/storage.js', {
    localStorage: require('./test-env').memoryStorage({
      'diabete.produits.v1': JSON.stringify({
        '111': { n: 'Sain', carb: 50 },
        '222': { n: 'Sans glucides' },
        '333': { carb: 30 },
        '444': 'pas un objet'
      })
    })
  }).Storage;
  assert.ok(S.getProduct('111'));
  assert.equal(S.getProduct('222'), null);
  assert.equal(S.getProduct('333'), null);
  assert.equal(S.getProduct('444'), null);
});

test('la recherche locale ignore accents et casse', () => {
  const S = neuf();
  S.setProduct('1', { n: 'Pâtes Panzani', brand: 'Panzani', carb: 70 }, 'off');
  S.setProduct('2', { n: 'Riz Taureau Ailé', brand: '', carb: 78 }, 'off');
  assert.equal(S.searchProducts('pates').length, 1, '« pates » doit trouver « Pâtes »');
  assert.equal(S.searchProducts('PÂTES').length, 1);
  assert.equal(S.searchProducts('panzani').length, 1, 'la marque compte aussi');
  assert.equal(S.searchProducts('aile').length, 1);
  assert.equal(S.searchProducts('a').length, 0, 'une seule lettre ne cherche pas');
  assert.equal(S.searchProducts('couscous').length, 0);
});

test('la purge sacrifie les réponses publiques avant tes saisies', () => {
  /* Une réponse d'OpenFoodFacts se retrouve d'un scan. Ce que tu as recopié à
     la main serait perdu pour de bon : c'est donc ça qu'il faut garder.

     La saisie personnelle est datée de 1 — la PLUS ancienne de toutes. Un tri
     par seule ancienneté la supprimerait en premier ; c'est exactement ce que ce
     test doit interdire. Les enregistrer par une boucle d'appels ne testerait
     rien : Date.now() renverrait la même milliseconde pour tous, et l'ordre
     d'insertion sauverait l'entrée par accident. */
  const seed = { '999999': { n: 'Recopié à la main', carb: 33, source: 'perso', ts: 1 } };
  for (let i = 0; i < 500; i++) {
    seed[String(1000000 + i)] = { n: 'Public ' + i, carb: 20, source: 'off', ts: 2000 + i };
  }
  const S = loadScript('js/storage.js', {
    localStorage: require('./test-env').memoryStorage({
      'diabete.produits.v1': JSON.stringify(seed)
    })
  }).Storage;

  assert.equal(S.countProducts(), 501, 'au départ, une de trop');
  S.setProduct('7777', { n: 'Le scan de trop', carb: 12 }, 'off');

  assert.equal(S.countProducts(), 500, 'la base est bornée');
  assert.ok(S.getProduct('999999'), 'la saisie personnelle a survécu');
  assert.equal(S.getProduct('999999').carb, 33);
  assert.equal(S.getProduct('1000000'), null, 'la plus ancienne réponse publique est partie');
});

test('le poids du paquet traverse l\'enregistrement', () => {
  // C'est lui qui préremplit le calcul de portion au scan suivant.
  const S = neuf();
  S.setProduct('5', { n: 'Boîte', carb: 60, pack: { total: 500, unites: 12, unite: 'g' } }, 'off');
  assert.deepEqual(plain(S.getProduct('5').pack), { total: 500, unites: 12, unite: 'g' });
});

test('l\'emballage compté à la main est mémorisé et relu', () => {
  const S = neuf();
  assert.equal(S.setPackaging('3017620422003', { total: 500, unites: 12, label: 'biscuits' }), true);
  const p = S.getPackaging('3017620422003');
  assert.equal(p.total, 500);
  assert.equal(p.unites, 12);
  assert.equal(p.label, 'biscuits');
  assert.equal(p.unite, 'g');
  assert.equal(S.getPackaging('0000'), null);
  assert.equal(S.setPackaging('1', { total: 500, unites: 0 }), false, 'zéro unité n\'a pas de sens');
});
