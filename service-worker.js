/* service-worker.js — cache de la coquille pour l'usage hors-ligne.
   Stratégie : network-first pour le code/les pages (dernière version quand en ligne,
   cache en secours hors-ligne), cache-first pour les images/icônes.
   Mise à jour : le nouveau worker ATTEND (pas de skipWaiting automatique). La page
   affiche un bouton « Actualiser » et envoie le message SKIP_WAITING quand l'utilisateur
   l'accepte. Les appels API (Anthropic / Google / OpenAI) ne sont jamais mis en cache. */
var VERSION = '77';
var CACHE = 'diabete-v' + VERSION;
var ASSETS = [
  './',
  './index.html',
  './css/styles.css?v=' + VERSION,
  './js/storage.js?v=' + VERSION,
  './js/foods.js?v=' + VERSION,
  './js/gi.js?v=' + VERSION,
  './js/queue.js?v=' + VERSION,
  './js/report.js?v=' + VERSION,
  './js/bench.js?v=' + VERSION,
  './js/estimator.js?v=' + VERSION,
  './js/camera.js?v=' + VERSION,
  './js/off.js?v=' + VERSION,
  './js/barcode.js?v=' + VERSION,
  './js/native.js?v=' + VERSION,
  './vendor/capacitor-plugins.js?v=' + VERSION,
  './vendor/zxing.min.js?v=' + VERSION,
  './js/app.js?v=' + VERSION,
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png'
];

self.addEventListener('install', function (e) {
  // On pré-cache la coquille mais on N'appelle PAS skipWaiting :
  // le nouveau worker reste en attente jusqu'à ce que l'utilisateur clique « Actualiser ».
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      /* Atomique : un worker incomplet ne doit jamais devenir installable. */
      return c.addAll(ASSETS);
    })
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

// La page demande la bascule vers la nouvelle version.
self.addEventListener('message', function (e) {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  // On ne gère que le GET same-origin (la coquille). Le reste passe au réseau.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  // Images / icônes ET bibliothèques tierces figées (vendor/) : cache-first.
  // ZXing fait ~330 Ko et ne change jamais : inutile de le retélécharger.
  if (req.destination === 'image' || /\/vendor\//.test(new URL(req.url).pathname)) {
    e.respondWith(
      caches.match(req).then(function (cached) {
        return cached || fetch(req).then(function (res) {
          if (!res || !res.ok) return res;
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
      if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy); });
      return res;
    }).catch(function () {
      return caches.match(req).then(function (cached) {
        if (cached) return cached;
        /* L'HTML n'est un secours valable que pour une navigation. Renvoyer
           index.html à la place d'un script transforme une panne réseau en
           erreur JavaScript opaque et peut laisser une interface à moitié à jour. */
        if (req.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      });
    })
  );
});
