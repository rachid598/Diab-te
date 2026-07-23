/* service-worker.js — mise en cache de la coquille de l'app pour un usage hors-ligne.
   Stratégie : network-first pour le code/les pages (on récupère toujours la dernière
   version quand on est en ligne, le cache sert de secours hors-ligne), cache-first pour
   les images/icônes. Les appels API (Anthropic/OpenAI) ne sont jamais mis en cache. */
var CACHE = 'diabete-v3';
var ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/storage.js',
  './js/foods.js',
  './js/estimator.js',
  './js/camera.js',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon.svg'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(ASSETS.map(function (url) {
        return c.add(url).catch(function () { /* ignore les assets manquants */ });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  // On ne gère que le GET same-origin (la coquille). Le reste passe au réseau.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  // Images / icônes : cache-first (rapide, elles ne changent presque jamais).
  if (req.destination === 'image') {
    e.respondWith(
      caches.match(req).then(function (cached) {
        return cached || fetch(req).then(function (res) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
          return res;
        });
      })
    );
    return;
  }

  // Code, pages, manifeste : network-first pour toujours avoir la dernière version.
  e.respondWith(
    fetch(req).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy); });
      return res;
    }).catch(function () {
      return caches.match(req).then(function (cached) {
        return cached || caches.match('./index.html');
      });
    })
  );
});
