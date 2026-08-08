'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript, memoryStorage, plain } = require('./test-env');

const K = {
  usage: 'diabete.usage.v1',
  settings: 'diabete.settings.v1',
  history: 'diabete.history.v1'
};

function env(storage, Native) {
  return loadScript('js/storage.js', {
    localStorage: storage || memoryStorage(),
    Native: Native || { isApp: false }
  });
}

function history(entries) {
  return memoryStorage({ [K.history]: JSON.stringify(entries) });
}

test('les rôles v66-v72 et experimentalDepth restent normalisés', () => {
  const { Storage } = env();
  const settings = Storage.getSettings();
  assert.equal(settings.provider, 'gemini');
  assert.equal(settings.verificationMode, 'ask');
  assert.equal(settings.verifyProvider, 'openrouter');
  assert.equal(settings.doubtProvider, 'claude');
  assert.equal(settings.rolesV66, true);
  assert.equal(settings.experimentalDepth, false);
});

test('foodKey et sameFood distinguent strictement pomme et pomme de terre', () => {
  const { Storage } = env();
  assert.equal(Storage.foodKey('Pommes de terre rôties'), 'pomme_de_terre');
  assert.equal(Storage.foodKey('riz blanc long grain'), 'riz');
  assert.equal(Storage.sameFood('pomme', 'pomme de terre'), false);
  assert.equal(Storage.sameFood('riz blanc', 'riz basmati'), true);
  assert.equal(Storage.sameFood('poulet grillé', 'filet de poulet'), true);
});

test('matchFoods est un appariement un-à-un avec les non-appariés explicites', () => {
  const { Storage } = env();
  const rice = { name: 'riz blanc', carbsG: 20 };
  const got = Storage.matchFoods([rice, { name: 'riz blanc', carbsG: 10 }], [
    { name: 'riz blanc', carbsG: 25 }
  ]);
  assert.equal(got.pairs.length, 1);
  assert.equal(got.onlyA.length, 1);
  assert.equal(got.onlyB.length, 0);
  assert.equal(got.coverageA, 0.5);
});

test('une fusion sauvegardée n’est restaurée que si ses quatre traces concordent', () => {
  const { Storage } = env();
  const entry = { totalCarbsG: 55, mergedFrom: [50, 60] };
  const snapshot = { mergedTotalCarbsG: 55, verifyTotalCarbsG: 60 };
  const result = { totalCarbsG: 50 };
  const verification = { ok: true, total: 60 };
  assert.deepEqual(plain(Storage.validateStoredMerge(entry, snapshot, result, verification)), {
    primaryTotal: 50, verifyTotal: 60, mergedTotal: 55
  });
  assert.equal(Storage.validateStoredMerge(
    Object.assign({}, entry, { totalCarbsG: 54 }), snapshot, result, verification
  ), null);
  assert.equal(Storage.validateStoredMerge(
    entry, snapshot, result, { ok: true, total: 61 }
  ), null);
});

test('findSimilarMeal refuse pomme/pomme de terre et les repas non confirmés', () => {
  const entries = [
    { date: 4, draft: false, totalCarbsG: 25, realCarbsG: 26, realSource: 'pesee',
      items: [{ name: 'pomme', carbsG: 25 }] },
    { date: 3, draft: false, blocked: true, totalCarbsG: 30, realCarbsG: 31,
      realSource: 'pesee', items: [{ name: 'pomme', carbsG: 30 }] },
    { date: 2, draft: false, dominantRequired: true, dominantConfirmed: false,
      totalCarbsG: 30, realCarbsG: 31, realSource: 'pesee',
      items: [{ name: 'pomme', carbsG: 30 }] },
    { date: 1, draft: false, totalCarbsG: 25, realCarbsG: 28, realSource: 'pesee',
      items: [{ name: 'pomme de terre', carbsG: 25 }] }
  ];
  const { Storage } = env(history(entries));
  const apple = Storage.findSimilarMeal([{ name: 'pomme', carbsG: 24 }], 24);
  assert.equal(apple.date, 4);
  assert.equal(Storage.findSimilarMeal([{ name: 'pomme de terre', carbsG: 24 }], 24).date, 1);
  assert.equal(Storage.findSimilarMeal([{ name: 'poire', carbsG: 24 }], 24), null);
});

