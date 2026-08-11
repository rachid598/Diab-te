/* manual.js — calcul unique et testable du mode Manuel.

   L'interface, l'historique et les repas fréquents doivent partir du même
   calcul. Arrondir chaque ligne séparément puis refaire le total ailleurs peut
   créer 1 g affiché mais 2 g sauvegardés. Ce module répartit proprement
   l'arrondi final entre les aliments pour que la somme des lignes soit TOUJOURS
   le total montré à l'écran. */
(function () {
  'use strict';

  var MAX_ITEM_GRAMS = 5000;
  var MAX_TOTAL_CARBS = 400;

  function finiteNumber(value) {
    /* Number(null) et Number(true) valent respectivement 0 et 1. Accepter ces
       conversions silencieuses ferait passer une densité absente pour « 0 g de
       glucides », donc pour un résultat complet. */
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (typeof value === 'string' && !value.trim()) return null;
    var n = typeof value === 'string'
      ? parseFloat(value.replace(',', '.'))
      : Number(value);
    return isFinite(n) ? n : null;
  }

  function normalizeGrams(value) {
    var n = finiteNumber(value);
    if (n == null || n <= 0 || n > MAX_ITEM_GRAMS) return null;
    return Math.round(n * 10) / 10;
  }

  function calculate(items) {
    var errors = [];
    var rows = (Array.isArray(items) ? items : []).map(function (raw, index) {
      var item = raw || {};
      var grams = normalizeGrams(item.grams);
      var density = finiteNumber(item.carb);
      var name = String(item.name || ('Aliment ' + (index + 1))).slice(0, 160);

      if (grams == null) {
        errors.push('« ' + name + ' » : indique une quantité supérieure à 0 g (maximum ' +
          MAX_ITEM_GRAMS + ' g).');
      }
      if (density == null || density < 0 || density > 100) {
        errors.push('« ' + name + ' » : glucides pour 100 g invalides.');
      }

      var exact = grams == null || density == null || density < 0 || density > 100
        ? 0 : grams * density / 100;
      return {
        index: index,
        name: name,
        grams: grams,
        carb: density,
        exactCarbsG: exact,
        carbsG: Math.floor(exact),
        fraction: exact - Math.floor(exact)
      };
    });

    var exactTotal = rows.reduce(function (sum, row) { return sum + row.exactCarbsG; }, 0);
    var total = Math.round(exactTotal);

    /* Méthode des plus grands restes : elle garde l'arrondi au plus près pour
       chaque ligne tout en garantissant somme(lignes) === total. */
    var missing = total - rows.reduce(function (sum, row) { return sum + row.carbsG; }, 0);
    rows.slice().sort(function (a, b) {
      return b.fraction - a.fraction || a.index - b.index;
    }).slice(0, Math.max(0, missing)).forEach(function (row) {
      rows[row.index].carbsG++;
    });

    if (total > MAX_TOTAL_CARBS) {
      errors.push('Total supérieur à ' + MAX_TOTAL_CARBS + ' g : vérifie les quantités.');
    }

    rows.forEach(function (row) {
      delete row.index;
      delete row.fraction;
      delete row.exactCarbsG;
    });

    return {
      ok: errors.length === 0,
      errors: errors,
      totalCarbsG: total,
      rows: rows
    };
  }

  window.ManualCalc = {
    MAX_ITEM_GRAMS: MAX_ITEM_GRAMS,
    MAX_TOTAL_CARBS: MAX_TOTAL_CARBS,
    normalizeGrams: normalizeGrams,
    calculate: calculate
  };
})();
