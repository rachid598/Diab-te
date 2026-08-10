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
    Directory: { Data: 'DATA' },
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

test('l’APK v80 exclut les données de santé du cloud et du transfert Android', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/android.yml'), 'utf8');
  const modern = fs.readFileSync(
    path.join(ROOT, 'android-res/xml/data_extraction_rules.xml'), 'utf8');
  const legacy = fs.readFileSync(path.join(ROOT, 'android-res/xml/backup_rules.xml'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  assert.match(workflow, /android:dataExtractionRules="@xml\/data_extraction_rules"/);
  assert.match(workflow, /android:fullBackupContent="@xml\/backup_rules"/);
  assert.match(workflow, /minimum_native_floor=2080/);
  assert.match(app, /MIN_NATIVE_BUILD = 2080/);
  assert.match(modern, /<cloud-backup/);
  assert.match(modern, /<device-transfer>/);
  assert.ok((modern.match(/<exclude /g) || []).length >= 10);
  assert.ok((legacy.match(/<exclude /g) || []).length >= 5);
});
