/* bench.js — banc d'essai des modèles.

   Il n'existe aucune façon honnête de savoir quel modèle estime le mieux TES
   portions, dans TON assiette, avec TON éclairage. Les classements publics
   mesurent autre chose. La seule référence valable est la valeur réelle que tu
   as relevée sur tes propres repas.

   Le principe : rejouer d'anciens repas — dont on a encore la photo ET la
   valeur réelle — sur plusieurs modèles, puis comparer chaque estimation à
   cette valeur. L'erreur absolue moyenne classe les modèles.

   Limites assumées, écrites ici pour ne pas être oubliées :
   - Seuls les repas ayant une photo conservée ET une valeur réelle comptent.
     Sur la PWA, la photo stockée est une vignette de 320 px : c'est utilisable
     mais dégradé, et le résultat sous-estime les modèles. Sur l'APK, la photo
     est conservée en pleine définition, la comparaison est donc juste.
   - Chaque essai est un VRAI appel, donc facturé. On l'annonce avant.
   - Une valeur « réelle » elle-même estimée fait un mauvais juge : les repas
     dont la source est marquée comme estimation personnelle sont écartés. */
(function () {
  'use strict';

  // Sources de valeur réelle assez fiables pour servir d'arbitre.
  var SOURCES_FIABLES = { pesee: 1, etiquette: 1, recette: 1 };

  /* Repas exploitables comme cas de test. On exige une photo : sans elle il n'y
     a rien à faire estimer, et comparer une description ne dirait rien de la
     qualité en vision. */
  function cases(limit) {
    var out = [];
    (Storage.getHistory() || []).forEach(function (e) {
      if (Storage.isConfirmedMeal ? !Storage.isConfirmedMeal(e)
          : (e.draft || e.blocked || (e.blocking && e.blocking.length) ||
             (e.dominantRequired && !e.dominantConfirmed))) return;
      if (!(e.realCarbsG > 0) || !(e.totalCarbsG > 0)) return;
      if (Storage.isReliableReal ? !Storage.isReliableReal(e)
          : (e.realSource && !SOURCES_FIABLES[e.realSource])) return;
      if (e.realCarbsG > 400 || e.totalCarbsG > 400) return;
      var img = (e.photo && window.Native && Native.isApp) ? Native.photos.src(e.photo)
              : (e.thumb || null);
      if (!img) return;
      out.push({
        date: e.date, real: e.realCarbsG, previous: e.totalCarbsG,
        img: img, isThumb: !e.photo,
        // Le contexte d'origine, pour rejouer dans les mêmes conditions.
        ctx: e.input || e.ctx || null,
        names: (e.items || []).filter(function (it) { return it.carbsG > 0; })
                 .map(function (it) { return it.name; }).slice(0, 3)
      });
    });
    return limit ? out.slice(0, limit) : out;
  }

  // Recharge l'image d'un cas sous la forme attendue par l'estimateur.
  function loadImage(c) {
    if (/^data:/.test(c.img)) {
      return Camera.processDataUrl(c.img).then(function (r) {
        return [{ base64: r.base64, mediaType: r.mediaType }];
      });
    }
    // Fichier local de l'APK : la WebView sait le lire par fetch.
    return fetch(c.img).then(function (r) { return r.blob(); })
      .then(function (blob) {
        return new Promise(function (res, rej) {
          var fr = new FileReader();
          fr.onload = function () {
            res([{ base64: String(fr.result).split(',')[1], mediaType: blob.type || 'image/jpeg' }]);
          };
          fr.onerror = function () { rej(new Error('Photo illisible.')); };
          fr.readAsDataURL(blob);
        });
      });
  }

  /* Lance un modèle sur tous les cas, EN SÉRIE. En parallèle on déclencherait
     des limitations de débit chez la plupart des fournisseurs, et une série
     d'échecs 429 ne dirait rien de la précision du modèle. */
  function runModel(entry, list, settings, onStep) {
    var forced = Object.assign({}, settings, {
      models: Object.assign({}, settings.models,
        (function () { var m = {}; m[entry.provider] = entry.model; return m; })())
    });
    var results = [];

    var next = function (i) {
      if (i >= list.length) return Promise.resolve(results);
      var c = list[i];
      if (onStep) onStep(entry, i, list.length);
      return loadImage(c)
        .then(function (imgs) {
          var ctx = c.ctx || {};
          return Estimator.estimateWith(entry.provider, imgs, {
            /* Le banc ne recharge qu'une photo, alors que le contexte peut
               provenir d'un repas multi-vues. Il ne peut donc pas rattacher
               honnêtement une ancienne mesure à cette image : parcours rapide
               explicite, sans conversion du contrat legacy. */
            referenceMode: 'none',
            viewMeasurements: [],
            notes: ctx.notes || '',
            extras: ctx.extras || '',
            imageCount: imgs.length
          }, forced);
        })
        .then(function (r) {
          if (!r || (r.blocking && r.blocking.length) || !(r.totalCarbsG > 0) ||
              r.totalCarbsG > 400) {
            throw new Error('Résultat bloqué ou total invalide.');
          }
          results.push({ date: c.date, real: c.real, got: r.totalCarbsG,
                         err: Math.abs(r.totalCarbsG - c.real) });
        })
        .catch(function (e) {
          results.push({ date: c.date, real: c.real, got: null, error: e.message });
        })
        .then(function () { return next(i + 1); });
    };
    return next(0);
  }

  // Un modèle doit avoir répondu sur au moins 80 % des cas pour être classé.
  // Sinon un unique succès pourrait masquer une longue série d'échecs.
  var MIN_COVERAGE = 0.8;

  // Erreur absolue moyenne, et erreur relative moyenne (plus comparable).
  function score(results) {
    results = results || [];
    var ok = results.filter(function (r) { return r.got != null; });
    var successes = ok.length;
    var total = results.length;
    var failed = total - successes;
    var coverage = total ? successes / total : 0;
    var eligible = successes > 0 && coverage >= MIN_COVERAGE;
    var summary = {
      // `n` reste le signal historique utilisé par l'interface pour classer un
      // modèle. Il vaut donc zéro si la couverture rend le score inéligible.
      n: eligible ? successes : 0,
      successes: successes,
      total: total,
      failed: failed,
      coveragePct: Math.round(coverage * 100),
      eligible: eligible
    };
    if (!successes) return summary;
    var mae = ok.reduce(function (s, r) { return s + r.err; }, 0) / ok.length;
    var mape = ok.reduce(function (s, r) { return s + r.err / r.real; }, 0) / ok.length * 100;
    var biais = ok.reduce(function (s, r) { return s + (r.got - r.real); }, 0) / ok.length;
    summary.mae = Math.round(mae * 10) / 10;
    summary.mape = Math.round(mape);
    summary.biais = Math.round(biais * 10) / 10;
    return summary;
  }

  window.Bench = { cases: cases, runModel: runModel, score: score };
})();