test('le biais est une médiane bornée et ignore brouillons, blocages et non-confirmés', () => {
  const good = [0.8, 0.9, 1, 1.1, 10].map((ratio, i) => {
    const estimated = i === 4 ? 10 : 100;
    return {
      date: i + 1, draft: false, totalCarbsG: estimated,
      realCarbsG: estimated * ratio, realSource: 'pesee',
      items: [{ name: 'riz', carbsG: estimated }]
    };
  });
  const ignored = [
    { date: 20, draft: true, totalCarbsG: 10, realCarbsG: 100, realSource: 'pesee' },
    { date: 21, draft: false, blocked: true, totalCarbsG: 10, realCarbsG: 100, realSource: 'pesee' },
    { date: 22, draft: false, dominantRequired: true, dominantConfirmed: false,
      totalCarbsG: 10, realCarbsG: 100, realSource: 'pesee' },
    { date: 23, draft: false, totalCarbsG: 10, realCarbsG: 100, realSource: 'estimation' }
  ];
  const { Storage } = env(history(good.concat(ignored)));
  const bias = Storage.getBias();
  assert.equal(bias.count, 5);
  assert.equal(bias.medianRatio, 1);
  assert.equal(bias.meanRatio, 1);
  assert.equal(bias.pct, 0);
});

test('une écriture d’historique en échec renvoie null et ne prétend pas avoir persisté', () => {
  const store = history([{ date: 1, totalCarbsG: 10, items: [] }]);
  store._state.failKey = K.history;
  const { Storage } = env(store);
  const saved = Storage.addHistory({ date: 2, totalCarbsG: 20, items: [] });
  assert.equal(saved, null);
  assert.deepEqual(plain(Storage.getHistory()).map((e) => e.date), [1]);
});

test('setHistoryReal ne confirme jamais un brouillon et les dates absentes échouent fermé', () => {
  const store = history([{
    date: 1, draft: true, blocked: true, dominantRequired: true,
    dominantConfirmed: false, totalCarbsG: 20, items: []
  }]);
  const { Storage } = env(store);
  const saved = Storage.setHistoryReal(1, 22, 'pesee');
  assert.ok(saved);
  const entry = Storage.getHistory()[0];
  assert.equal(entry.draft, true);
  assert.equal(entry.blocked, true);
  assert.equal(entry.realCarbsG, 22);
  assert.equal(Storage.setHistoryReal(999, 10, 'pesee'), null);
  assert.equal(Storage.updateHistory(999, { draft: false }), null);
});

test('les exports ne contiennent jamais les clés API, y compris l’ancien champ unique', () => {
  const store = memoryStorage({
    [K.settings]: JSON.stringify({
      provider: 'claude', apiKey: 'legacy-secret',
      apiKeys: { claude: 'new-secret' }, rolesV66: true
    })
  });
  const { Storage } = env(store);
  const exported = Storage.exportAll();
  const serialized = JSON.stringify(exported);
  assert.equal(exported.formatVersion, 3);
  assert.equal(exported.containsApiKeys, false);
  assert.doesNotMatch(serialized, /legacy-secret|new-secret/);
  assert.equal('apiKeys' in exported.data.settings, false);
});

