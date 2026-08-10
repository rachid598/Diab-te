'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript } = require('./test-env');

function raw(total) {
  return {
    seen: 'Une assiette de riz',
    items: [{
      name: 'riz blanc', estimatedMassG: total * 2,
      carbDensityPer100g: 50, carbsG: total,
      proteinG: 4, fatG: 1, kcal: total * 4,
      confidence: 'medium'
    }],
    totalCarbsG: total,
    rangeLowG: Math.max(0, total - 10),
    rangeHighG: total + 10,
    overallConfidence: 'medium',
    glycemicSpeed: 'moderee'
  };
}

function env(extra) {
  return loadScript('js/estimator.js', Object.assign({
    Storage: {
      DEFAULT_MODELS: { claude: 'claude-test' },
      getBiasByCategory() { return []; },
      getBias() { return { count: 0, pct: 0 }; },
      noteUsage() {}
    }
  }, extra || {}));
}

test('le total brut contradictoire reste bloquant après normalisation', () => {
  const { Estimator } = env();
  const value = raw(50);
  value.totalCarbsG = 120;
  value.rangeLowG = 100;
  value.rangeHighG = 140;
  const got = Estimator.sanitize(value, { imageCount: 1, referenceObject: 'none' });
  assert.equal(got.totalCarbsG, 50);
  assert.match(got.blocking.join(' '), /somme des aliments/i);
});

test('une simple édition ne gomme pas les contradictions brutes', () => {
  const { Estimator } = env();
  const value = raw(50);
  value.totalCarbsG = 120;
  value.rangeLowG = 100;
  value.rangeHighG = 140;
  const got = Estimator.sanitize(value, { imageCount: 1, referenceObject: 'none' });
  got.items[0].carbsG = 40;
  got.humanEdited = true;
  Estimator.refresh(got);
  assert.match(got.blocking.join(' '), /brut|somme des aliments/i);

  Estimator.acceptManualRecalculation(got);
  assert.equal(got.sourceBlocking.length, 0);
  assert.equal(got.blocking.length, 0);
  assert.equal(got.totalCarbsG, 40);
});

test('une contradiction 100 g × 50 % contre 80 g est bloquante', () => {
  const { Estimator } = env();
  const value = raw(80);
  value.items[0].estimatedMassG = 100;
  value.items[0].carbDensityPer100g = 50;
  const got = Estimator.sanitize(value, { imageCount: 1, referenceObject: 'none' });
  assert.match(got.blocking.join(' '), /en donnent 50/i);
});

test('une fourchette brute invalide bloque mais ne devient jamais la fourchette affichée', () => {
  const { Estimator } = env();
  const invalid = raw(100);
  invalid.rangeLowG = 'environ 90';
  const got = Estimator.sanitize(invalid, { imageCount: 1, referenceObject: 'none' });
  assert.deepEqual([got.rangeLowG, got.rangeHighG], [62, 166]);
  assert.match(got.blocking.join(' '), /fourchette brute/i);

  const narrow = raw(100);
  narrow.rangeLowG = 99;
  narrow.rangeHighG = 101;
  const empirical = Estimator.sanitize(narrow, { imageCount: 1, referenceObject: 'none' });
  assert.deepEqual([empirical.rangeLowG, empirical.rangeHighG], [62, 166]);

  const excludesItems = raw(50);
  excludesItems.totalCarbsG = 56; // tolérance d'arrondi du total, mais pas de la fourchette
  excludesItems.rangeLowG = 55;
  excludesItems.rangeHighG = 60;
  const contradictory = Estimator.sanitize(excludesItems,
    { imageCount: 1, referenceObject: 'none' });
  assert.match(contradictory.blocking.join(' '), /somme des aliments.*hors de la fourchette/i);
});

test('la confiance IA et le repère ne resserrent pas la bande empirique', () => {
  const { Estimator } = env();
  const high = raw(100);
  high.overallConfidence = 'high';
  high.referenceFound = true;
  const low = raw(100);
  low.overallConfidence = 'low';
  const a = Estimator.sanitize(high, { imageCount: 1, referenceObject: 'pompe' });
  const b = Estimator.sanitize(low, { imageCount: 1, referenceObject: 'none' });
  assert.deepEqual([a.rangeLowG, a.rangeHighG], [62, 166]);
  assert.deepEqual([b.rangeLowG, b.rangeHighG], [62, 166]);
});

