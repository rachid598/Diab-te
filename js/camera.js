/* camera.js — capture/lecture des images et compression avant envoi.
   On redimensionne à ~1280 px max pour réduire le coût/latence tout en gardant
   assez de détail pour l'estimation des portions. */
(function () {
  'use strict';

  var MAX_DIM = 1280;
  var JPEG_QUALITY = 0.85;

  // Lit un File image -> { base64, mediaType, previewUrl }
  function processFile(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type)) {
        return reject(new Error('Fichier non image.'));
      }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        var scale = Math.min(1, MAX_DIM / Math.max(w, h));
        var cw = Math.round(w * scale), ch = Math.round(h * scale);

        var canvas = document.createElement('canvas');
        canvas.width = cw; canvas.height = ch;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, cw, ch);
        URL.revokeObjectURL(url);

        var dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
        var base64 = dataUrl.split(',')[1];
        resolve({ base64: base64, mediaType: 'image/jpeg', previewUrl: dataUrl });
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('Impossible de lire l\'image.'));
      };
      img.src = url;
    });
  }

  window.Camera = {
    MAX_ANGLES: 4,
    processFile: processFile,
    processFiles: function (files) {
      return Promise.all(Array.prototype.slice.call(files).map(processFile));
    }
  };
})();