test('saveSettings échoue fermé si le Keystore refuse et laisse le blob local intact', async () => {
  const original = JSON.stringify({ provider: 'gemini', rolesV66: true });
  const store = memoryStorage({ [K.settings]: original });
  const Native = {
    isApp: true,
    secure: {
      load: () => Promise.resolve({}),
      save: () => Promise.reject(new Error('keystore indisponible'))
    },
    photos: { prune: () => Promise.resolve(0) }
  };
  const { Storage } = env(store, Native);
  assert.equal(await Storage.hydrate(), true);
  await assert.rejects(Storage.saveSettings({
    provider: 'claude', apiKeys: { claude: 'secret' }, rolesV66: true
  }), /keystore/i);
  assert.equal(store.getItem(K.settings), original);
});

test('hydrate ne réactive pas une clé en clair et interdit l’enregistrement si le Keystore est illisible', async () => {
  const store = memoryStorage({
    [K.settings]: JSON.stringify({ apiKeys: { claude: 'plaintext-secret' }, rolesV66: true })
  });
  const { Storage } = env(store, {
    isApp: true,
    secure: { load: () => Promise.reject(new Error('locked')), save: () => Promise.resolve(true) },
    photos: { prune: () => Promise.resolve(0) }
  });
  assert.equal(await Storage.hydrate(), false);
  assert.equal(Storage.getSettings().apiKeys.claude, '');
  await assert.rejects(Storage.saveSettings({
    provider: 'claude', apiKeys: { claude: '' }, rolesV66: true
  }), /Keystore illisible/i);
});

test('hydrate efface encore une ancienne copie en clair quand la clé est déjà dans le Keystore', async () => {
  const store = memoryStorage({
    [K.settings]: JSON.stringify({ apiKeys: { claude: 'secret' }, rolesV66: true })
  });
  let secureWrites = 0;
  const { Storage } = env(store, {
    isApp: true,
    secure: {
      load: () => Promise.resolve({ claude: 'secret' }),
      save: () => { secureWrites++; return Promise.resolve(true); }
    },
    photos: { prune: () => Promise.resolve(0) }
  });
  assert.equal(await Storage.hydrate(), true);
  assert.equal(secureWrites, 0);
  assert.equal(JSON.parse(store.getItem(K.settings)).apiKeys.claude, '');
  assert.equal(Storage.getSettings().apiKeys.claude, 'secret');
});

test('importAll est asynchrone et restaure les écritures précédentes si une étape échoue', async () => {
  const oldUsage = JSON.stringify({ old: true });
  const oldHistory = JSON.stringify([{ date: 1, totalCarbsG: 10, items: [] }]);
  const store = memoryStorage({ [K.usage]: oldUsage, [K.history]: oldHistory }, {
    failKey: K.history,
    failCount: 1
  });
  const { Storage } = env(store);
  const promise = Storage.importAll({
    app: 'GlucoVision',
    data: {
      usage: { newer: true },
      history: [{ date: 2, totalCarbsG: 20, items: [] }]
    }
  });
  assert.equal(typeof promise.then, 'function');
  await assert.rejects(promise, /historique|history|écrire/i);
  assert.equal(store.getItem(K.usage), oldUsage);
  assert.equal(store.getItem(K.history), oldHistory);
});

test('la reprise conserve les champs v72 et ARCore sans accepter de faux booléens', () => {
  const store = history([{
    date: 1, totalCarbsG: 20, draft: false,
    dominantRequired: true, dominantConfirmed: 'oui',
    resultSnapshot: { totalCarbsG: 20, items: [{ name: 'riz', carbsG: 20 }] },
    input: { depth: { scaleOk: true, fieldWidthCm: 30 } },
    verification: { model: 'x', items: [{ name: 'riz', carbsG: 19 }] }
  }]);
  const { Storage } = env(store);
  const got = plain(Storage.getHistory()[0]);
  assert.equal(got.dominantRequired, true);
  assert.equal(got.dominantConfirmed, false);
  assert.equal(got.input.depth.fieldWidthCm, 30);
  assert.equal(got.resultSnapshot.items[0].name, 'riz');
  assert.equal(got.verification.items[0].carbsG, 19);
});
