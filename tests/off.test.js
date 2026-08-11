'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript, plain } = require('./test-env');

const Portion = loadScript('js/portion.js').Portion;

function envFor(product, responseStatus = 200) {
  const calls = [];
  const env = loadScript('js/off.js', {
    Portion,
    Storage: {
      canonicalBarcode(value) { return String(value || '').replace(/\D/g, ''); }
    },
    fetch(url) {
      calls.push(url);
      return Promise.resolve({
        ok: responseStatus >= 200 && responseStatus < 300,
        status: responseStatus,
        json: () => Promise.resolve(responseStatus === 404
          ? { status: 0 }
          : { status: 1, product })
      });
    }
  });
  return { OFF: env.OFF, calls };
}

test('OFF refuse un glucide ambigu exprimé par portion', async () => {
  const { OFF } = envFor({
    code: '12345678', product_name_fr: 'Biscuits',
    nutrition_data_per: 'serving',
    nutriments: { carbohydrates: 10 },
    serving_quantity: 25
  });
  assert.equal(await OFF.lookupBarcode('12345678'), null);
});

test('OFF accepte uniquement carbohydrates_100g et conserve sa base', async () => {
  const { OFF, calls } = envFor({
    code: '12345678', product_name_fr: 'Biscuits', brands: 'Maison test',
    nutrition_data_per: 'serving',
    nutriments: { carbohydrates: 10, carbohydrates_100g: 40 }
  });
  const food = plain(await OFF.lookupBarcode('12345678'));
  assert.equal(food.carb, 40);
  assert.equal(food.serving, null);
  assert.match(calls[0], /fields=.*nutriments/);
});

test('le nombre lu dans quantity reste une suggestion non confirmée', async () => {
  const { OFF } = envFor({
    code: '12345678', product_name_fr: 'Biscuits',
    nutriments: { carbohydrates_100g: 70 },
    quantity: '15 biscuits - 300 g',
    product_quantity: 300,
    product_quantity_unit: 'g'
  });
  const food = plain(await OFF.lookupBarcode('12345678'));
  assert.deepEqual(food.pack, {
    total: 300,
    unitesSuggerees: 15,
    parUniteSuggeree: 20,
    labelSuggere: 'biscuit',
    suggestionConflit: false,
    rawQuantity: '15 biscuits - 300 g',
    unite: 'g',
    confirme: false
  });
});

test('un poids par pièce contradictoire avec le total est signalé', async () => {
  const { OFF } = envFor({
    code: '12345678', product_name_fr: 'Biscuits',
    nutriments: { carbohydrates_100g: 65 },
    quantity: '15 biscuits x 25 g',
    product_quantity: 300,
    product_quantity_unit: 'g'
  });
  const food = plain(await OFF.lookupBarcode('12345678'));
  assert.equal(food.pack.parUniteSuggeree, 20,
    'le poids total du paquet reste la base du calcul');
  assert.equal(food.pack.suggestionConflit, true);
  assert.equal(food.pack.confirme, false);
});

test('product_quantity OFF est déjà normalisé et ne doit pas être remultiplié', async () => {
  const { OFF } = envFor({
    code: '12345678', product_name_fr: 'Farine',
    nutriments: { carbohydrates_100g: 75 },
    quantity: '1 kg', product_quantity: 1000, product_quantity_unit: 'kg'
  });
  const food = plain(await OFF.lookupBarcode('12345678'));
  assert.equal(food.pack.total, 1000);
});
