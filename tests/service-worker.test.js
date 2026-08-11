'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript } = require('./test-env');

function workerEnv(entries) {
  const handlers = {};
  const cache = new Map(Object.entries(entries || {}));
  let fetches = 0;
  const self = {
    location: { origin: 'https://app.test' },
    clients: { claim: () => Promise.resolve() },
    skipWaiting: () => Promise.resolve(),
    addEventListener(type, handler) { handlers[type] = handler; }
  };
  loadScript('service-worker.js', {
    self, URL, Response,
    caches: {
      match(req) {
        const key = typeof req === 'string'
          ? new URL(req, 'https://app.test/').href : req.url;
        const value = cache.get(key);
        return Promise.resolve(value == null ? undefined : new Response(value));
      },
      open: () => Promise.resolve({ addAll: () => Promise.resolve(), put: () => Promise.resolve() }),
      keys: () => Promise.resolve([]),
      delete: () => Promise.resolve(true)
    },
    fetch() { fetches++; return Promise.resolve(new Response('network')); }
  });
  async function request(overrides) {
    const req = Object.assign({
      url: 'https://app.test/', method: 'GET', mode: 'navigate',
      destination: 'document', cache: 'default'
    }, overrides || {});
    let response;
    handlers.fetch({ request: req, respondWith(promise) { response = promise; } });
    return response ? response.then((r) => r.text()) : null;
  }
  function version() {
    let value = null;
    handlers.message({
      data: { type: 'GET_VERSION' },
      ports: [{ postMessage(v) { value = v; } }]
    });
    return value;
  }
  return { request, version, fetchCount: () => fetches };
}

test('le worker actif garde sa coquille jusqu’à l’activation explicite du suivant', async () => {
  const env = workerEnv({
    'https://app.test/': 'index-v79',
    'https://app.test/js/app.js?v=79': 'app-v79'
  });
  assert.equal(await env.request(), 'index-v79');
  assert.equal(await env.request({
    url: 'https://app.test/js/app.js?v=79', mode: 'no-cors', destination: 'script'
  }), 'app-v79');
  assert.equal(env.fetchCount(), 0, 'aucun fichier v80 ne traverse le cache actif v79');
});

test('le contrôle manuel ?maj contourne volontairement le cache de coquille', async () => {
  const env = workerEnv({ 'https://app.test/': 'index-cache' });
  assert.equal(await env.request({
    url: 'https://app.test/js/app.js?maj=123', mode: 'cors', destination: 'script'
  }), 'network');
  assert.equal(env.fetchCount(), 1);
});

test('la page peut vérifier la version du worker qui la contrôle', () => {
  assert.equal(workerEnv().version(), '81');
});
