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
  /* ---------- Qualité de l'image, mesurée EN LOCAL ----------
     Une photo floue ou trop sombre donne une estimation médiocre, mais on ne
     l'apprend qu'après avoir attendu 20 s et payé l'appel — et le message
     d'erreur, lui, ne dit jamais que la cause était la photo.

     Ces deux mesures coûtent quelques millisecondes et aucun appel réseau :
     - NETTETÉ : variance du laplacien. Une image nette a des transitions
       franches entre pixels voisins, donc une forte variance ; le flou les
       lisse et la fait chuter. C'est la mesure classique du « focus ».
     - EXPOSITION : luminance moyenne, plus la part de pixels écrasés en noir
       ou brûlés en blanc — dans les deux cas l'information est perdue et
       aucun modèle ne peut la retrouver.

     On analyse une réduction à 256 px : suffisant pour ces statistiques, et
     assez rapide pour ne pas bloquer l'interface. */
  var ANALYSE_DIM = 256;
  var SHARP_BLURRY = 90;    // en dessous : franchement flou
  var SHARP_SOFT = 220;     // entre les deux : acceptable mais mou
  var DARK = 55, BRIGHT = 205;

  function analyseQuality(source, w, h) {
    try {
      var s = Math.min(1, ANALYSE_DIM / Math.max(w, h));
      var aw = Math.max(8, Math.round(w * s)), ah = Math.max(8, Math.round(h * s));
      var c = document.createElement('canvas');
      c.width = aw; c.height = ah;
      var ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(source, 0, 0, aw, ah);
      var d = ctx.getImageData(0, 0, aw, ah).data;

      // Niveaux de gris (luma perceptuelle) + statistiques d'exposition.
      var gray = new Float32Array(aw * ah);
      var sum = 0, dark = 0, blown = 0;
      for (var i = 0, p = 0; p < d.length; p += 4, i++) {
        var g = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
        gray[i] = g; sum += g;
        if (g < 12) dark++;
        if (g > 246) blown++;
      }
      var n = aw * ah;
      var mean = sum / n;

      // Laplacien 4-voisins, puis variance de la réponse.
      var lSum = 0, lSum2 = 0, count = 0;
      for (var y = 1; y < ah - 1; y++) {
        for (var x = 1; x < aw - 1; x++) {
          var k = y * aw + x;
          var lap = 4 * gray[k] - gray[k - 1] - gray[k + 1] - gray[k - aw] - gray[k + aw];
          lSum += lap; lSum2 += lap * lap; count++;
        }
      }
      if (!count) return null;
      var lMean = lSum / count;
      var sharpness = Math.round(lSum2 / count - lMean * lMean);

      var issues = [];
      if (sharpness < SHARP_BLURRY) issues.push('flou');
      else if (sharpness < SHARP_SOFT) issues.push('peu net');
      if (mean < DARK) issues.push('sombre');
      else if (mean > BRIGHT) issues.push('surexposé');
      if (dark / n > 0.55) issues.push('sombre');
      if (blown / n > 0.18) issues.push('reflets brûlés');

      return {
        sharpness: sharpness,
        brightness: Math.round(mean),
        // 'bad' déclenche un avertissement visible, 'soft' une simple mention.
        verdict: (sharpness < SHARP_BLURRY || mean < DARK || mean > BRIGHT) ? 'bad'
               : (issues.length ? 'soft' : 'ok'),
        issues: issues.filter(function (v, i, a) { return a.indexOf(v) === i; })
      };
    } catch (e) {
      return null;   // une analyse impossible ne doit jamais bloquer une photo
    }
  }

  function drawToJpeg(source, w, h) {
    var scale = Math.min(1, MAX_DIM / Math.max(w, h));
    var cw = Math.round(w * scale), ch = Math.round(h * scale);
    var canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    canvas.getContext('2d').drawImage(source, 0, 0, cw, ch);
    var dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    return {
      base64: dataUrl.split(',')[1], mediaType: 'image/jpeg', previewUrl: dataUrl,
      quality: analyseQuality(source, w, h)
    };
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

  /* Image déjà encodée (appareil photo natif de l'APK). Le plugin rend un JPEG
     déjà mis à l'échelle par le code natif : on ne le repasse par un canvas que
     s'il dépasse MAX_DIM. Éviter ce ré-encodage n'est pas un détail — c'est
     précisément ce qui fait la qualité supérieure de la capture native : une
     seule compression au lieu de deux. */
  function processDataUrl(dataUrl) {
    return new Promise(function (resolve, reject) {
      if (!dataUrl || dataUrl.indexOf('data:image/') !== 0) {
        return reject(new Error('Image illisible.'));
      }
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        if (Math.max(w, h) <= MAX_DIM) {
          var head = dataUrl.slice(0, dataUrl.indexOf(','));
          var mt = (/data:([^;]+)/.exec(head) || [])[1] || 'image/jpeg';
          // Même sans ré-encodage, on mesure la qualité : c'est le chemin de
          // l'appareil photo natif, celui qui sert le plus souvent.
          resolve({ base64: dataUrl.split(',')[1], mediaType: mt, previewUrl: dataUrl,
                    quality: analyseQuality(img, w, h) });
        } else {
          resolve(drawToJpeg(img, w, h));
        }
      };
      img.onerror = function () { reject(new Error('Image illisible.')); };
      img.src = dataUrl;
    });
  }

  /* Vignette pour l'historique. Le stockage du navigateur est limité (~5 Mo),
     donc on descend très bas en taille et en qualité : l'image sert à se
     rappeler le repas, pas à être ré-analysée. */
  function makeThumb(dataUrl) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, 320 / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        try { resolve(c.toDataURL('image/jpeg', 0.55)); }
        catch (e) { resolve(null); }
      };
      img.onerror = function () { resolve(null); };
      img.src = dataUrl;
    });
  }

  window.Camera = {
    MAX_ANGLES: MAX_ANGLES,
    makeThumb: makeThumb,
    processFile: processFile,
    processDataUrl: processDataUrl,
    analyseQuality: analyseQuality,
    // Tolérant aux échecs, comme processFiles.
    processDataUrls: function (urls) {
      return Promise.allSettled(urls.map(processDataUrl)).then(function (settled) {
        var results = [], errors = [];
        settled.forEach(function (s) {
          if (s.status === 'fulfilled') results.push(s.value);
          else errors.push((s.reason && s.reason.message) || 'Image illisible.');
        });
        return { results: results, errors: errors };
      });
    },
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
