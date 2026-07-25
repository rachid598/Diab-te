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
  var MAX_AGE_MS = 48 * 3600000; // un repas de plus de 2 jours n'a plus d'intérêt

  var native = function () { return window.Native && window.Native.isApp; };

  function read() {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; }
  }
  function write(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) {}
    return list;
  }

  /* Une panne réseau se reconnaît à l'absence de statut HTTP : le serveur n'a
     jamais répondu. Une clé invalide (401) ou un quota dépassé (429), eux,
     échoueront tout autant plus tard — les mettre en file ne servirait à rien. */
  function isNetworkError(err) {
    if (!err) return false;
    if (err.status) return err.status >= 500 || err.status === 408;
    return !navigator.onLine ||
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
      var list = read();
      if (list.length >= MAX) return Promise.reject(new Error('File d\'attente pleine.'));

      var id = 'q' + Date.now();
      var writes = images.map(function (img, i) {
        var name = DIR + '/' + id + '-' + i + '.jpg';
        return window.Cap.Filesystem.writeFile({
          path: name,
          data: img.base64,
          directory: window.Cap.Directory.Data,
          recursive: true
        }).then(function () { return { file: name, mediaType: img.mediaType }; });
      });

      return Promise.all(writes).then(function (files) {
        list.push({ id: id, date: Date.now(), files: files, ctx: ctx });
        write(list);
        return id;
      });
    },

    // Relit les images d'un élément pour pouvoir le renvoyer au modèle.
    load: function (item) {
      return Promise.all(item.files.map(function (f) {
        return window.Cap.Filesystem.readFile({
          path: f.file, directory: window.Cap.Directory.Data
        }).then(function (r) {
          return { base64: r.data, mediaType: f.mediaType || 'image/jpeg' };
        });
      }));
    },

    remove: function (id) {
      var list = read();
      var item = list.filter(function (x) { return x.id === id; })[0];
      write(list.filter(function (x) { return x.id !== id; }));
      if (item && native()) {
        item.files.forEach(function (f) {
          window.Cap.Filesystem.deleteFile({
            path: f.file, directory: window.Cap.Directory.Data
          }).catch(function () {});
        });
      }
    },

    // Écarte les repas trop anciens pour être encore utiles.
    prune: function () {
      var self = this, now = Date.now(), dropped = 0;
      read().forEach(function (item) {
        if (now - item.date > MAX_AGE_MS) { self.remove(item.id); dropped++; }
      });
      return dropped;
    }
  };

  window.Queue = Queue;
})();
