/* off.js — accès à OpenFoodFacts (base ouverte et gratuite de produits du commerce).
   Sert à récupérer les glucides EXACTS d'un produit emballé, par recherche de nom
   ou par code-barres. Rien n'est stocké côté serveur ; on interroge l'API publique. */
(function () {
  'use strict';

  // Deux services distincts :
  //  - recherche par NOM  : search.openfoodfacts.org (moteur « search-a-licious »,
  //    le seul qui filtre réellement sur le terme recherché) ;
  //  - recherche par CODE : l'API v2 classique, fiable pour un code-barres précis.
  var SEARCH_BASE = 'https://search.openfoodfacts.org';
  var BASE = 'https://world.openfoodfacts.org';
  var FIELDS = 'code,product_name,product_name_fr,brands,nutriments,serving_quantity';

  function fetchJson(url, ms) {
    ms = ms || 15000;
    var opts = {};
    var ctrl;
    if (typeof AbortController !== 'undefined') {
      ctrl = new AbortController();
      opts.signal = ctrl.signal;
    }
    var id = ctrl ? setTimeout(function () { ctrl.abort(); }, ms) : null;
    return fetch(url, opts).then(function (r) {
      if (id) clearTimeout(id);
      if (!r.ok) throw new Error('Base produits indisponible (' + r.status + ').');
      return r.json();
    }, function (err) {
      if (id) clearTimeout(id);
      if (err && err.name === 'AbortError') throw new Error('Délai dépassé : réseau lent. Réessaie.');
      throw new Error('Réseau indisponible pour la recherche en ligne.');
    });
  }

  // Transforme un produit OFF en aliment { n, brand, carb, code, serving }.
  // Accepte les deux formats (v2 : brands = "A, B" ; search : brands = ["A","B"]).
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

  var OFF = {
    /* Recherche par nom. On demande large (50) car beaucoup de fiches n'ont pas
       de valeurs nutritionnelles : on ne garde que celles dont les glucides sont
       connus, puis on limite à 20. Renvoie une Promise d'un tableau d'aliments. */
    search: function (query) {
      query = (query || '').trim();
      if (query.length < 2) return Promise.resolve([]);
      var url = SEARCH_BASE + '/search?q=' + encodeURIComponent(query) +
        '&fields=' + FIELDS + '&page_size=50';
      return fetchJson(url).then(function (data) {
        var hits = data.hits || data.products || [];
        var out = [];
        hits.forEach(function (p) {
          if (out.length >= 20) return;
          var f = parse(p);
          if (f) out.push(f);
        });
        return out;
      });
    },

    // Recherche par code-barres : renvoie une Promise d'un aliment ou null.
    lookupBarcode: function (code) {
      code = (code || '').replace(/\D/g, '');
      if (!code) return Promise.resolve(null);
      var url = BASE + '/api/v2/product/' + encodeURIComponent(code) + '?fields=' + FIELDS;
      return fetchJson(url).then(function (data) {
        if (!data || data.status === 0 || !data.product) return null;
        return parse(data.product);
      });
    }
  };

  window.OFF = OFF;
})();
