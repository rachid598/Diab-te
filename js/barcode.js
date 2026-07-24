/* barcode.js — lecture de code-barres via la caméra (bibliothèque ZXing embarquée).
   Fonctionne sur iPhone/Safari et Android (getUserMedia + ZXing), là où l'API
   native BarcodeDetector n'est pas disponible. */
(function () {
  'use strict';

  var reader = null;

  function supported() {
    return typeof navigator !== 'undefined' &&
           navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
           typeof ZXing !== 'undefined' && ZXing.BrowserMultiFormatReader;
  }

  // Démarre le scan continu dans videoEl. onResult(code) est appelé au 1ᵉʳ code lu.
  function start(videoEl, onResult, onError) {
    if (!supported()) {
      onError && onError(new Error('Le scan n\'est pas disponible sur ce navigateur. Saisis le code à la main.'));
      return;
    }
    try {
      reader = new ZXing.BrowserMultiFormatReader();
    } catch (e) {
      onError && onError(new Error('Impossible d\'initialiser le lecteur.'));
      return;
    }
    var fired = false;
    // Caméra arrière de préférence.
    var constraints = { video: { facingMode: { ideal: 'environment' } } };
    reader.decodeFromConstraints(constraints, videoEl, function (result) {
      if (fired || !result) return;
      var text = result.getText ? result.getText() : (result.text || '');
      if (text) { fired = true; onResult(text); }
    }).catch(function (e) {
      var msg = (e && e.name === 'NotAllowedError')
        ? 'Accès caméra refusé. Autorise la caméra puis réessaie.'
        : 'Impossible de démarrer la caméra.';
      onError && onError(new Error(msg));
    });
  }

  function stop() {
    if (reader) {
      try { reader.reset(); } catch (e) {}
      reader = null;
    }
  }

  window.Barcode = { supported: supported, start: start, stop: stop };
})();
