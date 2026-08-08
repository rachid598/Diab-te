'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript } = require('./test-env');

function confirmed(e) {
  return !e.draft && !e.blocked && !(e.blocking && e.blocking.length) &&
    !(e.dominantRequired && !e.dominantConfirmed) &&
    e.totalCarbsG > 0 && e.totalCarbsG <= 400;
}

function reliable(e) {
  return !e.realSource || /^(pesee|etiquette|recette)$/.test(e.realSource);
}

test('Bench.cases exclut brouillons, blocages et confirmation dominante manquante', () => {
  const base = {
    realCarbsG: 20, totalCarbsG: 18, realSource: 'pesee',
    thumb: 'data:image/jpeg;base64,aGVsbG8=', items: [{ name: 'riz', carbsG: 18 }]
  };
  const entries = [
    Object.assign({ date: 1, input: { notes: 'original', extras: 'yaourt' } }, base),
    Object.assign({ date: 2, draft: true }, base),
    Object.assign({ date: 3, blocked: true }, base),
    Object.assign({ date: 4, dominantRequired: true, dominantConfirmed: false }, base),
    Object.assign({}, base, { date: 5, realSource: 'estimation' })
  ];
  const { Bench } = loadScript('js/bench.js', {
    Storage: { getHistory: () => entries, isConfirmedMeal: confirmed, isReliableReal: reliable },
    Native: { isApp: false }
  });
  const got = Bench.cases();
  assert.equal(got.length, 1);
  assert.equal(got[0].date, 1);
  assert.equal(got[0].ctx.extras, 'yaourt');
});

test('Bench.runModel ne score jamais un résultat bloqué', async () => {
  const { Bench } = loadScript('js/bench.js', {
    Storage: { getHistory: () => [] },
    Native: { isApp: false },
    Camera: {
      processDataUrl: () => Promise.resolve({ base64: 'aGVsbG8=', mediaType: 'image/jpeg' })
    },
    Estimator: {
      estimateWith: () => Promise.resolve({ totalCarbsG: 20, blocking: ['incohérent'] })
    }
  });
  const results = await Bench.runModel(
    { provider: 'gemini', model: 'test' },
    [{ date: 1, real: 20, img: 'data:image/jpeg;base64,aGVsbG8=', ctx: {} }],
    { models: {} }
  );
  assert.equal(results[0].got, null);
  assert.match(results[0].error, /bloqué/i);
  assert.equal(Bench.score(results).n, 0);
});

test('Report.analyse exclut les entrées non confirmées et les valeurs réelles peu fiables', () => {
  const now = Date.now();
  const entries = [
    { date: now - 1000, draft: false, totalCarbsG: 30, realCarbsG: 32, realSource: 'pesee' },
    { date: now - 2000, draft: false, totalCarbsG: 40, realCarbsG: 45, realSource: 'estimation' },
    { date: now - 3000, draft: true, totalCarbsG: 50, realCarbsG: 50, realSource: 'pesee' },
    { date: now - 4000, blocked: true, totalCarbsG: 60, realCarbsG: 60, realSource: 'pesee' },
    { date: now - 5000, dominantRequired: true, dominantConfirmed: false,
      totalCarbsG: 70, realCarbsG: 70, realSource: 'pesee' },
    { date: now - 6000, draft: false, totalCarbsG: 401, realCarbsG: 100, realSource: 'pesee' }
  ];
  const { Report } = loadScript('js/report.js', {
    Storage: {
      getHistory: () => entries,
      getSettings: () => ({ partSizeG: 10 }),
      getBias: () => ({ count: 1, meanRatio: 1, pct: 0 }),
      getBiasByCategory: () => [],
      isConfirmedMeal: confirmed,
      isReliableReal: reliable
    }
  });
  const got = Report.analyse(30);
  assert.equal(got.count, 2);
  assert.equal(got.mesures, 1);
  assert.deepEqual(got.meals.map((e) => e.totalCarbsG), [40, 30]);
});
