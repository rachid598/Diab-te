/* camera.js — capture/lecture des images et vidéos, compression avant envoi.
   Photos : redimensionnées à ~1280 px max. Vidéo : on extrait plusieurs images
   (plans) réparties dans la durée, qu'on envoie comme angles multiples au modèle. */
(function () {
  'use strict';

  /* 2048 px : les modèles de vision récents (Opus 4.7+, Opus 5, Sonnet 5, Gemini 3)
     exploitent jusqu'à ~2576 px. À 1280 px on leur retirait de la finesse utile pour
     juger la texture d'un aliment (grain du riz, mie du pain) — justement le facteur
     de densité qui domine l'incertitude. On reste sous le plafond pour limiter le
     poids de l'envoi et le coût en tokens. */
  var MAX_DIM = 2048;
  var JPEG_QUALITY = 0.85;
  var MAX_ANGLES = 6;

  // Lit un File image -> { base64, mediaType, previewUrl }
  function processFile(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type)) {
        return reject(new Error('Fichier non image.'));
      }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        resolve(drawToJpeg(img, img.naturalWidth, img.naturalHeight));
        URL.revokeObjectURL(url);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('Image illisible (format non pris en charge, ex. HEIC). ' +
          'Sur iPhone : Réglages → Appareil photo → Formats → « Le plus compatible », ' +
          'ou reprends la photo avec le bouton 📷.'));
      };
      img.src = url;
    });
  }

  // Dessine une source (image ou vidéo) sur un canvas et renvoie un JPEG compressé.
  function drawToJpeg(source, w, h) {
    var scale = Math.min(1, MAX_DIM / Math.max(w, h));
    var cw = Math.round(w * scale), ch = Math.round(h * scale);
    var canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    canvas.getContext('2d').drawImage(source, 0, 0, cw, ch);
    var dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    return { base64: dataUrl.split(',')[1], mediaType: 'image/jpeg', previewUrl: dataUrl };
  }

  /* Extrait jusqu'à maxFrames images réparties dans une vidéo, par LECTURE +
     échantillonnage (plus robuste que le seek selon les navigateurs / vidéos
     mobiles à durée « infinie »). Retourne une Promise d'un tableau
     de { base64, mediaType, previewUrl }. */
  function processVideo(file, maxFrames) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^video\//.test(file.type)) {
        return reject(new Error('Fichier non vidéo.'));
      }
      var n = Math.max(1, Math.min(maxFrames || 4, 5));
      var url = URL.createObjectURL(file);
      var video = document.createElement('video');
      video.muted = true;
      video.defaultMuted = true;
      video.playsInline = true;
      video.setAttribute('muted', '');
      video.setAttribute('playsinline', '');
      video.preload = 'auto';
      // Hors écran mais rendu (display:none empêche la capture sur certains navigateurs).
      video.setAttribute('style', 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;');
      document.body.appendChild(video);

      var frames = [];
      var done = false;
      var timer = null;

      function cleanup() {
        if (done) return;
        done = true;
        if (timer) clearInterval(timer);
        try { video.pause(); } catch (e) {}
        try { document.body.removeChild(video); } catch (e) {}
        URL.revokeObjectURL(url);
      }
      function fail(msg) { cleanup(); reject(new Error(msg)); }
      function finish() { cleanup(); resolve(frames); }

      function capture() {
        var w = video.videoWidth, h = video.videoHeight;
        if (w && h) frames.push(drawToJpeg(video, w, h));
      }

      function startSampling() {
        var d = video.duration;
        // Intervalle : réparti sur la durée si connue, sinon cadence fixe.
        var interval = (isFinite(d) && d > 0)
          ? Math.min(3000, Math.max(150, (d / (n + 1)) * 1000))
          : 350;
        capture(); // une première image tout de suite
        if (frames.length >= n) return finish();
        timer = setInterval(function () {
          if (done) return;
          capture();
          if (frames.length >= n) finish();
        }, interval);
      }

      var started = false;
      function begin() {
        if (started) return;
        started = true;
        startSampling();
      }

      video.onended = function () {
        if (done) return;
        if (!frames.length) capture();
        finish();
      };
      video.onerror = function () { fail('Impossible de lire la vidéo.'); };

      video.onloadeddata = function () {
        // Lance la lecture (muette) puis échantillonne pendant qu'elle défile.
        var p = video.play();
        if (p && p.then) {
          p.then(begin).catch(function () {
            // Lecture auto refusée : on capture au moins l'image courante.
            capture();
            finish();
          });
        } else {
          begin();
        }
      };
      video.onplaying = begin;

      // Filet de sécurité : si rien n'aboutit en 20 s, on rend ce qu'on a.
      setTimeout(function () { if (!done) finish(); }, 20000);

      video.src = url;
      try { video.load(); } catch (e) {}
    });
  }

  window.Camera = {
    MAX_ANGLES: MAX_ANGLES,
    processFile: processFile,
    // Tolérant aux échecs : une photo illisible n'annule pas les autres.
    // Résout { results: [...ok], errors: [...messages] }.
    processFiles: function (files) {
      var arr = Array.prototype.slice.call(files);
      return Promise.allSettled(arr.map(processFile)).then(function (settled) {
        var results = [], errors = [];
        settled.forEach(function (s) {
          if (s.status === 'fulfilled') results.push(s.value);
          else errors.push((s.reason && s.reason.message) || 'Image illisible.');
        });
        return { results: results, errors: errors };
      });
    },
    processVideo: processVideo
  };
})();