test('un total recalculé supérieur à 400 g est bloquant', () => {
  const { Estimator } = env();
  const got = Estimator.sanitize(raw(401), { imageCount: 1, referenceObject: 'none' });
  assert.match(got.blocking.join(' '), /supérieur à 400/i);
});

test('refresh réapplique les mêmes garde-fous et permet une correction humaine', () => {
  const { Estimator } = env();
  const got = Estimator.sanitize(raw(50), { imageCount: 1, referenceObject: 'none' });
  got.items[0].carbsG = -2;
  Estimator.refresh(got);
  assert.match(got.blocking.join(' '), /quantité de glucides invalide/i);
  got.items[0].carbsG = 40;
  Estimator.refresh(got);
  assert.equal(got.blocking.length, 0);
  assert.deepEqual([got.totalCarbsG, got.rangeLowG, got.rangeHighG], [40, 25, 66]);
});

test('un repas composé uniquement d’extras est accepté et envoyé au modèle', async () => {
  const response = raw(20);
  const { Estimator } = env({
    fetch() {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({
          content: [{ type: 'text', text: JSON.stringify(response) }]
        }))
      });
    }
  });
  const ctx = { imageCount: 0, notes: '', extras: 'un yaourt sucré' };
  assert.equal(Estimator.hasInput([], ctx), true);
  const got = await Estimator.estimateWith('claude', [], ctx, {
    apiKeys: { claude: 'test' }, models: { claude: 'claude-test' }
  });
  assert.equal(got.totalCarbsG, 20);
});

test('l’échelle ARCore valide entre dans le prompt, jamais son volume expérimental', () => {
  const { Estimator } = env();
  const prompt = Estimator.buildPrompt({
    imageCount: 1,
    referenceObject: 'none',
    depth: {
      scaleOk: true, fieldWidthCm: 32.4, fieldHeightCm: 24.1,
      distanceCm: 30, cmPerPixel: 0.02, volumeCm3: 1234
    }
  });
  assert.match(prompt, /ÉCHELLE ARCORE EXPÉRIMENTALE VALIDÉE/);
  assert.match(prompt, /32\.4 × 24\.1 cm/);
  assert.match(prompt, /Ne déduis JAMAIS une masse ni des glucides/);
  assert.doesNotMatch(prompt, /1234/);

  const ignored = Estimator.buildPrompt({
    imageCount: 1, referenceObject: 'none',
    depth: { scaleOk: true, fieldWidthCm: -1, fieldHeightCm: 20,
      distanceCm: 30, cmPerPixel: 0.02 }
  });
  assert.doesNotMatch(ignored, /ÉCHELLE ARCORE/);

  const stale = Estimator.buildPrompt({
    imageCount: 1, referenceObject: 'none',
    depth: { scaleOk: true, fresh: false, fieldWidthCm: 30, fieldHeightCm: 20,
      distanceCm: 30, cmPerPixel: 0.02 }
  });
  assert.doesNotMatch(stale, /ÉCHELLE ARCORE/);

  const multi = Estimator.buildPrompt({
    imageCount: 3, referenceObject: 'none',
    depth: { scaleOk: true, fresh: true, viewIndex: 2,
      fieldWidthCm: 30, fieldHeightCm: 20, distanceCm: 30, cmPerPixel: 0.02 }
  });
  assert.match(multi, /IMAGE 2\/3 UNIQUEMENT/);
  assert.match(multi, /aucun autre angle/i);

  const ambiguousMulti = Estimator.buildPrompt({
    imageCount: 3, referenceObject: 'none',
    depth: { scaleOk: true, fresh: true,
      fieldWidthCm: 30, fieldHeightCm: 20, distanceCm: 30, cmPerPixel: 0.02 }
  });
  assert.doesNotMatch(ambiguousMulti, /ÉCHELLE ARCORE/);
});
