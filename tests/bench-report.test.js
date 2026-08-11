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
  let sentContext = null;
  const { Bench } = loadScript('js/bench.js', {
    Storage: { getHistory: () => [] },
    Native: { isApp: false },
    Camera: {
      processDataUrl: () => Promise.resolve({ base64: 'aGVsbG8=', mediaType: 'image/jpeg' })
    },
    Estimator: {
      estimateWith: (provider, images, ctx) => {
        sentContext = ctx;
        return Promise.resolve({ totalCarbsG: 20, blocking: ['incohérent'] });
      }
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
  assert.equal(sentContext.referenceMode, 'none');
  assert.equal(Array.isArray(sentContext.viewMeasurements) && sentContext.viewMeasurements.length, 0);
  assert.equal('referenceObject' in sentContext, false);
  assert.equal('depth' in sentContext, false);
});

test('Bench.score rend inéligible un modèle qui échoue sur plus de 20 % des cas', () => {
  const { Bench } = loadScript('js/bench.js', {
    Storage: { getHistory: () => [] },
    Native: { isApp: false }
  });
  const sparse = [{ real: 100, got: 100, err: 0 }];
  for (let i = 0; i < 11; i++) sparse.push({ real: 100, got: null, error: 'échec' });

  const rejected = Bench.score(sparse);
  assert.equal(rejected.eligible, false);
  assert.equal(rejected.n, 0);
  assert.equal(rejected.successes, 1);
  assert.equal(rejected.total, 12);
  assert.equal(rejected.failed, 11);
  assert.equal(rejected.coveragePct, 8);

  const covered = Array.from({ length: 10 }, () => ({ real: 100, got: 105, err: 5 }));
  covered.push({ real: 100, got: null }, { real: 100, got: null });
  const accepted = Bench.score(covered);
  assert.equal(accepted.eligible, true);
  assert.equal(accepted.n, 10);
  assert.equal(accepted.successes, 10);
  assert.equal(accepted.coveragePct, 83);
  assert.equal(accepted.mape, 5);
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

test('Report.analyse calcule médiane, biais et catégories sur la période demandée', () => {
  const now = Date.now();
  const day = 86400000;
  const recent = [1, 2, 3].map((n) => ({
    date: now - n * day,
    draft: false,
    totalCarbsG: n === 1 ? 10 : (n === 2 ? 20 : 100),
    realCarbsG: n === 1 ? 5 : (n === 2 ? 10 : 50),
    realSource: 'pesee',
    items: [{ name: 'riz', carbsG: n === 1 ? 10 : (n === 2 ? 20 : 100) }]
  }));
  const old = [40, 41, 42].map((n) => ({
    date: now - n * day,
    draft: false,
    totalCarbsG: 100,
    realCarbsG: 150,
    realSource: 'pesee',
    items: [{ name: 'riz', carbsG: 100 }]
  }));
  const { Report } = loadScript('js/report.js', {
    Storage: {
      getHistory: () => recent.concat(old),
      getSettings: () => ({ partSizeG: 10 }),
      getBias: () => { throw new Error('le biais global ne doit pas être lu'); },
      getBiasByCategory: () => { throw new Error('les catégories globales ne doivent pas être lues'); },
      categoryOf: (name) => name === 'riz' ? 'Féculents' : null,
      isConfirmedMeal: confirmed,
      isReliableReal: reliable
    }
  });

  const got = Report.analyse(30);
  assert.equal(got.count, 3);
  assert.equal(got.mediane, 20);
  assert.equal(got.bias.count, 3);
  assert.equal(got.bias.medianRatio, 0.5);
  assert.equal(got.bias.pct, -50);
  assert.equal(got.byCategory.length, 1);
  assert.equal(got.byCategory[0].category, 'Féculents');
  assert.equal(got.byCategory[0].count, 3);
  assert.equal(got.byCategory[0].pct, -50);
});

test('Report.analyse moyenne les deux valeurs centrales pour une médiane paire', () => {
  const now = Date.now();
  const { Report } = loadScript('js/report.js', {
    Storage: {
      getHistory: () => [
        { date: now - 1000, draft: false, totalCarbsG: 10 },
        { date: now - 2000, draft: false, totalCarbsG: 100 }
      ],
      getSettings: () => ({ partSizeG: 10 }),
      isConfirmedMeal: confirmed,
      isReliableReal: reliable
    }
  });
  assert.equal(Report.analyse(30).mediane, 55);
});
