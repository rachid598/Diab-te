'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadScript } = require('./test-env');

const ROOT = path.resolve(__dirname, '..');

function manifest(overrides) {
  return Object.assign({
    appVersion: 73,
    version: '1.73.0',
    minNativeBuild: 2073,
    url: 'https://github.com/rachid598/Diab-te/releases/download/ota-v73/www.zip',
    checksum: 'a'.repeat(64)
  }, overrides || {});
}

function env(options) {
  options = options || {};
  const downloads = [];
  const Cap = {
    Capacitor: {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      convertFileSrc: (value) => value
    },
    CapacitorHttp: {
      request: () => Promise.resolve({
        status: options.status || 200,
        data: options.manifest || manifest()
      })
    },
    App: { getInfo: () => Promise.resolve({ build: String(options.build || 2073) }) },
    CapacitorUpdater: {
      download: (value) => { downloads.push(value); return Promise.resolve({ id: 'bundle-73' }); },
      set: () => Promise.resolve(),
      notifyAppReady: () => Promise.resolve()
    },
    SecureStorage: {
      get: options.secureGet || (() => Promise.resolve(null)),
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(false)
    },
    DepthScan: options.depth || {
      available: () => Promise.resolve({ supported: true, installed: true }),
      capture: () => Promise.resolve({ cancelled: true })
    },
    Directory: {
      Data: 'DATA', Cache: 'CACHE', Documents: 'DOCUMENTS', External: 'EXTERNAL'
    },
    Filesystem: options.filesystem
  };
  const sandbox = loadScript('js/native.js', { Cap, URL });
  sandbox._downloads = downloads;
  return sandbox;
}

test('le manifeste OTA immuable valide conserve son SHA-256 au téléchargement', async () => {
  const sandbox = env();
  const status = await sandbox.Native.update.check('https://example.test/latest.json', 72);
  assert.equal(status.kind, 'available');
  const bundle = await sandbox.Native.update.download(status);
  assert.equal(bundle.id, 'bundle-73');
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox._downloads[0])), {
    url: manifest().url,
    version: '1.73.0',
    checksum: 'a'.repeat(64)
  });
});

test('l’OTA refuse une URL externe et un manifeste sans empreinte', async () => {
  await assert.rejects(
    env({ manifest: manifest({ url: 'https://evil.example/www.zip' }) })
      .Native.update.check('https://example.test/latest.json', 72),
    /URL OTA refusée/i
  );
  await assert.rejects(
    env({ manifest: manifest({ checksum: '' }) })
      .Native.update.check('https://example.test/latest.json', 72),
    /SHA-256/i
  );
});

test('un bundle trop récent exige le nouvel APK au lieu de s’appliquer', async () => {
  const status = await env({ build: 2072 })
    .Native.update.check('https://example.test/latest.json', 72);
  assert.equal(status.kind, 'apk-required');
  assert.equal(status.nativeBuild, 2072);
});

test('une disponibilité ARCore transitoire est retentée', async () => {
  let calls = 0;
  const sandbox = env({
    depth: {
      available: () => {
        calls++;
        return calls === 1
          ? Promise.reject(new Error('vérification temporaire'))
          : Promise.resolve({ supported: true, installed: true, reason: 'SUPPORTED_INSTALLED' });
      },
      capture: () => Promise.resolve({ cancelled: true })
    }
  });
  const first = await sandbox.Native.depth.available();
  const second = await sandbox.Native.depth.available();
  assert.equal(first.transient, true);
  assert.equal(second.supported, true);
  assert.equal(calls, 2);
});

test('le mode carte est transmis au natif et toutes ses preuves sont conservées', async () => {
  let request = null;
  const sandbox = env({
    depth: {
      available: () => Promise.resolve({ supported: true, installed: true }),
      capture: (value) => {
        request = value;
        return Promise.resolve({
          jpegBase64: 'aGVsbG8=', scaleOk: true, fresh: true,
          fieldWidthCm: 30, fieldHeightCm: 20, distanceCm: 60, cmPerPixel: 0.02,
          cardRequested: true, cardVerified: true, cardFresh: true,
          cardSchema: 'glucovision-card-v2', scaleSource: 'card',
          cardTrackingMethod: 'augmented-image', cardObservations: 8,
          cardWidthCm: 8.56, cardHeightCm: 5.398,
          cardDepthCompared: true, cardDepthAgrees: true
        });
      }
    }
  });
  const got = await sandbox.Native.depth.capture({ cardMode: true, forgedOption: 'ignored' });
  assert.deepEqual(JSON.parse(JSON.stringify(request)), { cardMode: true });
  assert.equal(got.depth.cardMode, true);
  assert.equal(got.depth.cardVerified, true);
  assert.equal(got.depth.cardFresh, true);
  assert.equal(got.depth.cardSchema, 'glucovision-card-v2');
  assert.equal(got.depth.scaleSource, 'card');
  assert.equal(got.depth.cardObservations, 8);
  assert.equal(got.depth.cardWidthCm, 8.56);
});

