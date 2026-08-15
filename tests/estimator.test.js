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

function verifiedView(viewIndex, changes) {
  const base = {
    viewIndex,
    depth: {
      scaleOk: true, fresh: true, cardMode: true,
      cardRequested: true, cardVerified: true, cardFresh: true,
      cardSchema: 'glucovision-card-v2', scaleSource: 'card',
      cardName: 'glucovision-card-v2', cardWidthCm: 8.56, cardHeightCm: 5.398,
      cardObservations: 8, cardTrackingMethod: 'FULL_TRACKING',
      fieldWidthCm: 32.4, fieldHeightCm: 24.1,
      distanceCm: 62, cmPerPixel: 0.02, volumeCm3: 1234
    },
    reference: {
      mode: 'glucovision-card-v2', cardRequested: true,
      cardVerified: true, cardFresh: true,
      cardSchema: 'glucovision-card-v2', scaleSource: 'card',
      cardName: 'glucovision-card-v2', cardWidthCm: 8.56, cardHeightCm: 5.398,
      cardObservations: 8, cardTrackingMethod: 'FULL_TRACKING'
    }
  };
  changes = changes || {};
  return {
    viewIndex: changes.viewIndex == null ? base.viewIndex : changes.viewIndex,
    depth: Object.assign({}, base.depth, changes.depth || {}),
    reference: Object.assign({}, base.reference, changes.reference || {})
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
  const got = Estimator.sanitize(value, { imageCount: 1, referenceMode: 'none' });
  assert.equal(got.totalCarbsG, 50);
  assert.match(got.blocking.join(' '), /somme des aliments/i);
});

test('une simple édition ne gomme pas les contradictions brutes', () => {
  const { Estimator } = env();
  const value = raw(50);
  value.totalCarbsG = 120;
  value.rangeLowG = 100;
  value.rangeHighG = 140;
  const got = Estimator.sanitize(value, { imageCount: 1, referenceMode: 'none' });
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
  const got = Estimator.sanitize(value, { imageCount: 1, referenceMode: 'none' });
  assert.match(got.blocking.join(' '), /en donnent 50/i);
});

test('une fourchette brute invalide bloque mais ne devient jamais la fourchette affichée', () => {
  const { Estimator } = env();
  const invalid = raw(100);
  invalid.rangeLowG = 'environ 90';
  const got = Estimator.sanitize(invalid, { imageCount: 1, referenceMode: 'none' });
  assert.deepEqual([got.rangeLowG, got.rangeHighG], [62, 166]);
  assert.match(got.blocking.join(' '), /fourchette brute/i);

  const narrow = raw(100);
  narrow.rangeLowG = 99;
  narrow.rangeHighG = 101;
  const empirical = Estimator.sanitize(narrow, { imageCount: 1, referenceMode: 'none' });
  assert.deepEqual([empirical.rangeLowG, empirical.rangeHighG], [62, 166]);

  const excludesItems = raw(50);
  excludesItems.totalCarbsG = 56; // tolérance d'arrondi du total, mais pas de la fourchette
  excludesItems.rangeLowG = 55;
  excludesItems.rangeHighG = 60;
  const contradictory = Estimator.sanitize(excludesItems,
    { imageCount: 1, referenceMode: 'none' });
  assert.match(contradictory.blocking.join(' '), /somme des aliments.*hors de la fourchette/i);
});

test('la confiance IA et le repère ne resserrent pas la bande empirique', () => {
  const { Estimator } = env();
  const high = raw(100);
  high.overallConfidence = 'high';
  high.referenceFound = true;
  const low = raw(100);
  low.overallConfidence = 'low';
  const a = Estimator.sanitize(high, {
    imageCount: 1, referenceMode: 'glucovision-card-v2', viewMeasurements: [verifiedView(1)]
  });
  const b = Estimator.sanitize(low, { imageCount: 1, referenceMode: 'none' });
  assert.deepEqual([a.rangeLowG, a.rangeHighG], [62, 166]);
  assert.deepEqual([b.rangeLowG, b.rangeHighG], [62, 166]);
});

test('un total recalculé supérieur à 400 g est bloquant', () => {
  const { Estimator } = env();
  const got = Estimator.sanitize(raw(401), { imageCount: 1, referenceMode: 'none' });
  assert.match(got.blocking.join(' '), /supérieur à 400/i);
});

