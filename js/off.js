/* off.js — accès à OpenFoodFacts (base ouverte et gratuite de produits du commerce).
   Sert à récupérer les glucides EXACTS d'un produit emballé, par recherche de nom
   ou par code-barres. Rien n'est stocké côté serveur ; on interroge l'API publique.

   IMPORTANT — choix des serveurs :
   Dans le NAVIGATEUR on n'utilise que world.openfoodfacts.org, le seul hôte qui
   renvoie l'en-tête « access-control-allow-origin: * ». Le moteur
   search.openfoodfacts.org (search-a-licious) répond correctement mais n'envoie
   AUCUN en-tête CORS, quelle que soit l'origine : le navigateur bloque donc
   systématiquement sa réponse — c'était la cause du « erreur réseau ».

   Dans l'APK, la requête part du code natif et non du navigateur : la politique
   d'origine croisée ne s'applique pas. On remet donc search-a-licious en tête,
   parce que c'est le moteur le plus pertinent des deux. */
(function () {
  'use strict';

  var BASE = 'https://world.openfoodfacts.org';
  var FIELDS = 'code,product_name,product_name_fr,brands,nutriments,serving_quantity';
  var native = window.Native && window.Native.isApp;

  var SEARCH_URLS = [
    function (q) {
      return BASE + '/cgi/search.pl?search_terms=' + encodeURIComponent(q) +
        '&search_simple=1&action=process&json=1&page_size=50&fields=' + FIELDS;
    },
    function (q) {
      return BASE + '/api/v2/search?search_terms=' + encodeURIComponent(q) +
        '&fields=' + FIELDS + '&page_size=50';
    }
  ];

  if (native) {
    SEARCH_URLS.unshift(function (q) {
      return 'https://search.openfoodfacts.org/search?q=' + encodeURIComponent(q) +
        '&page_size=50&fields=' + FIELDS;
    });
  }

  function fetchJson(url, ms) {
    ms = ms || 15000;

    // APK : requête native, aucun blocage d'origine croisée.
    if (native) {
      return window.Native.httpJson(url, ms).then(function (res) {
        if (!res || res.status >= 400) {
          var err = new Error('HTTP ' + ((res && res.status) || 0));
          err.status = (res && res.status) || 0;
          throw err;
        }
        if (res.data == null) {
          var e = new Error('Réponse illisible du service.');
          e.status = 0;
          throw e;
        }
        return res.data;
      }, function (err) {
        if (err && err.status) throw err;
        var e = new Error('Réseau injoignable.');
        e.status = 0;
        throw e;
      });
    }

    var opts = {};
    var ctrl;
    if (typeof AbortController !== 'undefined') {
      ctrl = new AbortController();
      opts.signal = ctrl.signal;
    }
    var id = ctrl ? setTimeout(function () { ctrl.abort(); }, ms) : null;
    return fetch(url, opts).then(function (r) {
      if (id) clearTimeout(id);
      if (!r.ok) {
        var err = new Error('HTTP ' + r.status);
        err.status = r.status;
        throw err;
      }
      return r.json().catch(function () {
        var e = new Error('Réponse illisible du service.');
        e.status = 0;
        throw e;
      });
    }, function (err) {
      if (id) clearTimeout(id);
      if (err && err.status) throw err;              // erreur HTTP déjà typée
      var e = new Error(err && err.name === 'AbortError'
        ? 'Délai dépassé.' : 'Réseau injoignable.');
      e.status = (err && err.name === 'AbortError') ? 408 : 0;
      throw e;
    });
  }

  // Message clair selon la cause réelle de l'échec.
  function friendlyError(err) {
    var s = err && err.status;
    if (s >= 500) {
      return new Error('La recherche par nom d\'OpenFoodFacts est en panne de leur côté ' +
        '(erreur ' + s + '). Le scan 📷 Code-barres, lui, fonctionne toujours.');
    }
    if (s === 408) {
      return new Error('Délai dépassé : réseau lent. Réessaie, ou utilise le scan code-barres.');
    }
    return new Error('Recherche en ligne injoignable (pas de connexion ?). ' +
      'Le mode manuel hors-ligne et tes aliments perso restent disponibles.');
  }

  // Transforme un produit OFF en aliment { n, brand, carb, code, serving }.
  // Accepte les deux formats (brands = "A, B" ou ["A","B"]).
  function parse(p) {
    if (!p) return null;
    var nutr = p.nutriments || {};
    var carb = nutr['carbohydrates_100g'];
    if (carb == null) carb = nutr['carbohydrates'];
    carb = parseFloat(carb);
    if (!isFinite(carb) || carb < 0 || carb > 100) return null; // sans glucides exploitables
    var name = (p.product_name_fr || p.product_name || '').trim();
    if (!name) return null;
    var brand = Array.isArray(p.brands) ? (p.brands[0] || '') : (p.brands || '').split(',')[0];
    var serving = parseFloat(p.serving_quantity);
    return {
      n: name,
      brand: (brand || '').trim(),
      carb: Math.round(carb * 10) / 10,
      code: p.code || '',
      serving: (isFinite(serving) && serving > 0) ? Math.round(serving) : null
    };
  }

  // Extrait la liste utilisable d'une réponse (max 20 aliments avec glucides connus).
  function collect(data) {
    var raw = (data && (data.products || data.hits)) || [];
    var out = [];
    raw.forEach(function (p) {
      if (out.length >= 20) return;
      var f = parse(p);
      if (f) out.push(f);
    });
    return out;
  }

  var OFF = {
    /* Recherche par nom. On essaie les points d'entrée l'un après l'autre : si le
       premier est en panne (OpenFoodFacts a des coupures régulières), on bascule
       sur le suivant au lieu d'échouer. Renvoie une Promise d'un tableau. */
    search: function (query) {
      query = (query || '').trim();
      if (query.length < 2) return Promise.resolve([]);

      var lastErr = null;
      var attempt = function (i) {
        if (i >= SEARCH_URLS.length) {
          return Promise.reject(friendlyError(lastErr));
        }
        return fetchJson(SEARCH_URLS[i](query)).then(function (data) {
          var list = collect(data);
          // Réponse vide : on tente quand même le point d'entrée suivant.
          if (!list.length && i + 1 < SEARCH_URLS.length) return attempt(i + 1);
          /* Rien trouvé ET un point d'entrée a réellement échoué avant : c'est une
             panne du service, pas une absence de résultat. On le dit clairement
             plutôt que d'afficher un trompeur « aucun produit ». */
          if (!list.length && lastErr) throw friendlyError(lastErr);
          return list;
        }, function (err) {
          lastErr = err;
          return attempt(i + 1);
        });
      };
      return attempt(0);
    },

    // Recherche par code-barres : renvoie une Promise d'un aliment ou null.
    lookupBarcode: function (code) {
      code = (code || '').replace(/\D/g, '');
      if (!code) return Promise.resolve(null);
      var url = BASE + '/api/v2/product/' + encodeURIComponent(code) + '?fields=' + FIELDS;
      return fetchJson(url).then(function (data) {
        if (!data || data.status === 0 || !data.product) return null;
        return parse(data.product);
      }, function (err) {
        // Un code inconnu renvoie 404 : ce n'est pas une panne, juste « introuvable ».
        if (err && err.status === 404) return null;
        throw friendlyError(err);
      });
    }
  };

  window.OFF = OFF;
})();