test('des validations de carte absentes restent strictement fausses', async () => {
  const sandbox = env({
    depth: {
      available: () => Promise.resolve({ supported: true, installed: true }),
      capture: () => Promise.resolve({
        jpegBase64: 'aGVsbG8=', scaleOk: true,
        fieldWidthCm: 30, fieldHeightCm: 20, distanceCm: 60, cmPerPixel: 0.02
      })
    }
  });
  const got = await sandbox.Native.depth.capture({ cardMode: true });
  assert.equal(got.depth.fresh, false);
  assert.equal(got.depth.cardVerified, false);
  assert.equal(got.depth.cardFresh, false);
  assert.equal(got.depth.cardSchema, '');
});

test('le repli de partage n’écrit jamais dans le stockage Data privé', async () => {
  const directories = [];
  const sandbox = env({
    filesystem: {
      writeFile(args) {
        directories.push(args.directory);
        return Promise.reject(new Error('public storage unavailable'));
      }
    }
  });
  assert.equal(await sandbox.Native.saveToDocuments('carte.svg', '<svg/>'), null);
  assert.deepEqual(directories, ['DOCUMENTS', 'EXTERNAL']);
  assert.equal(directories.includes('DATA'), false);
});

test('le repli de partage nomme le dossier public réellement utilisé', async () => {
  const sandbox = env({
    filesystem: {
      writeFile(args) {
        if (args.directory === 'DOCUMENTS') return Promise.reject(new Error('denied'));
        return Promise.resolve({ uri: '/public/carte.svg' });
      }
    }
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(await sandbox.Native.saveToDocuments('carte.svg', '<svg/>'))),
    { uri: '/public/carte.svg', directory: 'EXTERNAL' }
  );
});

test('une erreur de lecture du Keystore n’est jamais confondue avec une clé absente', async () => {
  const sandbox = env({ secureGet: () => Promise.reject(new Error('keystore locked')) });
  await assert.rejects(sandbox.Native.secure.load(['gemini']), /keystore locked/i);
});

test('la purge photo rejette si Android refuse une suppression', async () => {
  const sandbox = env({
    filesystem: {
      readdir: () => Promise.resolve({ files: [{ name: 'meal-1.jpg' }] }),
      deleteFile: () => Promise.reject(new Error('EACCES'))
    }
  });
  await assert.rejects(sandbox.Native.photos.prune([]), /pas pu être supprimée/i);
});

test('la purge compte uniquement des suppressions réellement confirmées', async () => {
  let deleted = 0;
  const sandbox = env({
    filesystem: {
      readdir: () => Promise.resolve({ files: [
        { name: 'keep.jpg' }, { name: 'old-1.jpg' }, { name: 'old-2.jpg' }
      ] }),
      deleteFile: () => { deleted++; return Promise.resolve(); }
    }
  });
  assert.equal(await sandbox.Native.photos.prune(['keep.jpg']), 2);
  assert.equal(deleted, 2);
});

test('une erreur de lecture photo ne devient pas zéro octet rassurant', async () => {
  const sandbox = env({
    filesystem: { readdir: () => Promise.reject(new Error('EACCES')) }
  });
  await assert.rejects(sandbox.Native.photos.size(), /EACCES/);
});

test('l’APK exclut les données de santé et impose le contrat natif de la carte', () => {
  /* MIN_NATIVE_BUILD et minimum_native_floor comparés dynamiquement plutôt que
     figés à une version précise : un test qui oblige à une retouche à chaque
     bump de version finit par être désarmé (déjà vu sur service-worker.test.js
     et le test navigateur « Version 80 »). Ce qui compte réellement : le
     plancher exigé par cette variante ne doit jamais dépasser ce que l'app
     réclame elle-même, sinon un APK conforme au plancher serait quand même
     rejeté par son propre contenu web. */
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/android.yml'), 'utf8');
  const modern = fs.readFileSync(
    path.join(ROOT, 'android-res/xml/data_extraction_rules.xml'), 'utf8');
  const legacy = fs.readFileSync(path.join(ROOT, 'android-res/xml/backup_rules.xml'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  const activity = fs.readFileSync(path.join(ROOT, 'android-src/DepthScanActivity.java'), 'utf8');
  assert.match(workflow, /android:dataExtractionRules="@xml\/data_extraction_rules"/);
  assert.match(workflow, /android:fullBackupContent="@xml\/backup_rules"/);

  const floorMatch = /minimum_native_floor=(\d+)/.exec(workflow);
  const minNativeMatch = /MIN_NATIVE_BUILD = (\d+)/.exec(app);
  assert.ok(floorMatch, 'minimum_native_floor introuvable dans le workflow');
  assert.ok(minNativeMatch, 'MIN_NATIVE_BUILD introuvable dans js/app.js');
  const floor = Number(floorMatch[1]);
  const minNative = Number(minNativeMatch[1]);
  assert.ok(floor >= 2084, 'le plancher ne doit jamais redescendre sous la carte repère (v84)');
  assert.ok(minNative >= floor,
    `MIN_NATIVE_BUILD (${minNative}) doit être au moins égal au plancher (${floor})`);
  assert.match(activity, /CARD_NAME\s*=\s*"glucovision-card-v2"/);
  assert.match(activity, /CARD_SCHEMA\s*=\s*"glucovision-card-v2"/);
  assert.doesNotMatch(activity, /glucovision-card-v1/);

  assert.match(modern, /<cloud-backup/);
  assert.match(modern, /<device-transfer>/);
  assert.ok((modern.match(/<exclude /g) || []).length >= 10);
  assert.ok((legacy.match(/<exclude /g) || []).length >= 5);
});
