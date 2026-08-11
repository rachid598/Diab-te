'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript, memoryStorage, plain } = require('./test-env');

const KEY = 'diabete.queue.v1';

function queueEnv(options) {
  options = options || {};
  const store = options.storage || memoryStorage();
  const files = new Map(Object.entries(options.files || {}));
  const deleted = [];
  let writes = 0;
  const Filesystem = {
    writeFile(args) {
      writes++;
      files.set(args.path, args.data);
      if (options.failWriteAt === writes) return Promise.reject(new Error('disk full'));
      return Promise.resolve({ uri: args.path });
    },
    readFile(args) {
      if (!files.has(args.path)) return Promise.reject(new Error('missing'));
      return Promise.resolve({ data: files.get(args.path) });
    },
    deleteFile(args) {
      deleted.push(args.path);
      files.delete(args.path);
      return Promise.resolve();
    }
  };
  const sandbox = loadScript('js/queue.js', {
    localStorage: store,
    Native: { isApp: true },
    Cap: { Filesystem, Directory: { Data: 'DATA' } }
  });
  return { Queue: sandbox.Queue, store, files, deleted };
}

function verifiedView(viewIndex, changes) {
  const depth = Object.assign({
    scaleOk: true, fresh: true, cardMode: true,
    cardRequested: true, cardVerified: true, cardFresh: true,
    cardSchema: 'glucovision-card-v1', scaleSource: 'card',
    cardName: 'glucovision-card', cardWidthCm: 8.56, cardHeightCm: 5.398,
    cardObservations: 9, cardTrackingMethod: 'FULL_TRACKING',
    fieldWidthCm: 30, fieldHeightCm: 20, distanceCm: 60, cmPerPixel: 0.02,
    volumeCm3: 1000
  }, changes && changes.depth || {});
  const reference = Object.assign({
    mode: 'glucovision-card-v1', cardRequested: true,
    cardVerified: true, cardFresh: true,
    cardSchema: 'glucovision-card-v1', scaleSource: 'card',
    cardName: 'glucovision-card', cardWidthCm: 8.56, cardHeightCm: 5.398,
    cardObservations: 9, cardTrackingMethod: 'FULL_TRACKING'
  }, changes && changes.reference || {});
  return { viewIndex, depth, reference };
}

test('add valide le base64, borne le contexte et persiste des chemins internes', async () => {
  const { Queue } = queueEnv();
  const mealAt = 1_786_406_400_000;
  const id = await Queue.add([{ base64: 'aGVsbG8=', mediaType: 'image/jpeg' }], {
    notes: 'riz', extras: 'yaourt', imageCount: 99,
    mealAt, venue: 'restaurant', clarificationAnswered: true,
    referenceMode: 'glucovision-card-v1', viewMeasurements: [verifiedView(1)]
  });
  assert.match(id, /^q\d{10,16}-[a-z0-9]{6,16}$/);
  const item = plain(Queue.list()[0]);
  assert.equal(item.files[0].file, `queue/${id}-0.jpg`);
  assert.equal(item.ctx.imageCount, 1);
  assert.equal(item.ctx.referenceMode, 'glucovision-card-v1');
  assert.equal(item.ctx.viewMeasurements[0].depth.fieldWidthCm, 30);
  assert.equal(item.ctx.viewMeasurements[0].viewIndex, 1);
  assert.equal(item.ctx.viewMeasurements[0].depth.cardObservations, 9);
  assert.equal(item.ctx.mealAt, mealAt);
  assert.equal(item.ctx.venue, 'restaurant');
  assert.equal(item.ctx.clarificationAnswered, true);
});

