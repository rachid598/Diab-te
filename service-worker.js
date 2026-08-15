/* service-worker.js — cache de la coquille pour l'usage hors-ligne.
   Stratégie : cache de VERSION pour le code/les pages, cache-first pour les
   images/icônes et réseau pour les données non préchargées.
   Mise à jour : le nouveau worker ATTEND (pas de skipWaiting automatique). La page
   affiche un bouton « Actualiser » et envoie le message SKIP_WAITING quand l'utilisateur
   l'accepte. Les appels API (Anthropic / Google / OpenAI) ne sont jamais mis en cache. */
var VERSION = '88';
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
  './js/portion.js?v=' + VERSION,
  './js/manual.js?v=' + VERSION,
  './js/off.js?v=' + VERSION,
  './js/barcode.js?v=' + VERSION,
  './js/native.js?v=' + VERSION,
  './vendor/capacitor-plugins.js?v=' + VERSION,
  './vendor/zxing.min.js?v=' + VERSION,
  './js/app.js?v=' + VERSION,
  './manifest.webmanifest',
  './glucovision-card.svg',
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
        /* Ne jamais effacer les caches d'une autre application hébergée sur la
           même origine. GlucoVision ne possède que le préfixe diabete-v. */
        if (k !== CACHE && /^diabete-v/.test(k)) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

// La page demande la bascule vers la nouvelle version.
self.addEventListener('message', function (e) {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
  if (e.data && e.data.type === 'GET_VERSION' && e.ports && e.ports[0]) {
    e.ports[0].postMessage(VERSION);
  }
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  // On ne gère que le GET same-origin (la coquille). Le reste passe au réseau.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) {
    return;
  }
  var parsed = new URL(req.url);
  /* Le contrôle manuel ajoute ?maj=<timestamp> et demande explicitement le
     réseau. Le mettre en cache créait une entrée permanente à chaque appui. */
  if (parsed.searchParams.has('maj') || req.cache === 'no-store') {
    e.respondWith(fetch(req));
    return;
  }

  /* La coquille doit rester ATOMIQUE. Tant que le worker v79 contrôle la page,
     il sert exclusivement son HTML et ses scripts v79 ; le worker v80 les
     précharge dans un autre cache puis attend SKIP_WAITING. Un network-first
     ici permettait à v79 de servir index v80 avant l'accord de l'utilisateur,
     voire de mélanger les deux versions lors d'une coupure réseau. */
  var shellRequest = req.mode === 'navigate' ||
    /^(script|style|worker|manifest)$/.test(req.destination || '');
  if (shellRequest) {
    e.respondWith(
      caches.match(req).then(function (cached) {
        if (cached) return cached;
        if (req.mode === 'navigate') {
          return caches.match('./index.html').then(function (shell) {
            return shell || fetch(req);
          });
        }
        /* L'installation atomique a normalement préchargé tout le code. Ce
           repli ne sert qu'après une éviction manuelle du cache. */
        return fetch(req);
      })
    );
    return;
  }

  // Images / icônes ET bibliothèques tierces figées (vendor/) : cache-first.
  // ZXing fait ~330 Ko et ne change jamais : inutile de le retélécharger.
  if (req.destination === 'image' || /\/vendor\//.test(parsed.pathname)) {
    e.respondWith(
      caches.match(req).then(function (cached) {
        return cached || fetch(req).then(function (res) {
          if (!res || !res.ok) return res;
          var copy = res.clone();
          return caches.open(CACHE).then(function (c) {
            return c.put(req, copy);
          }).catch(function () { /* la réponse réseau reste valable */ })
            .then(function () { return res; });
        });
      })
    );
    return;
  }

  // Données same-origin non préchargées : network-first avec secours local.
  e.respondWith(
    fetch(req).then(function (res) {
      if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
      var copy = res.clone();
      return caches.open(CACHE).then(function (c) {
        return c.put(req, copy);
      }).catch(function () { /* la réponse réseau reste valable */ })
        .then(function () { return res; });
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