test('refresh réapplique les mêmes garde-fous et permet une correction humaine', () => {
  const { Estimator } = env();
  const got = Estimator.sanitize(raw(50), { imageCount: 1, referenceMode: 'none' });
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

test('seule une Carte GlucoVision fraîche et vérifiée entre dans le prompt', () => {
  const { Estimator } = env();
  const prompt = Estimator.buildPrompt({
    imageCount: 1,
    referenceMode: 'glucovision-card-v2',
    viewMeasurements: [verifiedView(1)]
  });
  assert.match(prompt, /MESURE NATIVE VÉRIFIÉE POUR IMAGE 1\/1 UNIQUEMENT/);
  assert.match(prompt, /32\.4 × 24\.1 cm/);
  assert.match(prompt, /Ne déduis JAMAIS une masse ni des glucides/);
  assert.doesNotMatch(prompt, /1234/);

  const absent = Estimator.buildPrompt({
    imageCount: 1, referenceMode: 'glucovision-card-v2', viewMeasurements: []
  });
  assert.match(absent, /AUCUNE VUE N'A DE VÉRIFICATION NATIVE/);
  assert.doesNotMatch(absent, /MESURE NATIVE VÉRIFIÉE POUR IMAGE/);

  const stale = Estimator.buildPrompt({
    imageCount: 1, referenceMode: 'glucovision-card-v2',
    viewMeasurements: [verifiedView(1, { depth: { fresh: false } })]
  });
  assert.doesNotMatch(stale, /MESURE NATIVE VÉRIFIÉE POUR IMAGE/);

  const forged = Estimator.buildPrompt({
    imageCount: 1, referenceMode: 'glucovision-card-v2',
    viewMeasurements: [verifiedView(1, {
      depth: { cardSchema: 'evil-card', scaleSource: 'depth' }
    })]
  });
  assert.doesNotMatch(forged, /MESURE NATIVE VÉRIFIÉE POUR IMAGE/);

  const incompleteView = verifiedView(1);
  delete incompleteView.depth.cardObservations;
  delete incompleteView.depth.cardTrackingMethod;
  delete incompleteView.depth.cardWidthCm;
  delete incompleteView.reference.cardObservations;
  delete incompleteView.reference.cardTrackingMethod;
  delete incompleteView.reference.cardWidthCm;
  const incomplete = Estimator.buildPrompt({
    imageCount: 1, referenceMode: 'glucovision-card-v2',
    viewMeasurements: [incompleteView]
  });
  assert.doesNotMatch(incomplete, /MESURE NATIVE VÉRIFIÉE POUR IMAGE/);

  const disagree = Estimator.buildPrompt({
    imageCount: 1, referenceMode: 'glucovision-card-v2',
    viewMeasurements: [verifiedView(1, {
      depth: { scaleSource: 'card+depth', cardDepthCompared: true, cardDepthAgrees: false },
      reference: { scaleSource: 'card+depth', cardDepthCompared: true, cardDepthAgrees: false }
    })]
  });
  assert.doesNotMatch(disagree, /MESURE NATIVE VÉRIFIÉE POUR IMAGE/);

  /* L'ancienne carte n'est pas une variante de la v2 : son image ARCore et son
     schéma sont différents. Même une preuve v1 complète doit donc tomber vers
     le parcours visuel sans mesure, jamais être migrée silencieusement. */
  const legacyView = verifiedView(1, {
    depth: { cardSchema: 'glucovision-card-v1', cardName: 'glucovision-card' },
    reference: {
      mode: 'glucovision-card-v1',
      cardSchema: 'glucovision-card-v1',
      cardName: 'glucovision-card'
    }
  });
  const legacy = Estimator.buildPrompt({
    imageCount: 1,
    referenceMode: 'glucovision-card-v1',
    viewMeasurements: [legacyView]
  });
  assert.match(legacy, /MODE RAPIDE SANS CARTE/);
  assert.doesNotMatch(legacy, /MESURE NATIVE VÉRIFIÉE POUR IMAGE/);
});

test('deux vues natives restent associées à leurs images et ne s’annulent pas', () => {
  const { Estimator } = env();
  const prompt = Estimator.buildPrompt({
    imageCount: 3, referenceMode: 'glucovision-card-v2',
    viewMeasurements: [
      verifiedView(1),
      verifiedView(3, { depth: { fieldWidthCm: 28.7, cmPerPixel: 0.018 } })
    ]
  });
  assert.match(prompt, /IMAGE 1\/3 UNIQUEMENT/);
  assert.match(prompt, /IMAGE 3\/3 UNIQUEMENT/);
  assert.equal((prompt.match(/MESURE NATIVE VÉRIFIÉE POUR IMAGE/g) || []).length, 2);
  assert.match(prompt, /aucun autre angle/i);
});

test('referenceFound/referenceUsed forgés par l’IA ne sont jamais une preuve', () => {
  const { Estimator } = env();
  const answer = raw(50);
  answer.referenceFound = true;
  answer.referenceUsed = 'carte inventée 400 px → 0,02 cm/px';
  const withoutNative = Estimator.sanitize(answer, {
    imageCount: 1, referenceMode: 'glucovision-card-v2', viewMeasurements: []
  });
  assert.equal(withoutNative.refFound, false);
  assert.equal(withoutNative.referenceUsed, '');

  answer.referenceFound = false;
  answer.referenceUsed = 'mensonge contradictoire';
  const withNative = Estimator.sanitize(answer, {
    imageCount: 1, referenceMode: 'glucovision-card-v2',
    viewMeasurements: [verifiedView(1)]
  });
  assert.equal(withNative.refFound, true);
  assert.match(withNative.referenceUsed, /vérifiée nativement/);
  assert.doesNotMatch(withNative.referenceUsed, /mensonge/);
});
