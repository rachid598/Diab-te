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
  function cleanDepth(raw, imageCount) {
    if (!raw || typeof raw !== 'object') return null;
    var out = {
      scaleOk: raw.scaleOk === true,
      fresh: raw.fresh !== false,
      volumeOk: raw.volumeOk === true
    };
    ['fieldWidthCm', 'fieldHeightCm', 'distanceCm', 'cmPerPixel', 'volumeCm3', 'volume']
      .forEach(function (key) {
        var value = finite(raw[key]);
        if (value != null && value >= 0 && value <= 100000) out[key] = value;
      });
    if (out.scaleOk) {
      var view = finite(raw.viewIndex);
      if (imageCount > 1 &&
          (view == null || view !== Math.round(view) || view < 1 || view > imageCount)) {
        return null;
      }
      out.viewIndex = imageCount > 1 ? view : 1;
    }
    return out;
  }
  function cleanContext(raw, imageCount) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var plate = finite(raw.plateDiameterCm);
    var out = {
      referenceObject: cleanText(raw.referenceObject, 120) || 'none',
      plateDiameterCm: plate != null && plate >= 5 && plate <= 100 ? plate : null,
      notes: cleanText(raw.notes, 4000),
      extras: cleanText(raw.extras, 4000),
      imageCount: imageCount
    };
    var depth = cleanDepth(raw.depth, imageCount);
    if (depth) out.depth = depth;
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
  function isNetworkError(err) {
    if (!err) return false;
    if (err.status) return err.status >= 500 || err.status === 408;
    return (typeof navigator !== 'undefined' && navigator.onLine === false) ||
      /r[ée]seau|network|failed to fetch|timeout|d[ée]lai|abort/i.test(err.message || '');
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
      return Promise.all(safe.files.map(function (f) {
        return window.Cap.Filesystem.readFile({
          path: f.file, directory: window.Cap.Directory.Data
        }).then(function (r) {
          var data = cleanBase64(r && r.data);
          if (!data) throw new Error('Photo de file illisible ou trop volumineuse.');
          return { base64: data, mediaType: f.mediaType };
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
