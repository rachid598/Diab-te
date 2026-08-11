'use strict';

/* La base locale de produits est ce qui rend le scan utilisable quand
   OpenFoodFacts est en panne — ce qui arrive — ou quand il n'y a pas de réseau
   dans la cuisine — ce qui arrive aussi.

   Le point sensible : une saisie personnelle vient de l'emballage qu'on avait
   sous les yeux, une réponse d'OpenFoodFacts d'un inconnu. La première ne doit
   jamais être écrasée par la seconde, ni perdue à la purge. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript, memoryStorage, plain } = require('./test-env');

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
  assert.ok(p.ts > 1_000_000_000_000,
    'la date réelle du scan reste exploitable pour trier et purger le cache');
});

test('le code est normalisé : espaces et tirets ne créent pas de doublons', () => {
  const S = neuf();
  S.setProduct('3017620422003', biscuits, 'off');
  assert.ok(S.getProduct(' 3017-620-422003 '), 'même produit, saisie différente');
  assert.equal(S.countProducts(), 1);
});

test('la normalisation locale suit Open Food Facts sans extraire les chiffres d’un QR', () => {
  const S = neuf();
  assert.equal(S.canonicalBarcode('034000470693'), '0034000470693', 'UPC-A vers EAN-13');
  assert.equal(S.canonicalBarcode('0034000470693'), '0034000470693');
  assert.equal(S.canonicalBarcode(' 3017-620-422003 '), '3017620422003');
  assert.equal(S.canonicalBarcode('12345670'), '12345670', 'EAN-8 conservé');
  assert.equal(S.canonicalBarcode('https://exemple.test/3017620422003'), null);
  assert.equal(S.canonicalBarcode('QR:3017620422003'), null);
  assert.equal(S.setProduct('https://exemple.test/3017620422003', biscuits, 'off'), false);
});

test('la clé GTIN sert d’avertissement sans décider si le produit est accepté', () => {
  const S = neuf();
  assert.equal(S.barcodeChecksumValid('3017620422003'), true);
  assert.equal(S.barcodeChecksumValid('3017620422004'), false);
  assert.equal(S.barcodeChecksumValid('QR:3017620422003'), null);
  assert.equal(S.setProduct('3017620422004', biscuits, 'off'), true,
    'une clé douteuse avertit, mais certains producteurs utilisent des codes non conformes');
});

test('un ancien UPC brut est retrouvé puis migré sous la clé OFF canonique', () => {
  const store = memoryStorage({
    'diabete.produits.v1': JSON.stringify({
      '034000470693': { n: 'Produit UPC', carb: 50, source: 'off', ts: 10 }
    })
  });
  const S = loadScript('js/storage.js', { localStorage: store }).Storage;
  assert.equal(S.getProduct('0034000470693').n, 'Produit UPC');
  assert.equal(S.getProduct('034000470693').code, '0034000470693');
  const saved = JSON.parse(store.getItem('diabete.produits.v1'));
  assert.deepEqual(Object.keys(saved), ['0034000470693']);
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

test('getProducts borne, trie et déduplique les variantes d’un même code', () => {
  const store = memoryStorage({
    'diabete.produits.v1': JSON.stringify({
      '034000470693': { n: 'Ancien public', carb: 10, source: 'off', ts: 20 },
      '0034000470693': { n: 'Vérifié', carb: 42, source: 'perso', ts: 10 },
      '3017620422003': { n: 'Deuxième', carb: 30, source: 'off', ts: 30 }
    })
  });
  const S = loadScript('js/storage.js', { localStorage: store }).Storage;
  const all = S.getProducts();
  assert.equal(all.length, 2);
  assert.equal(all.find((p) => p.code === '0034000470693').n, 'Vérifié',
    'la saisie personnelle gagne aussi lors de la migration d’alias');
  assert.deepEqual(plain(S.getProducts(1).map((p) => p.n)), ['Deuxième']);
  assert.deepEqual(plain(S.getProducts(0)), []);
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
  assert.ok(S.getProduct('7777'), 'le produit qui vient d’être scanné ne se supprime pas lui-même');
  assert.equal(S.getProduct('1000000'), null, 'la plus ancienne réponse publique est partie');
});

test('le poids du paquet traverse l\'enregistrement', () => {
  // Une suggestion OFF reste explicitement non confirmée dans le cache produit.
  const S = neuf();
  S.setProduct('5', { n: 'Boîte', carb: 60, pack: {
    total: 500, unite: 'g', unitesSuggerees: 12, parUniteSuggeree: 41.67,
    labelSuggere: 'biscuits', suggestionConflit: true, rawQuantity: '12 biscuits, 500 g'
  } }, 'off');
  assert.deepEqual(plain(S.getProduct('5').pack), {
    total: 500, unite: 'g', unitesSuggerees: 12, parUniteSuggeree: 41.67,
    labelSuggere: 'biscuits', suggestionConflit: true, confirme: false,
    rawQuantity: '12 biscuits, 500 g'
  });
  assert.equal(S.getPackaging('5'), null, 'une suggestion produit ne devient jamais une unité confirmée');
});

test('l\'emballage compté à la main est mémorisé et relu', () => {
  const S = neuf();
  assert.equal(S.setPackaging('3017620422003', { total: 500, unites: 12, label: 'biscuits' }), true);
  const p = S.getPackaging('3017620422003');
  assert.equal(p.total, 500);
  assert.equal(p.unites, 12);
  assert.equal(p.label, 'biscuits');
  assert.equal(p.unite, 'g');
  assert.equal(p.confirmed, true);
  assert.equal(p.methode, 'paquet');
  assert.equal(p.method, 'user');
  assert.equal(p.fingerprint, 'g:500');
  assert.deepEqual(plain(S.getPackageFacts('3017620422003')), {
    total: 500, unite: 'g', source: 'user', fingerprint: 'g:500'
  });
  assert.equal(S.getUnitDefinition('3017620422003').unites, 12);
  assert.equal(S.getPackaging('0000'), null);
  assert.equal(S.setPackaging('1', { total: 500, unites: 0 }), false, 'zéro unité n\'a pas de sens');
});

test('une unité confirmée est invalidée si le format du paquet change', () => {
  const S = neuf();
  S.setPackaging('034000470693', { total: 500, unites: 12, label: 'biscuits', unite: 'g' });
  assert.equal(S.getPackaging('0034000470693', { total: 500, unite: 'g' }).unites, 12);
  assert.equal(S.getPackaging('0034000470693', { total: 600, unite: 'g' }), null,
    '12 unités comptées dans 500 g ne valent pas confirmation pour 600 g');

  assert.equal(S.setPackageFacts('0034000470693', {
    total: 600, unite: 'g', source: 'off', rawQuantity: '600 g'
  }), true);
  assert.equal(S.getPackaging('034000470693'), null, 'la définition périmée a été retirée');
  assert.equal(S.setUnitDefinition('034000470693', {
    unites: 15, label: 'biscuits', fingerprint: 'g:600'
  }), true);
  const fresh = S.getPackaging('0034000470693');
  assert.equal(fresh.unites, 15);
  assert.equal(fresh.methode, 'paquet');
  assert.equal(fresh.method, 'user');
  assert.equal(fresh.fingerprint, 'g:600');
});

test('un ancien emballage utilisateur migre comme définition confirmée', () => {
  const store = memoryStorage({
    'diabete.emballages.v1': JSON.stringify({
      '034000470693': { total: 500, unites: 12, label: 'biscuits', unite: 'g', ts: 123 }
    })
  });
  const S = loadScript('js/storage.js', { localStorage: store }).Storage;
  const p = S.getPackaging('0034000470693');
  assert.equal(p.confirmed, true);
  assert.equal(p.methode, 'paquet');
  assert.equal(p.method, 'legacy');
  assert.equal(p.fingerprint, 'g:500');
  const saved = JSON.parse(store.getItem('diabete.emballages.v1'));
  assert.equal(saved['0034000470693'].v, 2);
  assert.equal(saved['0034000470693'].unit.confirmed, true);
  assert.equal(saved['0034000470693'].unit.methode, 'paquet');
  assert.equal(saved['0034000470693'].unit.source, 'legacy');
  assert.equal(saved['034000470693'], undefined);
});

test('le poids direct d’une unité se confirme sans inventer un poids de paquet', () => {
  const store = require('./test-env').memoryStorage();
  let writes = 0;
  const setItem = store.setItem.bind(store);
  store.setItem = function (key, value) { writes++; return setItem(key, value); };
  const S = loadScript('js/storage.js', { localStorage: store }).Storage;
  assert.equal(S.setPackaging('3017620422003', {
    methode: 'unite', parUnite: 18.5, total: NaN, unites: NaN,
    label: 'biscuit', unite: 'g'
  }), true);
  const writesAfterSave = writes;
  const p = S.getPackaging('3017620422003');
  assert.equal(p.methode, 'unite');
  assert.equal(p.parUnite, 18.5);
  assert.equal(p.total, null);
  assert.equal(p.unites, null);
  assert.equal(p.fingerprint, 'unit:g:18.5');
  assert.equal(p.fingerprintTotal, null);
  assert.equal(p.confirmed, true);
  assert.equal(S.getPackageFacts('3017620422003'), null);
  assert.equal(S.getUnitDefinition('3017620422003').parUnite, 18.5);
  assert.equal(writes, writesAfterSave,
    'une définition directe v2 avec package:null ne doit pas être remigrée à chaque lecture');

  // Un poids direct reste valable si OFF corrige ensuite le poids total du paquet.
  assert.equal(S.setPackageFacts('3017620422003', { total: 222, unite: 'g', source: 'off' }), true);
  assert.equal(S.getPackaging('3017620422003').parUnite, 18.5);
  assert.equal(S.getPackaging('3017620422003').fingerprint, 'unit:g:18.5');
});