test('la file conserve toutes les mesures par vue et rejette les preuves forgées', async () => {
  const twoImages = [
    { base64: 'aGVsbG8=', mediaType: 'image/jpeg' },
    { base64: 'd29ybGQ=', mediaType: 'image/jpeg' }
  ];
  const valid = queueEnv();
  await valid.Queue.add(twoImages, {
    referenceMode: 'glucovision-card-v1',
    viewMeasurements: [
      verifiedView(1),
      verifiedView(2, { depth: { fieldWidthCm: 28, scaleSource: 'card+depth',
          cardDepthCompared: true, cardDepthAgrees: true },
        reference: { scaleSource: 'card+depth',
          cardDepthCompared: true, cardDepthAgrees: true } })
    ]
  });
  const saved = valid.Queue.list()[0];
  assert.deepEqual(saved.ctx.viewMeasurements.map((v) => v.viewIndex), [1, 2]);
  assert.equal(saved.ctx.viewMeasurements[1].depth.fieldWidthCm, 28);
  assert.equal(saved.ctx.viewMeasurements[1].reference.scaleSource, 'card+depth');
  const loaded = await valid.Queue.load(saved);
  assert.equal(loaded[0].reference.cardVerified, true);
  assert.equal(loaded[1].depth.fieldWidthCm, 28);

  const forged = queueEnv();
  await forged.Queue.add(twoImages, {
    referenceMode: 'glucovision-card-v1',
    viewMeasurements: [
      verifiedView(1, { depth: { fresh: false } }),
      verifiedView(2, { reference: { cardVerified: false } })
    ]
  });
  assert.deepEqual(forged.Queue.list()[0].ctx.viewMeasurements, []);
});

test('une écriture partielle supprime tous les fichiers tentés et ne crée pas d’entrée', async () => {
  const { Queue, files, deleted } = queueEnv({ failWriteAt: 2 });
  await assert.rejects(Queue.add([
    { base64: 'aGVsbG8=', mediaType: 'image/jpeg' },
    { base64: 'd29ybGQ=', mediaType: 'image/png' }
  ], {}), /disk full/);
  assert.equal(Queue.count(), 0);
  assert.equal(files.size, 0);
  assert.equal(deleted.length, 2);
});

test('les chemins forgés sont rejetés à la lecture et au chargement', async () => {
  const raw = {
    id: 'q1700000000000', date: Date.now(),
    files: [{ file: '../../secret', mediaType: 'image/jpeg' }], ctx: {}
  };
  const store = memoryStorage({ [KEY]: JSON.stringify([raw]) });
  const { Queue } = queueEnv({ storage: store });
  assert.equal(Queue.list().length, 0);
  await assert.rejects(Queue.load(raw), /invalide/i);
});

test('remove ne touche pas aux fichiers si la persistance de l’index échoue', async () => {
  const id = 'q1700000000000';
  const path = `queue/${id}-0.jpg`;
  const store = memoryStorage({
    [KEY]: JSON.stringify([{
      id, date: Date.now(), files: [{ file: path, mediaType: 'image/jpeg' }], ctx: {}
    }])
  }, { failKey: KEY, failCount: Infinity });
  const { Queue, files, deleted } = queueEnv({ storage: store, files: { [path]: 'aGVsbG8=' } });
  assert.equal(await Queue.remove(id), false);
  assert.equal(files.has(path), true);
  assert.equal(deleted.length, 0);
  assert.equal(JSON.parse(store.getItem(KEY)).length, 1);
});

test('remove persiste avant de supprimer et attend le nettoyage des fichiers', async () => {
  const id = 'q1700000000000';
  const path = `queue/${id}-0.jpg`;
  const events = [];
  const store = memoryStorage({
    [KEY]: JSON.stringify([{
      id, date: Date.now(), files: [{ file: path, mediaType: 'image/jpeg' }], ctx: {}
    }])
  });
  const originalSet = store.setItem.bind(store);
  store.setItem = (key, value) => { events.push('persist'); originalSet(key, value); };
  const files = new Map([[path, 'aGVsbG8=']]);
  const sandbox = loadScript('js/queue.js', {
    localStorage: store,
    Native: { isApp: true },
    Cap: {
      Directory: { Data: 'DATA' },
      Filesystem: {
        deleteFile(args) { events.push('delete'); files.delete(args.path); return Promise.resolve(); },
        readFile: () => Promise.reject(new Error('unused')),
        writeFile: () => Promise.reject(new Error('unused'))
      }
    }
  });
  assert.equal(await sandbox.Queue.remove(id), true);
  assert.deepEqual(events, ['persist', 'delete']);
  assert.equal(files.size, 0);
});

test('prune ne supprime plus les repas selon leur âge', async () => {
  const id = 'q1700000000000';
  const path = `queue/${id}-0.jpg`;
  const store = memoryStorage({
    [KEY]: JSON.stringify([{
      id, date: 1, files: [{ file: path, mediaType: 'image/jpeg' }], ctx: {}
    }])
  });
  const { Queue } = queueEnv({ storage: store, files: { [path]: 'aGVsbG8=' } });
  assert.equal(await Queue.prune(), 0);
  assert.equal(Queue.count(), 1);
});
