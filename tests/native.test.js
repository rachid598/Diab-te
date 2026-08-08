'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript } = require('./test-env');

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
    }
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
