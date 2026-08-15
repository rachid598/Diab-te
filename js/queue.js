/* queue.js — file d'attente des estimations quand le réseau manque.

   Le cas visé est concret : restaurant en sous-sol, pas de réseau. Aujourd'hui
   l'estimation échoue et les photos sont perdues — or c'est précisément le
   moment où on ne peut pas refaire la photo, l'assiette est déjà entamée.
   Ici on garde le repas et on l'analyse dès que le réseau revient.

   APK UNIQUEMENT, et c'est délibéré : mettre en file d'attente veut dire
   stocker plusieurs photos, ce que le quota de localStorage ne supporte pas.
   Sur le web, isAvailable() renvoie false et l'app garde son comportement
   actuel (message d'erreur immédiat). */
(function () {
  'use strict';

  var KEY = 'diabete.queue.v1';
  var DIR = 'queue';
  var MAX = 5;                  // au-delà, c'est un problème de réseau durable
  var MAX_IMAGES = 6;
  var MAX_IMAGE_BYTES = 20 * 1024 * 1024;
  var MEDIA = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

  var native = function () { return window.Native && window.Native.isApp; };

  function finite(v) {
    return typeof v === 'number' && isFinite(v) ? v : null;
  }
  function cleanText(v, max) {
    return typeof v === 'string' ? v.trim().slice(0, max) : '';
  }
  function validId(id) {
    return typeof id === 'string' && /^q\d{10,16}(?:-[a-z0-9]{6,16})?$/.test(id);
  }
  function validFile(file, id, index) {
    if (!file || !validId(id)) return null;
    var mediaType = MEDIA[file.mediaType] ? file.mediaType : 'image/jpeg';
    var ext = MEDIA[mediaType];
    var expected = DIR + '/' + id + '-' + index + '.' + ext;
    // Compatibilité des anciennes entrées qui stockaient toujours en .jpg.
    var legacy = DIR + '/' + id + '-' + index + '.jpg';
    if (file.file !== expected && file.file !== legacy) return null;
    return { file: file.file, mediaType: mediaType };
  }
  function hasVerifiedCardContract(raw) {
    if (!raw || typeof raw !== 'object' || raw.cardRequested !== true ||
        raw.cardVerified !== true || raw.cardFresh !== true ||
        raw.cardSchema !== 'glucovision-card-v2' || raw.cardName !== 'glucovision-card-v2' ||
        raw.cardTrackingMethod !== 'FULL_TRACKING' ||
        !/^(card|card\+depth)$/.test(raw.scaleSource || '')) return false;
    var observations = finite(raw.cardObservations);
    var width = finite(raw.cardWidthCm), height = finite(raw.cardHeightCm);
    if (observations == null || observations !== Math.round(observations) ||
        observations < 4 || observations > 1000 || width == null || height == null ||
        Math.abs(width - 8.56) > 0.05 || Math.abs(height - 5.398) > 0.05) return false;
    return raw.scaleSource !== 'card+depth' ||
      (raw.cardDepthCompared === true && raw.cardDepthAgrees === true);
  }
  function cleanDepth(raw) {
    if (!raw || typeof raw !== 'object' || raw.scaleOk !== true ||
        raw.fresh !== true || raw.cardMode !== true || !hasVerifiedCardContract(raw)) return null;
    var out = {
      scaleOk: true,
      fresh: true,
      cardVerified: true,
      cardFresh: true,
      cardSchema: 'glucovision-card-v2',
      scaleSource: raw.scaleSource,
      cardRequested: raw.cardRequested === true,
      cardDepthCompared: raw.cardDepthCompared === true,
      cardDepthAgrees: raw.cardDepthAgrees === true,
      cardMode: raw.cardMode === true,
      volumeOk: raw.volumeOk === true
    };
    ['fieldWidthCm', 'fieldHeightCm', 'distanceCm', 'cmPerPixel', 'volumeCm3',
     'areaCm2', 'heightMaxCm', 'heightMeanCm', 'samples', 'confidentPixels',
     'coverage', 'observations', 'parallaxCm'].forEach(function (key) {
      var value = finite(raw[key]);
      if (value != null && value >= 0 && value <= 1000000) out[key] = value;
    });
    if (!(out.fieldWidthCm > 1 && out.fieldWidthCm <= 250 &&
          out.fieldHeightCm > 1 && out.fieldHeightCm <= 250 &&
          out.distanceCm >= 5 && out.distanceCm <= 500 &&
          out.cmPerPixel > 0 && out.cmPerPixel <= 5)) return null;
    /* Les diagnostics natifs ne servent pas de preuve mais restent utiles à la
       reprise. On conserve la valeur entière lorsqu'elle est raisonnable, on
       ne la coupe jamais en un texte trompeur. */
    ['note', 'diag'].forEach(function (key) {
      if (typeof raw[key] === 'string' && raw[key].length <= 2000) out[key] = raw[key];
    });
    var cardObservations = finite(raw.cardObservations);
    if (cardObservations != null && cardObservations >= 0 && cardObservations <= 1000000) {
      out.cardObservations = cardObservations;
    }
    ['cardWidthCm', 'cardHeightCm', 'cardDistanceCm', 'cardFieldWidthCm',
     'cardFieldHeightCm', 'cardCmPerPixel', 'cardIncidenceDeg'].forEach(function (key) {
      var value = finite(raw[key]);
      if (value != null && value >= 0 && value <= 1000000) out[key] = value;
    });
    ['cardTrackingMethod', 'cardName'].forEach(function (key) {
      if (typeof raw[key] === 'string' && raw[key].length <= 120) out[key] = raw[key];
    });
    if (typeof raw.cardNote === 'string' && raw.cardNote.length <= 2000) {
      out.cardNote = raw.cardNote;
    }
    return out;
  }
  function referenceFromDepth(depth) {
    var out = {
      mode: 'glucovision-card-v2', cardVerified: true, cardFresh: true,
      cardSchema: 'glucovision-card-v2', scaleSource: depth.scaleSource,
      cardRequested: depth.cardRequested === true,
      cardDepthCompared: depth.cardDepthCompared === true,
      cardDepthAgrees: depth.cardDepthAgrees === true,
      cardObservations: depth.cardObservations || 0,
      cardTrackingMethod: depth.cardTrackingMethod || ''
    };
    ['cardName', 'cardNote', 'cardWidthCm', 'cardHeightCm', 'cardDistanceCm',
     'cardFieldWidthCm', 'cardFieldHeightCm', 'cardCmPerPixel', 'cardIncidenceDeg']
      .forEach(function (key) {
        if (depth[key] !== undefined) out[key] = depth[key];
      });
    return out;
  }
  function cleanViewMeasurements(raw, imageCount, referenceMode) {
    if (referenceMode !== 'glucovision-card-v2' || !Array.isArray(raw)) return [];
    var seen = {};
    return raw.map(function (measurement) {
      if (!measurement || typeof measurement !== 'object') return null;
      var view = finite(measurement.viewIndex);
      var reference = measurement.reference;
      var depth = cleanDepth(measurement.depth);
      if (view == null || view !== Math.round(view) || view < 1 || view > imageCount ||
          seen[view] || !depth || !reference || typeof reference !== 'object' ||
          reference.mode !== 'glucovision-card-v2' || !hasVerifiedCardContract(reference) ||
          reference.scaleSource !== depth.scaleSource) {
        return null;
      }
      seen[view] = true;
      return {
        viewIndex: view,
        depth: depth,
        reference: referenceFromDepth(depth)
      };
    }).filter(Boolean).sort(function (a, b) { return a.viewIndex - b.viewIndex; });
  }
  function cleanContext(raw, imageCount) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var referenceMode = raw.referenceMode === 'glucovision-card-v2'
      ? 'glucovision-card-v2' : 'none';
    var out = {
      referenceMode: referenceMode,
      notes: cleanText(raw.notes, 4000),
      extras: cleanText(raw.extras, 4000),
      imageCount: imageCount
    };
    var mealAt = finite(raw.mealAt);
    if (mealAt != null && mealAt >= 946684800000 && mealAt <= 4102444800000) {
      out.mealAt = mealAt;
    }
    var venue = cleanText(raw.venue, 20);
    if (/^(maison|restaurant|cantine)$/.test(venue)) out.venue = venue;
    if (raw.clarificationAnswered === true) out.clarificationAnswered = true;
    out.viewMeasurements = cleanViewMeasurements(raw.viewMeasurements, imageCount, referenceMode);
    return out;
  }
  function cleanItem(raw) {
    if (!raw || !validId(raw.id) || !(finite(raw.date) > 0) || !Array.isArray(raw.files) ||
        !raw.files.length || raw.files.length > MAX_IMAGES) return null;
    var files = raw.files.map(function (file, index) {
      return validFile(file, raw.id, index);
    });
    if (files.some(function (file) { return !file; })) return null;
    return {
      id: raw.id,
      date: raw.date,
      files: files,
      ctx: cleanContext(raw.ctx, files.length)
    };
  }
  function read() {
    try {
      var parsed = JSON.parse(localStorage.getItem(KEY)) || [];
      if (!Array.isArray(parsed)) return [];
      return parsed.slice(0, MAX).map(cleanItem).filter(Boolean);
    } catch (e) { return []; }
  }
  function write(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list)); return true; }
    catch (e) { return false; }
  }
  function cleanBase64(value) {
    if (typeof value !== 'string') return null;
    var compact = value.replace(/\s+/g, '');
    if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null;
    var bytes = Math.floor(compact.length * 3 / 4) - (compact.slice(-2).match(/=/g) || []).length;
    return bytes > 0 && bytes <= MAX_IMAGE_BYTES ? compact : null;
  }
  function uniqueId(list) {
    var suffix;
    if (window.crypto && window.crypto.getRandomValues) {
      var data = new Uint32Array(2);
      window.crypto.getRandomValues(data);
      suffix = data[0].toString(36) + data[1].toString(36);
    } else {
      suffix = Math.random().toString(36).slice(2, 12);
    }
    suffix = (suffix + '0000000000000000').slice(0, 16);
    var id = 'q' + Date.now() + '-' + suffix;
    return list.some(function (item) { return item.id === id; })
      ? 'q' + (Date.now() + 1) + '-' + suffix : id;
  }
  function deleteFiles(files) {
    if (!native() || !window.Cap || !window.Cap.Filesystem || !window.Cap.Directory) {
      return Promise.resolve(false);
    }
    return Promise.all((files || []).map(function (file) {
      return window.Cap.Filesystem.deleteFile({
        path: file.file, directory: window.Cap.Directory.Data
      }).then(function () { return true; }).catch(function () { return false; });
    })).then(function (results) {
      return results.every(Boolean);
    });
  }

  /* Une panne réseau se reconnaît à l'absence de statut HTTP : le serveur n'a
     jamais répondu. Une clé invalide (401) ou un quota dépassé (429), eux,
     échoueront tout autant plus tard — les mettre en file ne servirait à rien. */
  /* Décide si un repas mérite d'être mis de côté pour être rejoué plus tard.

     Le drapeau err.reseau, posé par l'estimateur, est la source SÛRE : il ne
     dépend d'aucun libellé. La liste d'expressions qui suit n'est qu'un filet
     pour les erreurs venues d'ailleurs — et elle a déjà menti une fois.

     Elle contenait « failed to fetch », le libellé de Chrome, mais pas
     « fetch failed » (Node/undici) ni « load failed » (WebKit/iOS). Une coupure
     réseau annoncée dans l'un de ces deux mots n'était donc PAS reconnue comme
     telle : au lieu de proposer de garder le repas, l'app affichait un message
     incompréhensible et l'analyse était perdue. Reconnaître un type de panne à
     l'orthographe de son message est fragile par nature ; c'est pour ça que le
     drapeau existe maintenant. */
  var MOTS_RESEAU =
    /r[ée]seau|network|failed to fetch|fetch failed|load failed|networkerror|err_|timeout|d[ée]lai|abort|connexion|connection/i;

  function isNetworkError(err) {
    if (!err) return false;
    if (err.reseau === true) return true;
    if (err.status) return err.status >= 500 || err.status === 408;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    // Un TypeError nu est la signature d'un fetch() qui n'a jamais abouti.
    if (err.name === 'TypeError' && !err.status) return true;
    return MOTS_RESEAU.test(err.message || '');
  }

  var Queue = {
    isAvailable: function () { return !!native(); },

    list: function () { return read(); },
    count: function () { return read().length; },

    isNetworkError: isNetworkError,

    /* Met un repas de côté. Les images vont sur le disque (une par fichier) et
       seule leur référence entre dans localStorage. */
    add: function (images, ctx) {
      if (!native() || !images || !images.length) return Promise.resolve(null);
      if (!window.Cap || !window.Cap.Filesystem || !window.Cap.Directory) {
        return Promise.reject(new Error('Stockage natif indisponible.'));
      }
      if (images.length > MAX_IMAGES) {
        return Promise.reject(new Error('Trop de photos pour la file d\'attente.'));
      }
      var list = read();
      if (list.length >= MAX) return Promise.reject(new Error('File d\'attente pleine.'));

      var id = uniqueId(list);
      var prepared;
      try {
        prepared = images.map(function (img, index) {
          var mediaType = img && MEDIA[img.mediaType] ? img.mediaType : null;
          var data = cleanBase64(img && img.base64);
          if (!mediaType || !data) {
            throw new Error('Photo ' + (index + 1) + ' invalide ou trop volumineuse.');
          }
          return {
            file: DIR + '/' + id + '-' + index + '.' + MEDIA[mediaType],
            mediaType: mediaType,
            data: data
          };
        });
      } catch (err) {
        return Promise.reject(err);
      }
      var written = [];
      var chain = Promise.resolve();
      prepared.forEach(function (file) {
        chain = chain.then(function () {
          return window.Cap.Filesystem.writeFile({
            path: file.file,
            data: file.data,
            directory: window.Cap.Directory.Data,
            recursive: true
          }).then(function () {
            written.push({ file: file.file, mediaType: file.mediaType });
          });
        });
      });
      return chain.then(function () {
        var next = list.concat([{
          id: id,
          date: Date.now(),
          files: written.slice(),
          ctx: cleanContext(ctx, written.length)
        }]);
        if (!write(next)) throw new Error('Impossible de persister la file d\'attente.');
        return id;
      }).catch(function (err) {
        // On tente aussi de retirer le fichier dont l'écriture a rejeté : le
        // plugin peut avoir créé le fichier avant de signaler son erreur.
        return deleteFiles(prepared).then(function () { throw err; });
      });
    },

    // Relit les images d'un élément pour pouvoir le renvoyer au modèle.
    load: function (item) {
      var safe = cleanItem(item);
      if (!safe || !native() || !window.Cap || !window.Cap.Filesystem || !window.Cap.Directory) {
        return Promise.reject(new Error('Élément de file invalide.'));
      }
      return Promise.all(safe.files.map(function (f, index) {
        return window.Cap.Filesystem.readFile({
          path: f.file, directory: window.Cap.Directory.Data
        }).then(function (r) {
          var data = cleanBase64(r && r.data);
          if (!data) throw new Error('Photo de file illisible ou trop volumineuse.');
          var out = { base64: data, mediaType: f.mediaType };
          var measurement = safe.ctx.viewMeasurements.filter(function (view) {
            return view.viewIndex === index + 1;
          })[0];
          if (measurement) {
            out.depth = measurement.depth;
            out.reference = measurement.reference;
          }
          return out;
        });
      }));
    },

    remove: function (id) {
      if (!validId(id)) return Promise.resolve(false);
      var list = read();
      var item = list.filter(function (x) { return x.id === id; })[0];
      if (!item) return Promise.resolve(true);
      // L'index est persisté AVANT de toucher aux fichiers. En cas d'échec de
      // quota, l'élément et ses photos restent intégralement récupérables.
      if (!write(list.filter(function (x) { return x.id !== id; }))) {
        return Promise.resolve(false);
      }
      return deleteFiles(item.files).then(function () { return true; });
    },

    // Aucun repas n'est supprimé automatiquement : même ancien, il peut être le
    // seul exemplaire d'une assiette déjà mangée. L'appel est gardé compatible.
    prune: function () {
      return Promise.resolve(0);
    }
  };

  window.Queue = Queue;
})();
