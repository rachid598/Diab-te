/* app.js — orchestration de l'interface. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var APP_VERSION = '84'; // à garder synchro avec la version du service worker

  /* Build natif MINIMAL exigé par ce bundle web.
     Le contenu web se met à jour par OTA, le code Java non : un APK ancien
     pouvait donc charger un bundle récent, afficher « Version 59 » et exécuter
     l'ancien natif. Toute version qui a besoin d'un plugin ou d'un comportement
     natif nouveau doit relever ce nombre au numéro de build qui l'apporte.
     Il est publié dans le manifeste OTA et vérifié avant toute application. */
  /* La branche stable utilise un offset de 2000 pour versionCode. 2073 est le
     premier APK qui contient le nouveau plugin ARCore : un OTA v73 ne doit pas
     se charger sur le build stable 2072, même si son nombre est > 73. */
  /* v80 ajoute aussi les règles Android qui excluent repas/photos du cloud et
     du transfert appareil-à-appareil. Elles vivent dans l'APK : un ancien
     build 2073 ne doit donc pas accepter le bundle OTA v80. */
  var MIN_NATIVE_BUILD = 2084;
  var nativeBuild = null;      // build réellement en cours d'exécution, sur APK
  var settings = Storage.getSettings();

  // État courant
  var images = [];        // [{base64, mediaType, previewUrl}]
  /* Images exactes envoyées pour le résultat courant. `images` reste la
     sélection éditable du prochain appel ; l'historique et une relance doivent
     rester attachés au snapshot analysé, même si la galerie change ensuite. */
  var lastEstimateImages = [];
  var lastResult = null;  // résultat IA (modifiable)
  var manualItems = [];   // [{name, carb(per100g), grams}]
  var currentHistoryDate = null;
  var currentHistoryConfirmed = false;
  var currentHistoryPhotoStarted = false;
  /* Vrai tant qu'une comparaison affichée n'a pas encore été tranchée. Le
     premier avis est conservé comme brouillon de secours, mais il ne devient
     pas pour autant le choix de l'utilisateur. */
  var currentChoiceRequired = false;
  var lastEstimateContext = null;
  /* Vrai dès qu'une question de clarification a reçu une réponse pour CE repas.
     Sans ce drapeau, un modèle qui repose la même question après la relance
     ferait tourner en boucle — et chaque tour est un appel facturé. Remis à
     zéro par une nouvelle photo ou un nouveau repas, pas par la relance. */
  var clarificationRepondue = false;
  var lastVerification = null;
  var estimateGeneration = 0;
  var estimateBusy = false;
  var lastDepthShown = null;
  var currentDominantConfirmed = false;
  var resumedPhotoDraft = false;
  var depthSupported = false;

  // ---------- Utilitaires d'affichage ----------
  function fr(n) { return (Math.round(n * 10) / 10).toString().replace('.', ','); }

  function partsFrom(grams) {
    var raw = grams / settings.partSizeG;
    var value = settings.roundHalf ? Math.round(raw * 2) / 2 : Math.round(raw * 10) / 10;
    return value;
  }

  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    // Laisse plus de temps pour lire les messages longs (ex. erreurs).
    var ms = Math.min(8000, 2800 + msg.length * 45);
    toast._t = setTimeout(function () { t.hidden = true; }, ms);
  }

  /* Une modale annoncée avec aria-modal doit réellement isoler l'arrière-plan,
     recevoir le focus et le garder jusqu'à sa fermeture. Sans ce contrat, un
     lecteur d'écran ou la touche Tab continue dans la page cachée derrière. */
  var activeModal = null;
  var modalReturnFocus = null;

  function modalFocusables(modal) {
    return Array.from(modal.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
      'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(function (el) {
      return !el.hidden && el.getAttribute('aria-hidden') !== 'true' &&
        (el.offsetWidth > 0 || el.offsetHeight > 0);
    });
  }

  function setModalBackgroundInert(modal, inert) {
    Array.from(document.body.children).forEach(function (el) {
      if (el !== modal && el.id !== 'toast' && el.tagName !== 'SCRIPT') el.inert = inert;
    });
  }

  function showModal(id, initialFocusId) {
    var modal = $(id);
    if (!modal) return;
    if (activeModal && activeModal !== modal) hideModal(activeModal.id);
    modalReturnFocus = document.activeElement;
    modal.hidden = false;
    activeModal = modal;
    setModalBackgroundInert(modal, true);
    requestAnimationFrame(function () {
      if (activeModal !== modal || modal.hidden) return;
      var target = initialFocusId && $(initialFocusId);
      if (!target || target.disabled || target.hidden) target = modalFocusables(modal)[0];
      if (target) target.focus();
    });
  }

  function hideModal(id, restoreFocus) {
    var modal = $(id);
    if (!modal) return;
    modal.hidden = true;
    if (activeModal !== modal) return;
    setModalBackgroundInert(modal, false);
    activeModal = null;
    var target = modalReturnFocus;
    modalReturnFocus = null;
    if (restoreFocus !== false && target && target.isConnected && !target.hidden) {
      requestAnimationFrame(function () { try { target.focus(); } catch (e) {} });
    }
  }

  document.addEventListener('keydown', function (e) {
    var modal = activeModal;
    if (!modal || modal.hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (modal.id === 'barcode-modal') closeBarcode();
      else hideModal(modal.id);
      return;
    }
    if (e.key !== 'Tab') return;
    var focusables = modalFocusables(modal);
    if (!focusables.length) { e.preventDefault(); return; }
    var first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    } else if (!modal.contains(document.activeElement)) {
      e.preventDefault(); first.focus();
    }
  });

  var CONF_LABEL = {
    high: 'Confiance déclarée par l’IA : élevée',
    medium: 'Confiance déclarée par l’IA : moyenne',
    low: 'Confiance déclarée par l’IA : faible'
  };
  // Forme courte pour la pastille d'un aliment (l'anglais brut y était affiché).
  var CONF_SHORT = { high: 'sûr', medium: 'moyen', low: 'incertain' };

  var HISTORY_SOURCE = {
    photo: '📷 photo',
    texte: '✍️ description',
    manuel: '✍️ manuel'
  };

  // ---------- Installation PWA ----------
  var deferredPrompt = null;

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches ||
           window.navigator.standalone === true;
  }
  function isIOS() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  }

  function initInstall() {
    // Déjà installée / lancée en mode app : rien à proposer.
    if (isStandalone()) return;

    var banner = $('install-banner');
    var btn = $('install-btn');

    // Android/Chrome : on capture l'invite native et on montre notre bouton.
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredPrompt = e;
      banner.hidden = false;
    });

    btn.addEventListener('click', function () {
      if (!deferredPrompt) {
        toast('Utilise le menu du navigateur : « Ajouter à l\'écran d\'accueil ».');
        return;
      }
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function (choice) {
        deferredPrompt = null;
        banner.hidden = true;
        if (choice && choice.outcome === 'accepted') toast('Installation lancée ✓');
      });
    });

    $('install-dismiss').addEventListener('click', function () { banner.hidden = true; });

    window.addEventListener('appinstalled', function () {
      banner.hidden = true;
      deferredPrompt = null;
      toast('App installée ✓');
    });

    // iOS (Safari) : pas de beforeinstallprompt → on affiche la marche à suivre.
    if (isIOS()) {
      var ih = $('ios-install-hint');
      if (ih) {
        ih.hidden = false;
        $('ios-dismiss').addEventListener('click', function () { ih.hidden = true; });
      }
    }
  }

  // ---------- Bandeau de sécurité (non-bloquant) ----------
  function initSafetyBanner() {
    var banner = $('safety-banner');
    if (!banner) return;
    if (!Storage.disclaimerAccepted()) banner.hidden = false;
    var dismiss = $('safety-dismiss');
    if (dismiss) {
      dismiss.addEventListener('click', function () {
        banner.hidden = true;
        Storage.acceptDisclaimer();
      });
    }
  }

  // ---------- Onglets ----------
  function initTabs() {
    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
        document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
        tab.classList.add('active');
        $('tab-' + tab.dataset.tab).classList.add('active');
        if (tab.dataset.tab === 'history') renderHistory();
      });
    });
  }

  // ---------- Photos ----------
  function renderThumbs() {
    var wrap = $('thumbs');
    wrap.innerHTML = '';
    images.forEach(function (img, i) {
      var d = document.createElement('div');
      d.className = 'thumb';
      var q = img.quality;
      // Une pastille sur la vignette : on voit d'un coup d'oeil QUELLE vue pose
      // probleme, ce qu'un message global ne dirait pas.
      var badge = '';
      if (q && q.verdict === 'bad') {
        d.className += ' thumb-bad';
        badge = '<span class="thumb-flag flag-bad">⚠️ ' + escapeHtml(q.issues[0] || 'illisible') + '</span>';
      } else if (q && q.verdict === 'soft') {
        badge = '<span class="thumb-flag flag-soft">' + escapeHtml(q.issues[0] || '') + '</span>';
      }
      d.innerHTML = '<img src="' + img.previewUrl + '" alt="angle ' + (i + 1) + '">' + badge +
                    '<button data-i="' + i + '" aria-label="Retirer">✕</button>';
      wrap.appendChild(d);
    });
    wrap.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        images.splice(parseInt(b.dataset.i, 10), 1);
        renderDepthResult(depthForDisplay(images));
        renderThumbs();
        updateEstimateBtn();
      });
    });
    $('clear-photos').hidden = images.length === 0;
    var ac = $('angle-count');
    if (images.length) {
      ac.hidden = false;
      ac.textContent = images.length + ' / ' + Camera.MAX_ANGLES + ' vue' + (images.length > 1 ? 's' : '');
    } else {
      ac.hidden = true;
    }
    renderPhotoAdvice();
  }

  /* ---------- Conseils sur les photos ----------
     Deux messages, et seulement quand ils servent :

     1) Une vue floue ou mal exposee : le modele estimera quand meme, mais a
        vue, et rien dans le resultat ne dirait que la photo etait la cause.
        Autant le savoir AVANT de payer l'appel et d'attendre.

     2) Une seule vue : la hauteur est la principale inconnue geometrique, le
        prompt le dit lui-meme. Une vue de cote la leve. C'est le levier de
        precision le plus efficace de toute l'app, et jusqu'ici rien ne le
        signalait au moment ou l'on pouvait encore agir. */
  function renderPhotoAdvice() {
    var el = $('photo-advice');
    if (!el) return;
    if (!images.length) { el.hidden = true; return; }

    var mauvaises = images.filter(function (im) {
      return im.quality && im.quality.verdict === 'bad';
    });
    var msgs = [];

    if (mauvaises.length) {
      var quoi = mauvaises.map(function (im) { return im.quality.issues.join(', '); });
      msgs.push('<div class="advice advice-warn">⚠️ ' +
        (mauvaises.length > 1 ? mauvaises.length + ' vues semblent' : 'Une vue semble') +
        ' inexploitable (' + escapeHtml(quoi[0]) + '). Le modèle estimera quand même, ' +
        'mais à vue : reprends-la si tu peux, c\'est ce qui pèse le plus sur la précision.</div>');
    }

    if (images.length === 1) {
      msgs.push('<div class="advice advice-tip">💡 Ajoute une <strong>vue de côté</strong> : ' +
        'sur une seule photo, l\'épaisseur est déduite et non vue — c\'est la principale ' +
        'source d\'erreur sur la portion.</div>');
    }

    el.innerHTML = msgs.join('');
    el.hidden = msgs.length === 0;
  }

  /* ---------- Source de l'estimation : photo ou description ----------
     Ce sont deux méthodes distinctes, pas deux étapes d'une même saisie. Le
     mode est donc porté par l'onglet actif et non déduit de la présence de
     photos : sans ça, ajouter une photo par erreur ferait basculer
     silencieusement une estimation qu'on voulait textuelle. */
  var inputMode = 'photo';
  // Fournisseur/modèle du dernier appel : sert à ne pas reproposer l'identique.
  var lastRunProvider = null, lastRunModel = null;
  // « fournisseur|modèle » des deux avis d'une double analyse, pour ne pas les
  // reproposer à la relance.
  var lastCompareRun = null;

  function describedMeal() {
    var el = $('user-notes');
    return el ? el.value.trim() : '';
  }

  /* ---------- Sous-onglets, mécanisme partagé ----------
     Trois écrans en ont désormais. La sélection est SCOPÉE au conteneur : un
     querySelectorAll global sur .mode-btn ferait basculer les trois ensemble. */
  function selectPane(rootId, name) {
    var root = $(rootId);
    if (!root) return;
    root.querySelectorAll(':scope > .mode-switch > .mode-btn').forEach(function (b) {
      var on = b.dataset.mode === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    root.querySelectorAll(':scope > .mode-pane').forEach(function (p) {
      p.classList.toggle('active', p.dataset.pane === name);
    });
  }

  function initPanes(rootId, onSelect) {
    var root = $(rootId);
    if (!root) return;
    var buttons = Array.prototype.slice.call(
      root.querySelectorAll(':scope > .mode-switch > .mode-btn'));
    var initial = buttons.filter(function (b) {
      return b.classList.contains('active') || b.getAttribute('aria-selected') === 'true';
    })[0] || buttons[0];
    if (initial) selectPane(rootId, initial.dataset.mode);
    buttons.forEach(function (b, index) {
      b.addEventListener('click', function () {
        selectPane(rootId, b.dataset.mode);
        if (onSelect) onSelect(b.dataset.mode);
      });
      b.addEventListener('keydown', function (e) {
        var next = index;
        if (e.key === 'ArrowRight') next = (index + 1) % buttons.length;
        else if (e.key === 'ArrowLeft') next = (index - 1 + buttons.length) % buttons.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = buttons.length - 1;
        else return;
        e.preventDefault();
        buttons[next].click();
        buttons[next].focus();
      });
    });
  }

  function setMode(mode) {
    inputMode = (mode === 'texte') ? 'texte' : 'photo';
    selectPane('tab-analyze', inputMode);

    /* La carte de saisie reste à sa place dans le document et change seulement
       de libellé. Elle était auparavant déplacée dans le volet actif — sans
       aucun effet visuel, le volet Description étant vide, elle se retrouvait
       au même endroit dans les deux cas. Une manipulation du DOM en moins. */
    if (inputMode === 'texte') {
      $('notes-title').firstChild.nodeValue = 'Décris ton repas ';
      $('notes-tag').textContent = 'sans photo';
      $('notes-hint').innerHTML = 'Écris simplement ce que tu manges, en une phrase.';
      $('notes-card').open = true;
      $('notes-card').classList.add('required');
    } else {
      $('notes-title').firstChild.nodeValue = 'Précisions ';
      $('notes-tag').textContent = 'optionnel';
      $('notes-hint').innerHTML = 'Ce que tu sais déjà améliore l\'estimation (ex. « riz basmati ~150 g cuit, pain 60 g »).';
      $('notes-card').classList.remove('required');
    }
    updateEstimateBtn();
  }

  function initModeSwitch() {
    initPanes('tab-analyze', setMode);
    setMode('photo');
  }

  function updateEstimateBtn() {
    var textMode = inputMode === 'texte';
    // En mode description, un dessert ou une boisson suffisent à faire un repas.
    var ready = textMode
      ? (describedMeal().length >= 4 || extrasText().length >= 4)
      : images.length > 0;
    var btn = $('estimate-btn');
    btn.disabled = !ready || estimateBusy;
    $('estimate-btn-label').textContent = estimateBusy
      ? 'Analyse en cours…'
      : (textMode ? 'Estimer d\'après ma description' : 'Estimer les glucides');
    btn.classList.toggle('btn-ready', ready && !estimateBusy);
    updateInputSummaries();

    /* Des photos prises puis laissées de côté ne sont PAS envoyées en mode
       description. On le dit, plutôt que de les ignorer en silence. */
    var warn = $('mode-warning');
    if (warn) {
      if (textMode && images.length) {
        warn.hidden = false;
        warn.innerHTML = '📷 ' + images.length + ' photo' + (images.length > 1 ? 's' : '') +
          ' de côté, non utilisée' + (images.length > 1 ? 's' : '') +
          ' dans ce mode. <button type="button" class="linklike" id="go-photo">Revenir à la photo</button>';
        var go = $('go-photo');
        if (go) go.addEventListener('click', function () { setMode('photo'); });
      } else {
        warn.hidden = true;
      }
    }
  }

  function updateInputSummaries() {
    var notes = describedMeal();
    var notesSummary = $('notes-summary');
    if (notesSummary) notesSummary.textContent = notes ? 'Renseigné' : (inputMode === 'texte' ? 'À remplir' : 'Ajouter');

    var extras = [];
    if (($('extra-dessert').value || '').trim()) extras.push('dessert');
    if (($('extra-drink').value || '').trim()) extras.push('boisson');
    var extrasSummary = $('extras-summary');
    if (extrasSummary) extrasSummary.textContent = extras.length ? extras.join(' + ') : 'Ajouter';

    renderVenue();

    var ref = $('reference-mode');
    var refSummary = $('reference-summary');
    if (ref && refSummary) {
      refSummary.textContent = ref.value === 'none'
        ? 'Rapide'
        : 'Carte GlucoVision';
    }
  }

  function selectedReferenceMode() {
    var el = $('reference-mode');
    return el && el.value === 'glucovision-card-v1' ? 'glucovision-card-v1' : 'none';
  }

  function updateReferenceModeUi() {
    var cardMode = selectedReferenceMode() === 'glucovision-card-v1';
    var guide = $('glucovision-card-guide');
    var card = $('reference-card');
    if (guide) guide.hidden = !cardMode;
    if (card) card.classList.toggle('required', cardMode);
    /* Choisir ce parcours est déjà un consentement explicite. Ne demandons
       pas un second opt-in caché dans les réglages avant d'afficher l'action. */
    if (cardMode && !settings.experimentalDepth) {
      settings.experimentalDepth = true;
      var checkbox = $('set-experimental');
      if (checkbox) checkbox.checked = true;
      Promise.resolve(Storage.saveSettings(settings)).then(function (saved) {
        if (saved) settings = saved;
        updateDepthButtonVisibility();
      }).catch(function () {
        toast('Mode Carte actif pour cette session, mais le réglage n’a pas pu être mémorisé.');
      });
    }
    updateInputSummaries();
    updateDepthButtonVisibility();
    renderDepthResult(depthForDisplay(images));
  }

  /* ---------- Où tu manges ----------
     Le modèle voit l'assiette et rien d'autre. Il ignore qu'une part de
     restaurant est plus grosse et plus riche qu'une part faite maison — un des
     écarts les plus systématiques, et l'un des seuls qu'une photo ne révèle
     jamais. Un appui suffit, et le choix est retenu : dans la vraie vie on
     mange plusieurs repas d'affilée au même endroit.

     Un second appui sur la puce active la désélectionne. Ne rien dire est un
     état légitime : affirmer « maison » un jour où tu es ailleurs enverrait au
     modèle une information fausse, ce qui est pire que pas d'information. */
  function renderVenue() {
    var chips = document.querySelectorAll('.venue-chip');
    if (!chips.length) return;
    var actif = settings.venue || '';
    Array.prototype.forEach.call(chips, function (c) {
      var on = c.getAttribute('data-venue') === actif;
      c.classList.toggle('on', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function initVenue() {
    var chips = document.querySelectorAll('.venue-chip');
    Array.prototype.forEach.call(chips, function (c) {
      c.addEventListener('click', function () {
        var v = c.getAttribute('data-venue');
        settings.venue = (settings.venue === v) ? '' : v;
        Storage.saveSettings(settings);
        renderVenue();
      });
    });
    renderVenue();
  }

  function setExtractStatus(on) {
    var s = $('analyze-status');
    if (on) { s.hidden = false; s.innerHTML = '<div class="spinner"></div>Extraction des images de la vidéo…'; }
    else { s.hidden = true; }
  }

  function addFiles(files) {
    clarificationRepondue = false;
    var arr = Array.prototype.slice.call(files);
    var imgs = arr.filter(function (f) { return /^image\//.test(f.type); });
    var vids = arr.filter(function (f) { return /^video\//.test(f.type); });

    var room = Camera.MAX_ANGLES - images.length;
    if (imgs.length) {
      if (room <= 0) { toast('Maximum ' + Camera.MAX_ANGLES + ' vues.'); }
      else {
        Camera.processFiles(imgs.slice(0, room)).then(function (out) {
          out.results.forEach(function (r) { if (images.length < Camera.MAX_ANGLES) images.push(r); });
          renderThumbs();
          updateEstimateBtn();
          // Une ou plusieurs photos illisibles : on prévient sans bloquer le reste.
          if (out.errors.length) {
            toast(out.results.length
              ? out.errors.length + ' photo(s) ignorée(s) : ' + out.errors[0]
              : out.errors[0]);
          }
        }).catch(function (e) { toast(e.message); });
      }
    }
    vids.forEach(function (v) { addVideoFile(v); });
  }

  function addVideoFile(file) {
    if (images.length >= Camera.MAX_ANGLES) { toast('Maximum ' + Camera.MAX_ANGLES + ' vues.'); return; }
    setExtractStatus(true);
    Camera.processVideo(file, Math.min(Camera.MAX_ANGLES - images.length, 5)).then(function (frames) {
      setExtractStatus(false);
      if (!frames.length) { toast('Aucune image nette extraite. Réessaie avec une vidéo plus stable.'); return; }
      var added = 0;
      frames.forEach(function (f) { if (images.length < Camera.MAX_ANGLES) { images.push(f); added++; } });
      renderThumbs();
      updateEstimateBtn();
      toast(added + ' image(s) extraite(s) de la vidéo.');
    }).catch(function (e) { setExtractStatus(false); toast(e.message); });
  }

  /* Ajoute des images déjà encodées (venant de l'appareil photo natif).
     Elles ne repassent pas par un canvas si elles sont déjà à la bonne taille :
     c'est ce qui évite la seconde compression et fait la qualité supérieure. */
  function addDataUrls(urls, depth) {
    var room = Camera.MAX_ANGLES - images.length;
    if (room <= 0) { toast('Maximum ' + Camera.MAX_ANGLES + ' vues.'); return; }
    var acceptedDepth = verifiedDepth(depth);
    Camera.processDataUrls(urls.slice(0, room)).then(function (out) {
      out.results.forEach(function (r, resultIndex) {
        if (images.length < Camera.MAX_ANGLES) {
          if (depth && resultIndex === 0) {
            r.depth = acceptedDepth || depth;
            if (acceptedDepth) r.reference = referenceFromDepth(acceptedDepth);
          }
          images.push(r);
        }
      });
      renderThumbs();
      if (acceptedDepth) renderDepthResult(depthForDisplay(images));
      updateEstimateBtn();
      if (out.errors.length) toast(out.errors.length + ' photo(s) ignorée(s).');
    }).catch(function (e) { toast(e.message); });
  }

  function safeDepthNumber(v, min, max) {
    return typeof v === 'number' && isFinite(v) && v >= min && v <= max ? v : null;
  }

  function hasVerifiedCardContract(raw) {
    if (!raw || raw.cardRequested !== true || raw.cardVerified !== true ||
        raw.cardFresh !== true || raw.cardSchema !== 'glucovision-card-v1' ||
        raw.cardName !== 'glucovision-card' || raw.cardTrackingMethod !== 'FULL_TRACKING' ||
        !/^(card|card\+depth)$/.test(raw.scaleSource || '')) return false;
    var observations = safeDepthNumber(raw.cardObservations, 4, 1000);
    var width = safeDepthNumber(raw.cardWidthCm, 8.51, 8.61);
    var height = safeDepthNumber(raw.cardHeightCm, 5.348, 5.448);
    if (observations == null || observations !== Math.round(observations) ||
        width == null || height == null) return false;
    return raw.scaleSource !== 'card+depth' ||
      (raw.cardDepthCompared === true && raw.cardDepthAgrees === true);
  }

  /* Une vue ne devient métrique qu'avec les validations positives du natif.
     `!== false` est volontairement interdit : un ancien APK qui omet un champ
     doit être refusé, jamais promu silencieusement. */
  function verifiedDepth(raw) {
    if (!raw || typeof raw !== 'object' || raw.scaleOk !== true || raw.fresh !== true ||
        raw.cardMode !== true || !hasVerifiedCardContract(raw)) return null;
    var width = safeDepthNumber(raw.fieldWidthCm, 1.000001, 250);
    var height = safeDepthNumber(raw.fieldHeightCm, 1.000001, 250);
    var distance = safeDepthNumber(raw.distanceCm, 5, 500);
    var scale = safeDepthNumber(raw.cmPerPixel, 0.0000001, 5);
    if (width == null || height == null || distance == null || scale == null) return null;
    var out = {
      scaleOk: true, fresh: true, cardMode: true, cardVerified: true,
      cardFresh: true, cardSchema: 'glucovision-card-v1', scaleSource: raw.scaleSource,
      cardRequested: raw.cardRequested === true,
      cardDepthCompared: raw.cardDepthCompared === true,
      cardDepthAgrees: raw.cardDepthAgrees === true,
      volumeOk: raw.volumeOk === true,
      fieldWidthCm: width, fieldHeightCm: height,
      distanceCm: distance, cmPerPixel: scale
    };
    ['volumeCm3', 'areaCm2', 'heightMaxCm', 'heightMeanCm', 'samples',
     'confidentPixels', 'coverage', 'observations', 'parallaxCm'].forEach(function (key) {
      var value = safeDepthNumber(raw[key], 0, 1000000);
      if (value != null) out[key] = value;
    });
    var cardObservations = safeDepthNumber(raw.cardObservations, 0, 1000000);
    if (cardObservations != null) out.cardObservations = cardObservations;
    ['cardWidthCm', 'cardHeightCm', 'cardDistanceCm', 'cardFieldWidthCm',
     'cardFieldHeightCm', 'cardCmPerPixel', 'cardIncidenceDeg'].forEach(function (key) {
      var value = safeDepthNumber(raw[key], 0, 1000000);
      if (value != null) out[key] = value;
    });
    ['cardTrackingMethod', 'cardName'].forEach(function (key) {
      if (typeof raw[key] === 'string' && raw[key].length <= 120) out[key] = raw[key];
    });
    ['note', 'diag', 'cardNote'].forEach(function (key) {
      if (typeof raw[key] === 'string' && raw[key].length <= 2000) out[key] = raw[key];
    });
    return out;
  }

  function referenceFromDepth(depth) {
    var reference = {
      mode: 'glucovision-card-v1',
      cardVerified: true,
      cardFresh: true,
      cardSchema: 'glucovision-card-v1',
      scaleSource: depth.scaleSource,
      cardRequested: depth.cardRequested === true,
      cardDepthCompared: depth.cardDepthCompared === true,
      cardDepthAgrees: depth.cardDepthAgrees === true,
      cardObservations: depth.cardObservations || 0,
      cardTrackingMethod: depth.cardTrackingMethod || ''
    };
    ['cardName', 'cardNote', 'cardWidthCm', 'cardHeightCm', 'cardDistanceCm',
     'cardFieldWidthCm', 'cardFieldHeightCm', 'cardCmPerPixel', 'cardIncidenceDeg']
      .forEach(function (key) {
        if (depth[key] !== undefined) reference[key] = depth[key];
      });
    return reference;
  }

  /* Contrat par vue : deux mesures valides restent deux mesures valides. Elles
     ne s'annulent plus mutuellement et chacune garde son index d'image. */
  function viewMeasurementsOfSent(sent, referenceMode) {
    if (referenceMode !== 'glucovision-card-v1') return [];
    var out = [];
    (sent || []).forEach(function (img, i) {
      var depth = verifiedDepth(img && img.depth);
      var reference = img && img.reference;
      if (!depth || !reference || reference.mode !== 'glucovision-card-v1' ||
          !hasVerifiedCardContract(reference) ||
          reference.scaleSource !== depth.scaleSource) return;
      out.push({
        viewIndex: i + 1,
        depth: depth,
        reference: referenceFromDepth(depth)
      });
    });
    return out;
  }

  function depthForDisplay(sent) {
    var views = viewMeasurementsOfSent(sent, selectedReferenceMode());
    if (!views.length) return null;
    return Object.assign({}, views[views.length - 1].depth, {
      verifiedViewCount: views.length,
      viewIndex: views[views.length - 1].viewIndex
    });
  }

  function depthForContextDisplay(ctx) {
    var views = ctx && Array.isArray(ctx.viewMeasurements) ? ctx.viewMeasurements : [];
    if (!views.length) return null;
    var last = views[views.length - 1];
    return Object.assign({}, last.depth, {
      verifiedViewCount: views.length,
      viewIndex: last.viewIndex
    });
  }

  function renderDepthResult(d) {
    lastDepthShown = d || null;
    var el = $('depth-result');
    if (!el) return;
    if (!d) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;

    if (verifiedDepth(d)) {
      var html = '📏 <strong>Carte et échelle ARCore vérifiées</strong> — champ photographié ' +
        Math.round(d.fieldWidthCm || 0) + ' × ' + Math.round(d.fieldHeightCm || 0) +
        ' cm à ' + Math.round(d.distanceCm || 0) + ' cm.';
      if (d.verifiedViewCount > 1) {
        html += '<br><span class="tiny">' + Math.round(d.verifiedViewCount) +
          ' vues mesurées sont conservées séparément.</span>';
      }
      html += '<br><span class="tiny">Carte stable sur ' +
        Math.round(d.cardObservations || d.observations || 0) + ' observations.';
      if (d.scaleSource === 'card+depth') {
        html += ' Profondeur concordante après ' + Math.round(d.parallaxCm || 0) +
          ' cm de déplacement.';
      }
      html += ' Cette mesure sert uniquement à donner l’échelle de cette vue au modèle.</span>';
      if (d.volumeOk) {
        html += '<br><span class="tiny">Relief expérimental : ' +
          Math.round(d.volumeCm3 || 0) + ' cm³. Ce volume est affiché pour le test, ' +
          '<strong>jamais converti directement en glucides</strong>.</span>';
      } else if (d.note) {
        html += '<br><span class="tiny">Relief non retenu : ' + escapeHtml(d.note) + '</span>';
      }
      if (d.diag) html += '<br><span class="mono">' + escapeHtml(d.diag) + '</span>';
      el.className = 'depth-result d-ok';
      el.innerHTML = html;
      return;
    }

    el.className = 'depth-result d-warn';
    el.innerHTML = '📐 <strong>Aucune mesure utilisée</strong> — ' +
      escapeHtml(d.note || (d.fresh !== true
        ? 'la carte de profondeur ne correspond pas exactement à cette image.'
        : (d.cardVerified !== true || d.cardFresh !== true ||
           d.cardSchema !== 'glucovision-card-v1'
          ? 'la Carte GlucoVision n’a pas été vérifiée dans cette vue.'
          : 'la profondeur n’est pas assez fiable.'))) +
      (d.diag ? '<br><span class="mono">' + escapeHtml(d.diag) + '</span>' : '');
  }

  function updateDepthButtonVisibility() {
    var btn = $('btn-depth');
    if (!btn) return;
    var nativeReady = !Native.isApp || Native.platform !== 'android' ||
      (nativeBuild != null && nativeBuild >= MIN_NATIVE_BUILD);
    btn.hidden = !(depthSupported && nativeReady && settings.experimentalDepth &&
      selectedReferenceMode() === 'glucovision-card-v1');
  }

  function initDepth() {
    var btn = $('btn-depth');
    var why = $('depth-why');
    if (!btn) return;
    var say = function (msg) { if (why) why.textContent = msg; };
    if (!Native.isApp || Native.platform !== 'android' || !Native.depth) {
      btn.hidden = true;
      say('Disponible uniquement dans l’APK Android compatible ARCore.');
      return;
    }

    var availabilityBusy = false;
    var checkAvailability = function (attempt) {
      if (availabilityBusy) return;
      availabilityBusy = true;
      Native.depth.available().then(function (a) {
        availabilityBusy = false;
        if (a && a.transient) {
          depthSupported = false;
          btn.hidden = true;
          say('Vérification ARCore temporairement impossible ; nouvel essai automatique…');
          if (attempt < 2) {
            setTimeout(function () { checkAvailability(attempt + 1); }, 1500 * (attempt + 1));
          }
          return;
        }
        if (!a || !a.supported) {
          depthSupported = false;
          btn.hidden = true;
          say('ARCore non pris en charge sur ce téléphone (' +
            ((a && a.reason) || 'inconnu') + ').');
          return;
        }
        depthSupported = true;
        say(a.installed
          ? 'ARCore est disponible. Choisis Carte GlucoVision puis utilise « Photo mesurée ».'
          : 'ARCore est compatible ; Google Play Services pourra demander son installation au premier essai.');
        updateDepthButtonVisibility();
      }).catch(function () {
        availabilityBusy = false;
        depthSupported = false;
        btn.hidden = true;
        say('Vérification ARCore impossible pour le moment.');
      });
    };
    checkAvailability(0);
    if (Native.onResume) {
      Native.onResume(function () {
        if (!depthSupported) checkAvailability(0);
      });
    }

    btn.addEventListener('click', function () {
      if (btn.disabled || images.length >= Camera.MAX_ANGLES) return;
      btn.disabled = true;
      var old = btn.textContent;
      btn.textContent = 'Mesure…';
      Native.depth.capture({ cardMode: true }).then(function (r) {
        if (!r || r.cancelled) return;
        if (r.error) { toast('Photo mesurée : ' + r.error); return; }
        renderDepthResult(r.depth || null);
        if (r.urls && r.urls.length) addDataUrls(r.urls, r.depth || null);
      }).catch(function (e) {
        toast('Photo mesurée indisponible : ' + ((e && e.message) || 'erreur'));
      }).then(function () {
        btn.disabled = false;
        btn.textContent = old;
      });
    });
  }

  /* APK : on détourne les boutons vers l'appareil photo du système au lieu du
     champ <input type=file>. Le champ reste en place et sert de repli si le
     plugin échoue — et c'est lui qui est utilisé tel quel dans la PWA. */
  function initNativePhotoButtons() {
    if (!Native.isApp) return;

    var wire = function (labelId, run) {
      var el = $(labelId);
      if (!el) return;
      el.addEventListener('click', function (e) {
        e.preventDefault();   // empêche le <label> d'ouvrir le champ fichier
        if (images.length >= Camera.MAX_ANGLES) { toast('Maximum ' + Camera.MAX_ANGLES + ' vues.'); return; }
        run().then(function (urls) {
          if (urls && urls.length) addDataUrls(urls);
        }).catch(function (err) {
          // Annulation par l'utilisateur : silence. Vraie panne : on le dit.
          var m = (err && err.message) || '';
          if (/cancel|annul/i.test(m)) return;
          toast('Appareil photo indisponible : ' + (m || 'accès refusé ?'));
        });
      });
    };

    wire('btn-photo', function () { return Native.camera.capture(false); });
    wire('btn-gallery', function () {
      return Native.camera.pickMany(Camera.MAX_ANGLES - images.length);
    });
  }

  function initPhotos() {
    initNativePhotoButtons();
    ['btn-photo', 'btn-video', 'btn-gallery'].forEach(function (id) {
      var trigger = $(id);
      if (!trigger) return;
      trigger.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        trigger.click();
      });
    });
    $('camera-input').addEventListener('change', function (e) {
      if (e.target.files.length) addFiles(e.target.files);
      e.target.value = '';
    });
    $('video-input').addEventListener('change', function (e) {
      if (e.target.files.length) addFiles(e.target.files);
      e.target.value = '';
    });
    $('gallery-input').addEventListener('change', function (e) {
      if (e.target.files.length) addFiles(e.target.files);
      e.target.value = '';
    });
    $('clear-photos').addEventListener('click', function () {
      clarificationRepondue = false;
      images = [];
      lastDepthShown = null;
      renderDepthResult(null);
      renderThumbs(); updateEstimateBtn();
    });
    $('reference-mode').addEventListener('change', updateReferenceModeUi);
    updateReferenceModeUi();
    // La saisie d'une description active à elle seule le bouton d'estimation.
    $('user-notes').addEventListener('input', updateEstimateBtn);
    ['extra-dessert', 'extra-drink'].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener('input', updateEstimateBtn);
    });
  }

  // ---------- Estimation IA ----------
  function initEstimate() {
    $('estimate-btn').addEventListener('click', runEstimate);
  }

  function runEstimate(options) {
    /* Un changement de texte ou de photo rappelle updateEstimateBtn(). Sans cet
       verrou il pouvait réactiver le bouton pendant l'appel : une ancienne
       réponse arrivée en dernier remplaçait alors le repas le plus récent. */
    if (estimateBusy) return;
    /* Une réponse à la question de clarification relance LE MÊME repas. Tous
       les autres appels viennent d'une nouvelle intention utilisateur et
       doivent pouvoir poser leur propre question, même dans la même session. */
    var preserveClarification = !!(options && options.preserveClarification === true);
    if (!preserveClarification) clarificationRepondue = false;
    var preservedHistoryDate = preserveClarification ? currentHistoryDate : null;
    var preservedHistoryPhotoStarted = preserveClarification && currentHistoryPhotoStarted;
    estimateBusy = true;
    var runGeneration = ++estimateGeneration;
    var status = $('analyze-status');
    var resultsEl = $('results');
    resultsEl.hidden = true;
    status.hidden = false;
    updateEstimateBtn();
    /* La clarification corrige le brouillon existant ; elle ne crée pas un
       deuxième repas avec l'ancien chiffre encore confirmable dans l'historique. */
    currentHistoryDate = preservedHistoryDate;
    currentHistoryConfirmed = false;
    currentHistoryPhotoStarted = preservedHistoryPhotoStarted;
    currentChoiceRequired = false;
    currentDominantConfirmed = false;
    resumedPhotoDraft = false;
    lastVerification = null;

    // En mode description, les photos éventuelles ne sont pas envoyées.
    var textOnly = inputMode === 'texte';
    /* Snapshot de la sélection : l'utilisateur peut modifier ses photos pendant
       l'attente, mais le résultat doit rester attaché à ce qui a été envoyé. */
    var sent = textOnly ? [] : images.slice();
    lastEstimateImages = sent.slice();
    var previousContext = preserveClarification && lastEstimateContext
      ? lastEstimateContext : null;
    var previousMealAt = previousContext && typeof previousContext.mealAt === 'number' &&
      isFinite(previousContext.mealAt) ? previousContext.mealAt : null;
    var previousVenue = previousContext && /^(maison|restaurant|cantine)$/.test(
      previousContext.venue || '') ? previousContext.venue : '';
    var referenceMode = textOnly ? 'none' : selectedReferenceMode();
    var ctx = {
      referenceMode: referenceMode,
      notes: $('user-notes').value,
      extras: extrasText(),       // dessert / boisson, absents de la photo
      imageCount: sent.length,    // 0 fait basculer l'estimateur en mode description
      viewMeasurements: textOnly ? [] : viewMeasurementsOfSent(sent, referenceMode),
      /* Contexte du repas. mealAt est figé ICI, à l'envoi : si l'estimation est
         mise en file d'attente et rejouée à 2 h du matin, elle doit rester le
         dîner qu'elle était, pas devenir une collation. */
      mealAt: previousMealAt || Date.now(),
      venue: previousContext ? previousVenue : (settings.venue || ''),
      clarificationAnswered: preserveClarification && clarificationRepondue
    };
    lastEstimateContext = safePendingContext(ctx, sent.length);

    var isCurrentRun = function () { return runGeneration === estimateGeneration; };
    var finishRun = function () {
      if (!isCurrentRun()) return;
      estimateBusy = false;
      updateEstimateBtn();
    };

    var cmp = settings.verifyProvider;
    var wantCompare = settings.verificationMode === 'ask' && cmp && cmp !== settings.provider &&
                      $('compare-wrap') && !$('compare-wrap').hidden && $('compare-toggle').checked;

    if (wantCompare) {
      status.innerHTML = '<div class="spinner"></div>Double analyse en cours (' +
        (PROVIDER_NAME[settings.provider] || settings.provider) + ' + ' +
        (PROVIDER_NAME[cmp] || cmp) + ')… cela peut prendre 20 à 40 s.';
      // On lance les deux fournisseurs en parallèle ; chacun peut échouer indépendamment.
      var wrap = function (p) {
        return Promise.resolve().then(function () {
          return Estimator.estimateWith(p, sent, ctx, settings);
        })
          .then(function (r) { return { ok: true, provider: p, result: r }; })
          .catch(function (e) {
            return { ok: false, provider: p, error: e.message, cause: e };
          });
      };
      var mdl = settings.models || {};
      lastCompareRun = [settings.provider + '|' + (mdl[settings.provider] || ''),
                        cmp + '|' + (mdl[cmp] || '')];
      lastRunProvider = null; lastRunModel = null;
      Promise.all([wrap(settings.provider), wrap(cmp)]).then(function (pair) {
        if (!isCurrentRun()) return;
        status.hidden = true;
        var a = pair[0], b = pair[1];
        if (!a.ok && !b.ok) {
          /* Le double avis est le parcours par défaut. Il doit proposer la même
             sauvegarde hors-ligne que l'appel simple si les deux réseaux tombent. */
          var network = [a, b].filter(function (x) {
            return x.cause && Queue.isNetworkError(x.cause);
          })[0];
          offerQueue((network && network.cause) || a.cause || b.cause ||
            new Error(a.error || b.error || 'Analyse impossible.'), ctx, sent);
          return;
        }
        renderCompare([a, b]);
      }).catch(function (e) {
        if (isCurrentRun()) offerQueue(e, ctx, sent);
      }).then(finishRun);
      return;
    }

    status.innerHTML = '<div class="spinner"></div>' + (textOnly
      ? 'Estimation d\'après ta description… interprétation des portions et calcul des glucides.'
      : 'Analyse en cours… identification des aliments, estimation des portions et calcul des glucides. Le raisonnement peut prendre 10 à 30 s.');
    /* Vérification croisée : lancée EN PARALLÈLE, jamais en série. Elle ne doit
       pas retarder le chiffre dont l'utilisateur a besoin pour doser — elle
       arrive après et complète l'affichage. Son échec est sans conséquence. */
    var verify = startVerification(sent, ctx);

    lastCompare = null;
    lastComparisonArchive = null;
    oublierEnCours();
    lastCompareRun = null;
    lastRunProvider = settings.provider;
    lastRunModel = (settings.models || {})[settings.provider] || null;
    Promise.resolve().then(function () {
      return estimateWithFallback(sent, ctx, status);
    }).then(function (result) {
      if (!isCurrentRun()) return;
      lastResult = result;
      status.hidden = true;
      renderResults(result);
      attachVerification(verify, runGeneration);
    }).catch(function (e) {
      if (!isCurrentRun()) return;
      status.hidden = true;
      offerQueue(e, ctx, sent);
    }).then(finishRun);
  }

  /* Rejoue l'estimation chez un AUTRE fournisseur quand le principal échoue.

     Le moment où une estimation échoue est le pire de tous : l'assiette est
     déjà entamée, ou on a quitté la table, et la photo ne peut plus être
     refaite. Perdre le repas pour une panne d'API n'est pas acceptable, alors
     qu'un second appel chez un fournisseur indépendant aboutit dans la plupart
     des cas — panne de service, quota dépassé, clé expirée, surcharge
     temporaire : aucune de ces causes n'est partagée entre deux entreprises.

     Trois règles, dans cet ordre d'importance :

     1. Le secours n'est JAMAIS silencieux. Le modèle qui a produit le chiffre
        n'est pas celui que l'utilisateur a choisi, et ce chiffre sert à doser
        de l'insuline : un bandeau le dit, et lastRunProvider est mis à jour
        pour que le reste de l'écran reste cohérent.
     2. Il ne coûte rien tant que tout va bien — l'appel n'a lieu qu'après un
        échec, jamais en parallèle.
     3. Si le secours échoue aussi, c'est l'erreur du PRINCIPAL qui remonte.
        C'est elle qui décrit le problème réel de l'utilisateur ; annoncer
        « Grok a échoué » quand sa clé Gemini est expirée l'enverrait chercher
        au mauvais endroit. */
  function estimateWithFallback(sent, ctx, status) {
    var primaire = settings.provider;
    var secours = settings.fallbackProvider;
    var cles = settings.apiKeys || {};
    var utilisable = secours && secours !== primaire && cles[secours];

    return Estimator.estimate(sent, ctx, settings).catch(function (err) {
      if (!utilisable) throw err;
      if (status) {
        status.hidden = false;
        status.innerHTML = '<div class="spinner"></div>' +
          escapeHtml(PROVIDER_NAME[primaire] || primaire) + ' n\'a pas répondu — ' +
          'nouvel essai avec ' + escapeHtml(PROVIDER_NAME[secours] || secours) + '…';
      }
      return Estimator.estimateWith(secours, sent, ctx, settings)
        .then(function (r) {
          r.fallbackFrom = primaire;
          r.fallbackTo = secours;
          lastRunProvider = secours;
          lastRunModel = (settings.models || {})[secours] || null;
          return r;
        })
        .catch(function () { throw err; });
    });
  }

  /* Échec réseau : plutôt que de perdre le repas, on propose de le garder.
     C'est le moment où on ne peut PAS refaire la photo — l'assiette est entamée
     ou on a déjà quitté la table. Une erreur de clé ou de quota, elle, échouerait
     tout autant plus tard : on ne met en file que ce qui a une chance d'aboutir. */
  function offerQueue(err, ctx, sent) {
    /* On ne met en file que ce qui a réellement été envoyé. En mode description
       il n'y a pas d'image — rien n'est perdu, la phrase reste dans le champ. */
    if (!Queue.isAvailable() || !Queue.isNetworkError(err) || !sent || !sent.length) {
      toast(err.message);
      return;
    }
    if (!confirm(err.message + '\n\nGarder ce repas et l\'analyser dès que le réseau revient ?')) {
      toast(err.message);
      return;
    }
    Queue.add(sent, ctx).then(function (id) {
      if (!id) { toast(err.message); return; }
      images = [];
      renderThumbs();
      updateEstimateBtn();
      renderQueue();
      toast('Repas mis de côté. Il sera analysé au retour du réseau.');
    }).catch(function (e) { toast(e.message); });
  }

  // ---------- File d'attente hors-ligne ----------
  var queueBusy = false;

  function renderQueue() {
    var el = $('queue-banner');
    if (!el) return;
    var n = Queue.isAvailable() ? Queue.count() : 0;
    el.hidden = n === 0;
    if (n) {
      $('queue-text').textContent = n + ' repas en attente de réseau';
      $('queue-retry').disabled = queueBusy;
    }
  }

  /* Traite la file, un repas à la fois. En série et non en parallèle : au retour
     du réseau la connexion est souvent encore fragile, et enchaîner évite de
     relancer cinq analyses qui échoueraient toutes ensemble. */
  function processQueue(manual) {
    if (!Queue.isAvailable() || queueBusy) return;
    var pending = Queue.list();
    if (!pending.length) { renderQueue(); return; }
    if (!navigator.onLine && !manual) return;

    queueBusy = true;
    renderQueue();
    var stoppedBy = null;

    var next = function (i) {
      if (i >= pending.length) return Promise.resolve();
      var item = pending[i];
      var loadedImages = null;
      var historyPhoto = null;
      var historySaved = false;
      return Queue.load(item)
        .then(function (imgs) {
          loadedImages = imgs;
          return Estimator.estimate(imgs, item.ctx, settings);
        })
        .then(function (result) {
          /* La photo HD est copiée dans l'historique AVANT de retirer les
             fichiers de file. Si cette copie, l'écriture de l'historique ou
             la suppression de l'index échoue, le repas reste récupérable. */
          if (!loadedImages || !loadedImages[0] || !loadedImages[0].base64) {
            throw new Error('La photo du repas en attente est illisible.');
          }
          var media = loadedImages[0].mediaType || 'image/jpeg';
          var extension = media === 'image/png' ? '.png' :
            (media === 'image/webp' ? '.webp' : '.jpg');
          historyPhoto = 'meal-' + item.date + extension;
          return Native.photos.save(historyPhoto,
            'data:' + media + ';base64,' + loadedImages[0].base64).then(function (name) {
            if (!name) throw new Error('Impossible de conserver la photo dans l\'historique.');

            var blocked = !!(result.blocking && result.blocking.length);
            var dominant = dominantItem(result);
            var entry = {
              date: item.date,
              queueId: item.id,
              source: 'photo',
              // Gardé au niveau du repas, pas seulement dans input : c'est ce
              // qui rendra possible une calibration PAR LIEU plus tard.
              venue: (item.ctx && item.ctx.venue) || '',
              draft: true,
              confirmed: false,
              blocked: blocked,
              blocking: blocked ? result.blocking.slice(0, 10) : [],
              dominantRequired: !!dominant,
              dominantConfirmed: false,
              totalCarbsG: result.totalCarbsG,
              parts: partsFrom(result.totalCarbsG),
              partSizeG: settings.partSizeG,
              provider: result.provider || settings.provider,
              model: result.model || (settings.models || {})[settings.provider] || '',
              glycemicSpeed: result.glycemicSpeed || null,
              gi: result.gi ? { gl: result.gi.gl, gi: result.gi.gi } : null,
              seen: result.seen || '',
              photo: name,
              input: item.ctx ? {
                referenceMode: item.ctx.referenceMode || 'none',
                notes: item.ctx.notes || '',
                extras: item.ctx.extras || '',
                imageCount: item.ctx.imageCount || 0,
                viewMeasurements: item.ctx.viewMeasurements || [],
                mealAt: item.ctx.mealAt || item.date || Date.now(),
                venue: item.ctx.venue || '',
                clarificationAnswered: item.ctx.clarificationAnswered === true
              } : null,
              items: (result.items || []).map(function (it) {
                return { name: it.name, carbsG: it.carbsG,
                         portion: it.portionDescription || '', added: !!it.added };
              })
            };
            try { entry.resultSnapshot = JSON.parse(JSON.stringify(result)); }
            catch (e) { entry.resultSnapshot = null; }

            var saved = Storage.addHistory(entry);
            if (!saved) throw new Error('Impossible d\'enregistrer le repas analysé.');
            historySaved = saved.some(function (e) {
              return e.date === item.date && e.queueId === item.id && e.photo === name;
            });
            if (!historySaved) {
              throw new Error('Le repas n\'a pas pu être vérifié après son enregistrement.');
            }
            return Queue.remove(item.id);
          }).then(function (removed) {
            if (!removed) throw new Error('Le repas est enregistré, mais la file n\'a pas pu être mise à jour.');
            var blocked = !!(result.blocking && result.blocking.length);
            // L'utilisateur n'a pas l'app sous les yeux : c'est le rôle d'une notification.
            Native.notify.schedule({
              id: Math.floor(item.date / 1000),
              title: blocked ? 'Repas à vérifier' : 'Estimation prête',
              body: blocked
                ? 'Ouvre GlucoVision : le repas mis de côté demande une vérification.'
                : 'Ouvre GlucoVision : le repas mis de côté est prêt à être vérifié.',
              at: new Date(Date.now() + 1000)
            });
            return next(i + 1);
          });
        })
        .catch(function (e) {
          /* Même une clé expirée ou une réponse incohérente ne justifie pas de
             détruire les seules photos d'un repas déjà mangé. On s'arrête au
             premier échec et le bouton Réessayer reste disponible. */
          stoppedBy = e || new Error('Analyse interrompue.');
          if (historyPhoto && !historySaved) Native.photos.remove(historyPhoto);
        });
    };

    next(0).catch(function (e) { stoppedBy = stoppedBy || e; }).then(function () {
      queueBusy = false;
      renderQueue();
      if ($('tab-history').classList.contains('active')) renderHistory();
      if (manual && stoppedBy) {
        toast('Repas conservé dans la file : ' + (stoppedBy.message || 'analyse impossible.'));
      }
    });
  }

  /* Raccourcis de l'écran d'accueil (appui long sur l'icône).
     Au restaurant on ne veut pas ouvrir l'app, choisir un onglet puis appuyer
     sur Photo : le raccourci déclenche directement l'appareil photo. */
  function initShortcuts() {
    Native.onLaunchAction(function (action) {
      if (action === 'photo') {
        selectTab('analyze');
        // Laisse le rendu se poser avant d'ouvrir l'appareil photo natif.
        setTimeout(function () {
          var btn = $('btn-photo');
          if (btn) btn.click();
        }, 250);
      } else if (action === 'manuel') {
        selectTab('manual');
      }
    });
  }

  function selectTab(name) {
    var tab = document.querySelector('.tab[data-tab="' + name + '"]');
    if (tab) tab.click();
  }

  function initQueue() {
    if (!Queue.isAvailable()) return;
    var retry = $('queue-retry');
    if (retry) retry.addEventListener('click', function () { processQueue(true); });
    window.addEventListener('online', function () { processQueue(false); });
    Native.onResume(function () { processQueue(false); });
    renderQueue();
    processQueue(false);
  }

  // Affiche les deux avis côte à côte, avec un bouton « Utiliser cet avis ».
  /* Sauvegarde de l'écran de comparaison lui-même.

     Le brouillon d'historique sauve le repas ; il ne rend pas les DEUX avis,
     qui sont précisément ce qu'on était en train de comparer. Les résultats
     sont du JSON de quelques kilo-octets — les photos, elles, ne sont pas
     reprises : elles ne tiendraient pas dans le quota du navigateur, et sur
     l'APK elles sont déjà rattachées au brouillon d'historique. */
  var CLE_EN_COURS = 'diabete.encours.v1';
  var MAX_AGE_EN_COURS = 12 * 3600000;
  var MAX_EN_COURS_CHARS = 250000;

  function safePendingContext(raw, fallbackImageCount) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var text = function (v, max) {
      return typeof v === 'string' ? v.trim().slice(0, max) : '';
    };
    var num = function (v, min, max) {
      return typeof v === 'number' && isFinite(v) && v >= min && v <= max ? v : null;
    };
    var count = num(raw.imageCount, 0, Camera.MAX_ANGLES);
    var referenceMode = raw.referenceMode === 'glucovision-card-v1'
      ? 'glucovision-card-v1' : 'none';
    var ctx = {
      referenceMode: referenceMode,
      notes: text(raw.notes, 4000),
      extras: text(raw.extras, 4000),
      imageCount: count == null ? (fallbackImageCount || 0) : Math.round(count)
    };
    var mealAt = num(raw.mealAt, 946684800000, 4102444800000);
    if (mealAt != null) ctx.mealAt = mealAt;
    var venue = text(raw.venue, 20);
    if (/^(maison|restaurant|cantine)$/.test(venue)) ctx.venue = venue;
    if (raw.clarificationAnswered === true) ctx.clarificationAnswered = true;
    ctx.viewMeasurements = [];
    if (referenceMode === 'glucovision-card-v1' && Array.isArray(raw.viewMeasurements)) {
      var seenViews = {};
      raw.viewMeasurements.forEach(function (measurement) {
        if (!measurement || typeof measurement !== 'object') return;
        var viewIndex = num(measurement.viewIndex, 1, Camera.MAX_ANGLES);
        var reference = measurement.reference;
        var depth = verifiedDepth(measurement.depth);
        if (viewIndex == null || viewIndex !== Math.round(viewIndex) ||
            viewIndex > ctx.imageCount || seenViews[viewIndex] || !depth ||
            !reference || reference.mode !== 'glucovision-card-v1' ||
            !hasVerifiedCardContract(reference) ||
            reference.scaleSource !== depth.scaleSource) return;
        seenViews[viewIndex] = true;
        ctx.viewMeasurements.push({
          viewIndex: viewIndex,
          depth: depth,
          reference: referenceFromDepth(depth)
        });
      });
      ctx.viewMeasurements.sort(function (a, b) { return a.viewIndex - b.viewIndex; });
    }
    return ctx;
  }

  function safePendingOpinions(raw, ctx) {
    if (!Array.isArray(raw)) return [];
    var allowed = Storage.PROVIDERS || [];
    return raw.slice(0, 3).map(function (x) {
      if (!x || typeof x !== 'object' || allowed.indexOf(x.provider) < 0) return null;
      if (!x.ok) {
        return { ok: false, provider: x.provider,
          error: typeof x.error === 'string' ? x.error.slice(0, 1000) : 'pas de réponse' };
      }
      if (!x.result || typeof x.result !== 'object' || !Estimator.sanitize) return null;
      try {
        var result = Estimator.sanitize(x.result, ctx);
        result.provider = x.provider;
        result.model = typeof x.result.model === 'string' ? x.result.model.slice(0, 200) : '';
        return { ok: true, provider: x.provider, result: result };
      } catch (e) { return null; }
    }).filter(Boolean);
  }

  function sauverEnCours(avis) {
    try {
      var fallback = avis && avis.some(function (x) {
        return x && x.ok && x.result && x.result.fromText === false;
      }) ? 1 : 0;
      var ctx = safePendingContext(lastEstimateContext, fallback);
      var safeAvis = safePendingOpinions(avis, ctx);
      if (safeAvis.length < 2 || !safeAvis.some(function (x) { return x.ok; })) return false;
      var encoded = JSON.stringify({
        version: 2,
        ts: Date.now(),
        date: currentHistoryDate,
        ctx: ctx,
        avis: safeAvis
      });
      if (encoded.length > MAX_EN_COURS_CHARS) return false;
      localStorage.setItem(CLE_EN_COURS, encoded);
      return true;
    } catch (e) { /* quota : le brouillon d'historique reste, lui */ }
    return false;
  }
  function oublierEnCours() {
    try { localStorage.removeItem(CLE_EN_COURS); } catch (e) {}
  }
  function restaurerEnCours() {
    var d = null;
    var raw = null;
    try { raw = localStorage.getItem(CLE_EN_COURS); } catch (e) { return; }
    if (!raw || raw.length > MAX_EN_COURS_CHARS) { oublierEnCours(); return; }
    try { d = JSON.parse(raw); } catch (e2) { oublierEnCours(); return; }
    var age = Date.now() - (d && Number(d.ts));
    if (!d || !isFinite(age) || age < -300000 || age > MAX_AGE_EN_COURS) {
      oublierEnCours(); return;
    }
    var fallback = d.avis && d.avis.some(function (x) {
      return x && x.ok && x.result && x.result.fromText === false;
    }) ? 1 : 0;
    var ctx = safePendingContext(d.ctx, fallback);
    var avis = safePendingOpinions(d.avis, ctx);
    if (avis.length < 2 || !avis.some(function (x) { return x.ok; })) {
      oublierEnCours(); return;
    }
    currentHistoryDate = typeof d.date === 'number' && isFinite(d.date) && d.date > 0
      ? d.date : null;
    currentHistoryConfirmed = false;
    currentHistoryPhotoStarted = true;
    currentDominantConfirmed = false;
    lastEstimateContext = ctx;
    clarificationRepondue = ctx.clarificationAnswered === true;
    images = [];
    lastEstimateImages = [];
    resumedPhotoDraft = ctx.imageCount > 0;
    if (ctx.notes && $('user-notes')) $('user-notes').value = ctx.notes;
    renderCompare(avis);
    toast('Estimation retrouvée — elle n\'avait pas encore été validée.');
  }

  /* Les avis actuellement affichés côte à côte. Conservé pour qu'une relance
     AJOUTE une colonne au lieu de remplacer l'écran : après avoir demandé un
     troisième avis pour départager les deux premiers, les faire disparaître
     serait exactement le contraire du service rendu. */
  var lastCompare = null;
  var lastComparisonArchive = null;

  function renderCompare(avis, reviewOnly) {
    var el = $('results');
    avis = (avis || []).map(function (x) {
      if (x && x.ok && x.result && x.result.blocking && x.result.blocking.length) {
        return {
          ok: false,
          provider: x.provider,
          error: 'Résultat incohérent refusé : ' + x.result.blocking.join(' ')
        };
      }
      return x;
    });
    lastCompare = avis;
    if (!reviewOnly) currentChoiceRequired = true;
    /* Archive indépendante : corriger ensuite le résultat retenu ne doit ni
       réécrire les colonnes d'origine, ni falsifier les avis conservés dans
       l'historique. */
    try { lastComparisonArchive = JSON.parse(JSON.stringify(avis)); }
    catch (e) { lastComparisonArchive = avis.slice(); }

    /* Présentation en TABLEAU et non en cartes côte à côte. Des cartes obligent
       l'œil à faire l'aller-retour pour comparer chaque grandeur : le total de
       gauche avec celui de droite, puis la fourchette avec la fourchette. Un
       tableau aligne les grandeurs comparables sur la même ligne, ce qui est
       précisément le geste demandé ici. */
    /* En-tête : le MODÈLE en gros, le fournisseur en dessous. Comparer trois
       avis, c'est comparer trois modèles — « OpenRouter » ne dit pas lequel a
       répondu, et le mot se coupait en plein milieu dans une colonne étroite.
       Le libellé vient du catalogue, qui porte des noms courts et lisibles. */
    function nomDe(x) {
      var id = x.ok && x.result && x.result.model;
      var cat = (Storage.MODEL_CATALOG || {})[x.provider] || [];
      for (var i = 0; i < cat.length; i++) {
        if (cat[i].id === id) return cat[i].label;
      }
      /* Un modèle OpenRouter personnalisé ne doit pas devenir une énième
         colonne « OpenRouter ». Le dernier segment de son identifiant reste
         court, distinct et permet de savoir quel avis on choisit. */
      if (id) return String(id).split('/').pop().replace(/[-_]+/g, ' ');
      return PROVIDER_NAME[x.provider] || x.provider;
    }
    function sousTitreDe(x) { return PROVIDER_NAME[x.provider] || x.provider; }
    function ligne(intitule, rendu, classe) {
      var h = '<tr' + (classe === 'cmp-big' ? ' class="cmp-row-main"' : '') + '>' +
              '<th scope="row" class="cmp-metric">' + intitule + '</th>';
      avis.forEach(function (x) {
        h += x.ok
          ? '<td class="cmp-td' + (classe ? ' ' + classe : '') + '">' + rendu(x.result) + '</td>'
          : '<td class="cmp-td cmp-td-fail">—</td>';
      });
      return h + '</tr>';
    }

    var ok = avis.filter(function (x) { return x.ok; });
    var totaux = ok.map(function (x) { return x.result.totalCarbsG; });
    var duplicateModel = Estimator.sameUnderlyingModel(ok.map(function (x) {
      return x.result.model;
    }));

    var memeContenu = true;
    for (var ci = 1; ci < ok.length && memeContenu; ci++) {
      if (!foodComparison(ok[0].result.items, ok[ci].result.items).same) {
        memeContenu = false;
      }
    }

    var html = '<div class="cmp-head">' +
      '<span class="cmp-kicker">COMPARAISON</span>' +
      '<h2 id="cmp-title">' + avis.length + ' estimations côte à côte</h2>' +
      '<p class="hint">Compare le total et surtout sa répartition par aliment. ' +
      'Aucun avis n’est présélectionné : retiens celui qui décrit le mieux ton assiette.</p>' +
      '</div>';

    if (duplicateModel) {
      html += '<div class="cmp-warn">⚠️ <strong>Deux colonnes viennent du même modèle.</strong> ' +
        'Elles ont été obtenues par des routes différentes, mais ne constituent pas deux ' +
        'avis indépendants. Leur accord ne confirme donc rien.</div>';
    }

    // Divergence : annoncée AVANT le tableau, sinon elle se lit après la décision.
    if (totaux.length > 1) {
      var lo = Math.min.apply(null, totaux), hi = Math.max.apply(null, totaux);
      var moy = Math.round(totaux.reduce(function (a2, b2) { return a2 + b2; }, 0) / totaux.length);
      var diff = hi - lo;
      var rel = moy ? diff / moy : 0;
      if (rel > 0.20 && diff >= 10) {
        html += '<div class="cmp-warn">⚠️ <strong>Les avis divergent nettement</strong> — ' +
          diff + ' g d\'écart (' + Math.round(rel * 100) + ' %). Ne prends pas la moyenne : ' +
          (avis.length > 2
            ? 'regarde le détail par aliment pour comprendre lequel se trompe.'
            : 'demande le troisième avis ci-dessous, ou compare le détail par aliment.') + '</div>';
      }
    }

    if (avis.length > 2) {
      html += '<p class="cmp-scrollhint">↔ Fais glisser le tableau pour voir chaque modèle.</p>';
    }
    html += '<div class="cmp-tablewrap" role="region" aria-labelledby="cmp-title" tabindex="0">' +
      '<table class="cmp-table cmp-table-' + avis.length + '">' +
      '<caption class="sr-only">Comparaison détaillée de ' + avis.length + ' estimations</caption>' +
      '<colgroup><col class="cmp-col-metric">' + avis.map(function () {
        return '<col class="cmp-col-model">';
      }).join('') + '</colgroup><thead><tr><th class="cmp-metric" scope="col">Mesure</th>';
    avis.forEach(function (x) {
      // Sur un avis en échec le modèle est inconnu : le libellé retombe sur le
      // fournisseur, et l'afficher deux fois n'apprend rien.
      var titre = nomDe(x), sous = sousTitreDe(x);
      html += '<th scope="col" class="cmp-th">' + escapeHtml(titre) +
        (sous === titre ? '' : '<span class="cmp-model">' + escapeHtml(sous) + '</span>') + '</th>';
    });
    html += '</tr></thead><tbody>';

    html += ligne('Glucides', function (r) { return r.totalCarbsG + '<small> g</small>'; }, 'cmp-big');
    html += ligne('Parts', function (r) { return fr(partsFrom(r.totalCarbsG)); });
    html += ligne('Fourchette', function (r) { return r.rangeLowG + ' – ' + r.rangeHighG + ' g'; }, 'cmp-soft');
    html += ligne('Confiance', function (r) {
      return '<span class="confidence conf-' + r.overallConfidence + '">' +
             CONF_LABEL[r.overallConfidence] + '</span>'; });
    html += ligne('Aliments', function (r) {
      var items = (r.items || []).slice(0, 12);
      if (!items.length) return '<span class="cmp-empty">Aucun détail</span>';
      return '<ul class="cmp-food-list">' + items.map(function (it) {
        var portion = it.portionDescription || (it.estimatedMassG != null
          ? '≈ ' + Math.round(it.estimatedMassG) + ' g' : '');
        return '<li><span class="cmp-food-name">' + escapeHtml(it.name) + '</span>' +
          (portion ? '<small>' + escapeHtml(portion) + '</small>' : '') +
          '<strong>' + Math.round(it.carbsG || 0) + ' g</strong></li>';
      }).join('') + '</ul>';
    }, 'cmp-food');

    // Un échec ne doit pas disparaître derrière un tiret : on dit lequel et pourquoi.
    if (ok.length !== avis.length) {
      html += '<tr><th scope="row" class="cmp-metric">Échec</th>';
      avis.forEach(function (x) {
        html += '<td class="cmp-td cmp-err">' + (x.ok ? '' : escapeHtml(x.error || 'pas de réponse')) + '</td>';
      });
      html += '</tr>';
    }

    html += '<tr class="cmp-row-actions"><td class="cmp-metric"></td>';
    avis.forEach(function (x, i) {
      var modelName = nomDe(x);
      html += '<td class="cmp-td">' + (x.ok
        ? '<button class="btn btn-primary cmp-use" data-i="' + i +
          '" aria-label="Retenir l’estimation de ' + escapeHtml(modelName) + '">Retenir</button>' : '') + '</td>';
    });
    html += '</tr></tbody></table></div>';

    if (totaux.length > 1) {
      var lo2 = Math.min.apply(null, totaux), hi2 = Math.max.apply(null, totaux);
      html += '<div class="cmp-summary">' + ((hi2 - lo2 < 5 && memeContenu && !duplicateModel)
        ? '<span class="cmp-agree">✓ Avis concordants</span> — ' + (hi2 - lo2) + ' g d\'écart seulement.'
        : 'Valeurs de <strong>' + lo2 + ' à ' + hi2 + ' g</strong> · écart maximal de <strong>' +
          (hi2 - lo2) + ' g</strong>. Choisis d’après le détail, sans faire de moyenne.') + '</div>';
      if (hi2 - lo2 < 5 && !memeContenu) {
        html += '<div class="cmp-warn">⚠️ <strong>Totaux proches, calculs différents.</strong> ' +
          'Les colonnes arrivent presque au même chiffre, mais pas avec les mêmes aliments ' +
          'ou les mêmes quantités. Les erreurs peuvent se compenser : compare chaque ligne.</div>';
      }
    }

    html += rerunHtml(true);
    el.innerHTML = html;
    el.hidden = false;
    initRerun();

    /* RIEN NE DOIT SE PERDRE ICI. Avant la double analyse, toute estimation
       finissait dans renderResults, qui enregistre un brouillon d'historique
       avec sa photo. Depuis que deux avis s'affichent par défaut, le flux
       s'arrête sur cet écran — et tout vivait en mémoire. Verrouiller le
       téléphone à ce moment suffisait à tout perdre : Android récupère la
       WebView, la page se recharge, et il ne restait rien sur le disque.

       On enregistre donc dès l'affichage, sans attendre le choix : le premier
       avis abouti sert de brouillon. Retenir l'autre ensuite met simplement à
       jour la MÊME entrée, puisque currentHistoryDate ne change pas. */
    if (ok.length && !reviewOnly) {
      lastResult = ok[0].result;
      var second = ok[1];
      lastVerification = second
        ? { ok: true, provider: second.provider, model: second.result.model || '',
            total: second.result.totalCarbsG,
            items: second.result.items || [], checkedAt: Date.now() }
        : lastVerification;
      autoSaveCurrentResult();
      sauverEnCours(avis);
    }

    el.querySelectorAll('.cmp-use').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (estimateBusy) {
          toast('Attends la fin de l’avis en cours avant de choisir une colonne.');
          return;
        }
        var choisiIndex = parseInt(btn.dataset.i, 10);
        var choisi = avis[choisiIndex], autres = avis.filter(function (x, i) {
          return i !== choisiIndex;
        });
        if (!choisi) return;
        try { lastResult = JSON.parse(JSON.stringify(choisi.result)); }
        catch (e) { lastResult = Object.assign({}, choisi.result); }
        currentDominantConfirmed = false;
        /* Rechoisir après une confirmation change le chiffre : ce nouveau choix
           redevient donc un brouillon et doit être confirmé à son tour. */
        currentHistoryConfirmed = false;
        currentChoiceRequired = false;
        /* La vérification retenue est le PREMIER autre avis abouti : c'est celui
           qui sert de contrepoint dans le détail et dans l'historique. */
        var autre = autres.filter(function (x) { return x.ok; })[0] || autres[0];
        lastVerification = !autre ? null : (autre.ok
          ? { ok: true, provider: autre.provider, model: autre.result.model || '',
              total: autre.result.totalCarbsG,
              items: autre.result.items || [], checkedAt: Date.now() }
          : { ok: false, provider: autre.provider, error: autre.error, checkedAt: Date.now() });
        lastCompare = null;          // on quitte la comparaison pour le détail
        oublierEnCours();
        renderResults(lastResult);
      });
    });
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Recalcule le total à partir des items édités.
  /* Le total n'est pas seul à dépendre des aliments : la charge glycémique, la
     vitesse d'absorption et les macros aussi. Tout est recalculé au même
     endroit (Estimator.refresh) — sinon corriger une portion laissait une
     charge glycémique périmée à l'écran. */
  function recomputeTotal() {
    /* Corriger une portion à la main annule la fusion des deux avis : le total
       redevient la somme des aliments tels que l'utilisateur les a corrigés. Le
       garder ferait cohabiter à l'écran une moyenne calculée sur des valeurs
       qui n'existent plus. */
    delete lastResult.mergedTotalCarbsG;
    delete lastResult.verifyTotalCarbsG;
    delete lastResult.dominantConfirmed;
    currentDominantConfirmed = false;
    currentHistoryConfirmed = false;
    lastResult.humanEdited = true;
    /* Une correction humaine rend l'ancien second avis périmé : il portait sur
       la liste précédente. Le conserver comme « confirmé » serait trompeur. */
    lastVerification = null;
    Estimator.refresh(lastResult);
  }

  // Barre visuelle de la fourchette d'incertitude.
  function rangeBarHtml(low, total, high) {
    low = Math.max(0, Math.round(low));
    total = Math.max(0, Math.round(total));
    high = Math.max(high, total, low);
    var scaleMax = Math.max(high * 1.2, 1);
    var leftPct = Math.max(0, Math.min(100, low / scaleMax * 100));
    var rightPct = Math.max(0, Math.min(100, 100 - high / scaleMax * 100));
    var markPct = Math.max(0, Math.min(100, total / scaleMax * 100));
    return '<div class="range-wrap">' +
      '<div class="range-track">' +
        '<div class="range-fill" style="left:' + leftPct.toFixed(1) + '%;right:' + rightPct.toFixed(1) + '%"></div>' +
        '<div class="range-mark" style="left:' + markPct.toFixed(1) + '%"></div>' +
      '</div>' +
      '<div class="range-labels"><span>' + low + ' g</span><span>fourchette</span><span>' + high + ' g</span></div>' +
    '</div>';
  }

  /* Rappel de la tendance personnelle au moment où ça compte (avant de doser).
     Purement informatif : on NE corrige PAS le chiffre automatiquement — le
     modèle a déjà reçu cette calibration dans son prompt (voir estimator.js),
     donc l'appliquer une seconde fois ici la compterait deux fois.

     On privilégie le biais de la CATÉGORIE réellement présente dans CE repas :
     « tu sous-estimes les féculents » est actionnable, « tu sous-estimes de
     12 % en général » ne dit pas quoi regarder. */
  function biasHintHtml(totalG, items) {
    var cat = null;
    if (items && items.length && Storage.getBiasByCategory) {
      var present = {};
      items.forEach(function (it) {
        var c = Storage.categoryOf ? Storage.categoryOf(it.name) : null;
        if (c && (it.carbsG || 0) > 0) present[c] = (present[c] || 0) + it.carbsG;
      });
      var groups = Storage.getBiasByCategory(3) || [];
      for (var i = 0; i < groups.length; i++) {
        if (present[groups[i].category] && Math.abs(groups[i].pct) >= 8) {
          cat = groups[i];
          break;
        }
      }
    }

    if (cat) {
      return '<div class="bias-hint">🎯 Sur tes ' + cat.count + ' repas mesurés contenant des ' +
        escapeHtml(cat.category.toLowerCase()) + ', tu les ' +
        (cat.pct > 0 ? 'sous-estimes' : 'sur-estimes') + ' d\'environ ' + Math.abs(cat.pct) +
        ' %. L\'estimation ci-dessus en tient déjà compte — vérifie surtout cette portion-là.</div>';
    }

    var bias = Storage.getBias();
    if (bias.count < 3 || Math.abs(bias.pct) < 5) return '';
    var sens = bias.pct > 0 ? 'sous-estimes' : 'sur-estimes';
    return '<div class="bias-hint">🎯 D\'après tes ' + bias.count + ' repas corrigés, tu ' + sens +
      ' d\'environ ' + Math.abs(bias.pct) + ' % en moyenne. L\'estimation ci-dessus en tient ' +
      'déjà compte.</div>';
  }

  /* Tendance d'absorption du repas. On décrit comment CE REPAS se digère
     typiquement — on ne prédit pas ta glycémie : ça demanderait ton capteur et
     ton insuline active, que ta pompe possède et pas l'app. */
  var GLYCEMIC = {
    rapide: {
      icon: '⚡', label: 'Montée rapide',
      timing: 'typiquement 15 à 45 min après le début du repas',
      cls: 'gly-fast'
    },
    moderee: {
      icon: '🕐', label: 'Montée progressive',
      timing: 'typiquement 45 min à 1 h 30',
      cls: 'gly-mid'
    },
    lente: {
      icon: '🐢', label: 'Montée retardée et étalée',
      timing: 'souvent 2 à 4 h, avec un pic tardif',
      cls: 'gly-slow'
    }
  };

  function glycemicHtml(r) {
    var g = GLYCEMIC[r.glycemicSpeed];
    if (!g) return '';
    return '<div class="gly ' + g.cls + '">' +
      '<div class="gly-head"><span class="gly-ico">' + g.icon + '</span>' +
        '<strong>' + g.label + '</strong> · <span class="gly-time">' + g.timing + '</span></div>' +
      (r.glycemicNote ? '<div class="gly-why">' + escapeHtml(r.glycemicNote) + '</div>' : '') +
      '<div class="gly-meta">Tendance de ce repas, pas une prévision de ta glycémie — ' +
        'elle dépend aussi de toi et de ta pompe.</div>' +
      '</div>';
  }

  /* Index et charge glycémiques.
     La CG est mise en avant plutôt que l'IG, parce que c'est elle qui tient
     compte de la portion : une tranche de pastèque a un IG de 76 mais une charge
     dérisoire. Afficher l'IG seul ferait fuir des aliments sans raison. */
  function giHtml(r) {
    var g = r.gi;
    if (!g || g.gl == null) return '';
    var gl = GI.glBand(g.gl), ig = GI.giBand(g.gi);

    var meta = [];
    if (g.coverage < 0.85) {
      meta.push('Calculé sur ' + g.carbsCovered + ' g des ' + g.carbsTotal + ' g de glucides' +
        (g.unknown.length ? ' (hors : ' + escapeHtml(g.unknown.slice(0, 2).join(', ')) + ')' : '') + '.');
    }
    if (g.estimated) meta.push('IG estimé par le modèle pour un plat absent de la table.');
    meta.push('Valeurs de table mesurées sur aliment isolé : dans un repas mixte, ' +
      'le gras et les protéines abaissent la montée réelle.');

    return '<div class="gi ' + gl.cls + '">' +
      '<div class="gi-head">' +
        '<span class="gi-main"><b>Charge glycémique ' + g.gl + '</b> · ' + gl.label + '</span>' +
        '<span class="gi-sub">IG moyen ' + g.gi + ' · ' + ig.label + '</span>' +
      '</div>' +
      '<div class="gi-meta">' + meta.join(' ') + '</div>' +
      '</div>';
  }

  /* « Ce que l'IA a vu » — la vérification avant de doser.
     Le reste de l'écran donne des chiffres ; celui-ci dit sur quoi ils portent.
     C'est ce qui permet de repérer en un coup d'œil que le modèle a pris le
     poulet pour du poisson, ou n'a pas vu le pain à côté de l'assiette — deux
     erreurs qui changent le total sans que rien d'autre ne les signale. */
  /* Repère demandé mais non trouvé, et incohérences arithmétiques.
     Ces deux signaux étaient totalement absents : la marge d'erreur était
     resserrée sur un repère supposé, et aucun garde-fou n'existait contre une
     valeur absurde. Ce sont des avertissements de PRÉCISION, donc affichés
     juste sous le chiffre, avant tout le reste. */
  function warningsHtml(r) {
    var out = '';

    if (r.refAsked && !r.refFound) {
      out += '<div class="warn-box"><strong>⚠️ Carte GlucoVision non vérifiée.</strong><br>' +
        'Aucune échelle métrique n’a été transmise au modèle : les portions ont été ' +
        'estimées à vue. Reprends la photo avec « Photo mesurée », carte entièrement ' +
        'visible, immobile et posée à côté du repas sur la même table.</div>';
    } else if (r.refAsked && Array.isArray(r.referenceVerifiedViews) &&
               r.referenceVerifiedViews.length < (r.referenceExpectedViews || 0)) {
      out += '<div class="warn-box"><strong>⚠️ Mesure partielle.</strong><br>' +
        r.referenceVerifiedViews.length + ' vue(s) sur ' + r.referenceExpectedViews +
        ' ont une échelle native. Les autres angles restent estimés visuellement ; ' +
        'aucune mesure n’est transférée d’une image à l’autre.</div>';
    }

    if (r.alerts && r.alerts.length) {
      out += '<div class="warn-box warn-hard"><strong>⚠️ Incohérence détectée dans le calcul.</strong><ul>' +
        r.alerts.map(function (a) { return '<li>' + escapeHtml(a) + '</li>'; }).join('') +
        '</ul>Vérifie les portions ci-dessous, ou relance l\'estimation. ' +
        'Ne saisis pas ce chiffre tel quel.</div>';
    }
    return out;
  }

  function seenHtml(r) {
    var ligne = function (it) {
      var carb = it.carbsG > 0
        ? '<b>' + it.carbsG + ' g</b> de glucides'
        : '<span class="seen-zero">aucun glucide</span>';
      var portion = it.portionDescription || (it.estimatedMassG != null
        ? 'environ ' + Math.round(it.estimatedMassG) + ' g' : '');
      return '<li class="seen-item">' +
        '<div class="seen-name">' + escapeHtml(it.name) + '</div>' +
        (portion ? '<div class="seen-portion">' + escapeHtml(portion) + '</div>' : '') +
        '<div class="seen-carb">' + carb + '</div>' +
        (it.assumptions ? '<div class="seen-why">' + escapeHtml(it.assumptions) + '</div>' : '') +
        '</li>';
    };

    var vus = (r.items || []).filter(function (it) { return !it.added; });
    var ajoutes = (r.items || []).filter(function (it) { return it.added; });
    var lignes = vus.map(ligne).join('');

    if (!lignes && !ajoutes.length && !r.seen) return '';

    var titre = r.fromText ? '💬 Ce que l\'IA a compris' : '👁️ Ce que l\'IA a vu';
    var intro = r.fromText
      ? 'Relis : si un aliment manque ou n\'a rien à y faire, corrige ta description et relance.'
      : 'Relis avant de doser : si un aliment est mal identifié ou manquant, corrige la portion plus bas — ou reprends une photo.';

    return '<div class="card seen-card"><h2>' + titre + '</h2>' +
      (r.seen ? '<p class="seen-sentence">« ' + escapeHtml(r.seen) + ' »</p>' : '') +
      '<ul class="seen-list">' + lignes + '</ul>' +
      /* Séparés explicitement : ces aliments n'ont pas été vus sur la photo,
         ils ont été saisis après coup. Les mélanger laisserait croire que
         le modèle les a identifiés lui-même. */
      (ajoutes.length
        ? '<h3 class="seen-sub">➕ Ajouté par toi</h3>' +
          '<ul class="seen-list">' + ajoutes.map(ligne).join('') + '</ul>'
        : '') +
      (r.referenceUsed && !r.fromText
        ? '<p class="seen-ref">📐 Mesure locale : ' + escapeHtml(r.referenceUsed) + '</p>' : '') +
      '<p class="hint tiny">' + intro + '</p>' +
      '</div>';
  }

  function macrosHtml(r) {
    if (r.totalProteinG == null && r.totalFatG == null && r.totalKcal == null) return '';
    var bits = [];
    if (r.totalKcal != null) bits.push('<span><b>' + r.totalKcal + '</b> kcal</span>');
    if (r.totalProteinG != null) bits.push('<span><b>' + r.totalProteinG + '</b> g protéines</span>');
    if (r.totalFatG != null) bits.push('<span><b>' + r.totalFatG + '</b> g lipides</span>');
    if (!bits.length) return '';
    return '<div class="macros">' + bits.join('') + '</div>';
  }

  /* Chiffre AFFICHÉ, qui n'est pas toujours celui du modèle principal : quand la
     fusion des deux avis est active, c'est leur moyenne. On ne touche jamais à
     r.totalCarbsG pour autant — le détail par aliment reste celui du modèle
     principal, et faire coller les deux demanderait de redistribuer l'écart sur
     des aliments dont rien ne dit qu'ils sont en cause. */
  function shownTotal(r) {
    return (r && typeof r.mergedTotalCarbsG === 'number') ? r.mergedTotalCarbsG : (r ? r.totalCarbsG : 0);
  }

  /* ---------- La question qui vaut plus qu'un second modèle ----------
     Le modèle mesure ce qu'il voit. Il ne peut pas distinguer un yaourt d'un
     porridge sous des fruits rouges : la photo est identique, l'écart dépasse
     20 g de glucides. Toi, tu le sais sans réfléchir. C'est l'information la
     moins chère du système, et aucun second avis à 0,02 $ ne peut la remplacer.

     Elle n'apparaît que si le modèle chiffre lui-même l'enjeu au-dessus de 10 g
     (filtré et reborné dans estimator.js). Une question posée pour rien fait
     fermer l'application, et la suivante — celle qui aurait servi — ne sera plus
     lue. C'est aussi pour ça qu'il n'y en a jamais deux.

     Elle n'est proposée que si la relance est réellement possible : après une
     reprise depuis l'historique les photos ne sont plus en mémoire, et un bouton
     qui ne peut pas tenir sa promesse est pire que pas de bouton. */
  function clarificationPossible(r) {
    if (!r || !r.clarification || r.clarificationAnswered) return false;
    return inputMode === 'texte' ? true : images.length > 0;
  }

  function clarificationHtml(r) {
    if (!clarificationPossible(r)) return '';
    var c = r.clarification;
    var opts = c.options.map(function (o, i) {
      return '<button class="btn btn-secondary clarif-opt" data-clarif="' + i + '">' +
             escapeHtml(o) + '</button>';
    }).join('');
    return '<div class="card clarif-card">' +
      '<h2>❓ Une précision changerait le résultat</h2>' +
      '<p class="clarif-q">' + escapeHtml(c.question) + '</p>' +
      '<p class="hint tiny">Enjeu estimé : environ <strong>' + c.impactCarbsG +
      ' g</strong> de glucides. Ta réponse relance l\'analyse avec cette information.</p>' +
      '<div class="btn-row clarif-opts">' + opts + '</div>' +
      '<button class="btn btn-ghost clarif-skip">Je ne sais pas — garder l\'estimation</button>' +
      '</div>';
  }

  function bindClarification(r) {
    if (!clarificationPossible(r)) return;
    var c = r.clarification;
    var el = $('results');

    el.querySelectorAll('.clarif-opt').forEach(function (b) {
      b.addEventListener('click', function () {
        var reponse = c.options[parseInt(b.getAttribute('data-clarif'), 10)];
        if (!reponse) return;
        /* La réponse rejoint la description : c'est déjà le canal des
           « précisions de l'utilisateur (fiables, à intégrer) » du prompt, donc
           rien de nouveau à apprendre au modèle. */
        var champ = $('user-notes');
        var avant = (champ.value || '').trim();
        champ.value = (avant ? avant + '\n' : '') + c.question + ' → ' + reponse;
        updateInputSummaries();
        updateEstimateBtn();
        /* Marqué AVANT la relance : sans ça, un modèle qui repose la même
           question à chaque tour ferait tourner l'utilisateur en boucle, et
           chaque tour est un appel facturé. */
        if (lastEstimateContext) lastEstimateContext.clarificationAnswered = true;
        clarificationRepondue = true;
        runEstimate({ preserveClarification: true });
      });
    });

    var skip = el.querySelector('.clarif-skip');
    if (skip) {
      skip.addEventListener('click', function () {
        r.clarificationAnswered = true;
        renderResults(r, true);
      });
    }
  }

  function renderResults(r, keepPosition) {
    // Un seul point d'application : direct, comparaison et reprise passent tous ici.
    if (clarificationRepondue) r.clarificationAnswered = true;
    var el = $('results');
    var total = shownTotal(r);
    var parts = partsFrom(total);
    var nutrition = glycemicHtml(r) + giHtml(r) + macrosHtml(r);

    var bloque = (r.blocking && r.blocking.length) ? r.blocking : null;

    var html = '';
    if (r.fallbackFrom) {
      /* Persistant, pas un toast : ce bandeau dit que le chiffre affiché vient
         d'un autre modèle que celui choisi. Un message qui disparaît tout seul
         ne convient pas à une information qui change la provenance d'une dose. */
      html += '<div class="safety-banner" style="position:static;margin-bottom:12px">' +
        '<span>🔁 <strong>' + escapeHtml(PROVIDER_NAME[r.fallbackFrom] || r.fallbackFrom) +
        ' n\'a pas répondu.</strong> Cette estimation vient du fournisseur de secours, ' +
        escapeHtml(PROVIDER_NAME[r.fallbackTo] || r.fallbackTo) +
        ' — un autre modèle, donc un autre chiffre que celui qu\'aurait donné ton réglage habituel.</span>' +
        '</div>';
    }
    html += clarificationHtml(r);
    if (bloque) {
      /* Résultat retiré, pas seulement signalé. Une incohérence de ce niveau
         veut dire que le nombre ne représente rien : l'afficher en gros avec un
         avertissement à côté reviendrait à parier sur le fait qu'il sera lu. */
      html += '<div class="card blocked-box">';
      html += '<h2>⛔ Estimation inutilisable</h2>';
      html += '<p>Le résultat est incohérent, le chiffre n\'est donc pas affiché :</p><ul>';
      html += bloque.map(function (b) { return '<li>' + escapeHtml(b) + '</li>'; }).join('');
      html += '</ul>';
      html += '<p class="hint">Relance l\'estimation, ou corrige les aliments ci-dessous : ' +
              'le total se recalcule. Une contradiction de la réponse initiale demandera ' +
              'ensuite une validation explicite de ton calcul.</p>';
      if (r.humanEdited && r.sourceBlocking && r.sourceBlocking.length) {
        html += '<button id="accept-manual-recalc" class="btn btn-secondary">' +
          'J’ai vérifié chaque aliment — utiliser mon calcul</button>';
      }
      html += '</div>';
      html += '<div id="verify-box" class="verify-box" hidden></div>';
      html += seenHtml(r);
      html += '<div class="card"><h2>Détail par aliment</h2>';
      html += '<p class="hint">Corrige une portion pour débloquer le total.</p>';
      html += '<div id="items-list"></div>' +
        '<button id="add-result-item" class="btn btn-secondary result-add-item">＋ Ajouter un aliment manquant</button></div>';
      el.innerHTML = html;
      el.hidden = false;
      renderItems();
      initResultItemAdder();
      var acceptManual = $('accept-manual-recalc');
      if (acceptManual) {
        acceptManual.addEventListener('click', function () {
          Estimator.acceptManualRecalculation(lastResult);
          renderResults(lastResult, true);
          toast(lastResult.blocking && lastResult.blocking.length
            ? 'Le calcul reste bloqué : corrige encore les points signalés.'
            : 'Ton calcul corrigé remplace maintenant la réponse incohérente du modèle.');
        });
      }
      autoSaveCurrentResult();
      if (!keepPosition) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    html += '<div class="result-hero">';
    html += '  <div class="hero-carbs">' + total + ' <small>g</small></div>';
    html += '  <div class="hero-parts">' + fr(parts) + ' <small>parts de glucides</small></div>';
    html += rangeBarHtml(r.rangeLowG, total, r.rangeHighG);
    html += '  <div class="confidence conf-' + r.overallConfidence + '">' + CONF_LABEL[r.overallConfidence] + '</div>';
    /* Formulation volontairement non impérative. « À saisir dans ta pompe »
       transformait une estimation en instruction, alors que la fourchette
       mesurée sur le banc s'étend de 0,62 à 1,66 fois le chiffre affiché. */
    html += '  <div class="pump-hint">💉 <strong>Estimation à vérifier</strong> avant de saisir : <strong>' +
            total + ' g</strong> (soit <strong>' + fr(parts) + ' parts</strong>).<br>' +
            'Relis le détail ci-dessous, corrige si besoin, puis saisis le chiffre que TU retiens. ' +
            'Ta pompe calcule le bolus.</div>';
    if (typeof r.mergedTotalCarbsG === 'number') {
      html += '  <div class="merged-hint">⚖️ Moyenne de deux modèles (' + r.totalCarbsG +
              ' g et ' + r.verifyTotalCarbsG + ' g). Le détail ci-dessous reste celui du modèle principal.</div>';
    }
    /* Estimation sans photo : on le dit franchement. Le chiffre s'affiche
       exactement comme celui d'une photo, et rien à l'écran ne rappellerait
       sinon qu'aucune portion n'a été vue — c'est précisément le moment où
       une vérification vaut le coup. */
    if (r.fromText) {
      html += '<div class="from-text">✍️ Estimé d\'après ta description, sans photo. ' +
        'La taille des portions est supposée, pas mesurée : la fourchette est plus large. ' +
        'Ajoute des quantités pour la resserrer.</div>';
    }
    html += '</div>';

    html += '<div id="verify-box" class="verify-box" hidden></div>';
    html += dominantHtml(r);
    html += biasHintHtml(r.totalCarbsG, r.items);
    html += warningsHtml(r);
    html += similarMealHtml(r);
    html += seenHtml(r);

    // Détail par aliment (grammes éditables)
    html += '<div class="card"><h2>Détail par aliment</h2>';
    html += '<p class="hint">Une portion te semble fausse dans la liste ci-dessus ? Corrige-la ici, le total se recalcule.</p>';
    html += '<div id="items-list"></div>' +
      '<button id="add-result-item" class="btn btn-secondary result-add-item">＋ Ajouter un aliment manquant</button></div>';

    if (nutrition || r.notes) {
      html += '<details class="card result-more"><summary>Informations complémentaires</summary>' +
        '<div class="result-more-content">' + nutrition;
      if (r.notes) {
        html += '<div class="notes-box">📝 ' + escapeHtml(r.notes) + '</div>';
      }
      html += '</div></details>';
    }

    html += '<div id="result-save-status" class="autosave-status">' +
            '<span class="autosave-dot"></span><span>Enregistrement du brouillon…</span></div>';
    html += '<div class="btn-row">' +
            '<button id="confirm-result" class="btn btn-primary">✓ Confirmer ce repas</button>' +
            '<button id="save-meal" class="btn btn-ghost"' +
            (typeof r.mergedTotalCarbsG === 'number' ? ' disabled title="Corrige le détail avant de sauvegarder ce repas"' : '') +
            '>⭐ Repas fréquent</button>' +
            '</div>';
    if (lastComparisonArchive && lastComparisonArchive.length > 1) {
      html += '<button id="reopen-compare" class="btn btn-secondary btn-lg">' +
        '↔ Revoir les ' + lastComparisonArchive.length + ' colonnes d’origine</button>';
    }
    html += rerunHtml();
    html += '<div class="disclaimer-mini">Estimation indicative — vérifie toujours avant de doser.</div>';

    el.innerHTML = html;
    el.hidden = false;
    renderItems();
    initResultItemAdder();
    initDominant();
    $('confirm-result').addEventListener('click', confirmCurrentResult);
    $('save-meal').addEventListener('click', function () {
      if (typeof lastResult.mergedTotalCarbsG === 'number') {
        toast('Corrige d’abord le détail : un repas fréquent doit avoir des aliments dont la somme correspond au total.');
        return;
      }
      if ((lastResult.blocking && lastResult.blocking.length) ||
          (dominantItem(lastResult) && !currentDominantConfirmed)) {
        toast('Confirme et corrige d’abord ce résultat avant d’en faire un repas fréquent.');
        return;
      }
      promptSaveMeal(lastResult.items);
    });
    var reopen = $('reopen-compare');
    if (reopen) {
      reopen.addEventListener('click', function () {
        renderCompare(lastComparisonArchive, true);
      });
    }
    initRerun();
    bindClarification(r);
    renderVerificationState();
    autoSaveCurrentResult();
    if (!keepPosition) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------- Dessert et boisson ----------
     Ils sont saisis sur la page AVANT l'estimation et partent dans le même
     appel que la photo : une seule requête au modèle au lieu de deux.
     Le prompt précise qu'ils ne sont pas sur l'image, sinon le modèle les
     chercherait en vain et finirait par les ignorer. */
  var DRINK_CHIPS = [
    "un verre de jus d'orange (20 cl)",
    'une canette de soda (33 cl)',
    'un verre de lait (20 cl)',
    'un verre de vin rouge (12 cl)',
    'une bière (25 cl)'
  ];

  function initExtras() {
    var chips = $('drink-chips');
    if (chips) {
      chips.innerHTML = DRINK_CHIPS.map(function (d, i) {
        return '<button type="button" class="chip" data-drink="' + i + '">' +
          escapeHtml(d.replace(/ \(.*\)$/, '')) + '</button>';
      }).join('');
      chips.querySelectorAll('[data-drink]').forEach(function (b) {
        b.addEventListener('click', function () {
          $('extra-drink').value = DRINK_CHIPS[parseInt(b.dataset.drink, 10)];
          updateEstimateBtn();
        });
      });
    }
  }

  // Texte des compléments, ou chaîne vide s'il n'y en a pas.
  function extrasText() {
    var dessert = (($('extra-dessert') || {}).value || '').trim();
    var drink = (($('extra-drink') || {}).value || '').trim();
    var parts = [];
    if (dessert) parts.push('Dessert : ' + dessert);
    if (drink) parts.push('Boisson : ' + drink);
    return parts.join('. ');
  }

  /* ---------- Vérification croisée ----------
     Un second modèle, bon marché, estime le même repas de son côté. On ne
     remplace jamais le chiffre principal : on signale l'écart. Deux modèles
     indépendants qui tombent d'accord, c'est une confirmation ; un écart large
     est le seul signal automatique capable de rattraper une erreur grossière
     avant que la dose ne soit saisie. */
  function startVerification(images, ctx) {
    var p = settings.verifyProvider;
    if (settings.verificationMode !== 'auto' || !p || p === settings.provider) return null;
    if (!(settings.apiKeys || {})[p]) return null;
    var configured = settings.models || {};
    if (Estimator.sameUnderlyingModel([
      configured[settings.provider], configured[p]
    ])) {
      return Promise.resolve({
        ok: false, provider: p,
        error: 'même modèle que l’estimation principale : avis non indépendant'
      });
    }
    return Estimator.estimateWith(p, images, ctx, settings)
      .then(function (r) {
        if (r.blocking && r.blocking.length) {
          return { ok: false, provider: p,
                   error: 'résultat incohérent refusé : ' + r.blocking.join(' ') };
        }
        return { ok: true, provider: p, model: r.model || '',
                 total: r.totalCarbsG, items: r.items || [] };
      })
      .catch(function (e) { return { ok: false, provider: p, error: e.message }; });
  }

  /* Comparaison ALIMENT PAR ALIMENT, et pas seulement des totaux.
     Deux modèles peuvent tomber sur 70 g pour des raisons opposées : l'un voit
     du pain que l'autre ignore, l'autre surcharge le riz. Annoncer « Confirmé »
     sur la seule égalité des totaux est alors une FAUSSE ASSURANCE — pire que
     pas de vérification, puisqu'elle invite à ne pas relire.
     Le rapprochement se fait sur des racines de mots : les deux modèles ne
     nomment jamais un aliment exactement pareil (« pavé de saumon » vs
     « saumon grillé »). */
  function foodKey(name) {
    return (name || '').toString().toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z ]/g, ' ')
      .split(/\s+/)
      .filter(function (w) { return w.length > 3; })
      .sort()
      .join(' ');
  }

  function sameFood(a, b) {
    if (Storage.sameFood) return Storage.sameFood(a, b);
    var ka = foodKey(a), kb = foodKey(b);
    if (!ka || !kb) return false;
    return ka === kb;
  }

  // Aliments porteurs de glucides vus par l'un et pas par l'autre.
  function foodDisagreements(mine, theirs) {
    var carbed = function (list) {
      return (list || []).filter(function (it) { return (it.carbsG || 0) >= 5; });
    };
    var a = carbed(mine), b = carbed(theirs);
    if (Storage.matchFoods) {
      var matched = Storage.matchFoods(a, b);
      return {
        pairs: matched.pairs || [],
        onlyMine: matched.onlyA || [],
        onlyTheirs: matched.onlyB || []
      };
    }
    /* Repli un-à-un : un aliment du second avis ne peut pas « confirmer »
       plusieurs lignes du premier. */
    var used = {}, pairs = [], onlyMine = [];
    a.forEach(function (x, ai) {
      var found = -1;
      for (var i = 0; i < b.length; i++) {
        if (!used[i] && sameFood(x.name, b[i].name)) { found = i; break; }
      }
      if (found < 0) onlyMine.push(x);
      else {
        used[found] = true;
        pairs.push({ aIndex: ai, bIndex: found, a: x, b: b[found] });
      }
    });
    return {
      pairs: pairs,
      onlyMine: onlyMine,
      onlyTheirs: b.filter(function (_, i) { return !used[i]; })
    };
  }

  /* Des noms identiques ne suffisent pas à établir un accord. Riz 40 + pain 10
     et riz 10 + pain 42 donnent presque le même total, mais racontent deux
     calculs opposés. On exige donc aussi une proximité raisonnable pour chaque
     aliment apparié (5 g minimum de tolérance, ou 25 % de leur moyenne). */
  function foodComparison(mine, theirs) {
    var d = foodDisagreements(mine, theirs);
    var amountDiffs = (d.pairs || []).filter(function (pair) {
      var a = Number(pair.a && pair.a.carbsG) || 0;
      var b = Number(pair.b && pair.b.carbsG) || 0;
      return Math.abs(a - b) > Math.max(5, ((a + b) / 2) * 0.25);
    });
    return {
      pairs: d.pairs || [],
      onlyMine: d.onlyMine || [],
      onlyTheirs: d.onlyTheirs || [],
      amountDiffs: amountDiffs,
      same: !(d.onlyMine || []).length && !(d.onlyTheirs || []).length && !amountDiffs.length
    };
  }

  function renderVerificationState() {
    var el = $('verify-box');
    if (!el) return;
    if (!lastVerification) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    if (lastVerification.loading) {
      el.className = 'verify-box';
      el.innerHTML = '<span class="spinner"></span>Vérification croisée en cours…';
      return;
    }

    var v = lastVerification;
    var nom = PROVIDER_NAME[v.provider] || v.provider;
    if (!v.ok) {
      el.className = 'verify-box v-off';
      el.innerHTML = '⚪ Vérification croisée indisponible (' + escapeHtml(v.error || 'erreur') + ').';
      return;
    }

    var main = lastResult.totalCarbsG;
    var ecart = main > 0 ? Math.abs(v.total - main) / main * 100 : 0;
    var seuil = settings.verifyThresholdPct || 20;
    var parts = fr(partsFrom(v.total));

    var d = foodComparison(lastResult.items, v.items);
    var duplicateModel = Estimator.sameUnderlyingModel([
      lastResult && lastResult.model, v.model
    ]);
    var listeEcarts = '';
    if (d.onlyTheirs.length) {
      listeEcarts += '<br>• ' + escapeHtml(nom) + ' voit aussi : <strong>' +
        d.onlyTheirs.map(function (x) {
          return escapeHtml(x.name) + ' (' + x.carbsG + ' g)';
        }).join(', ') + '</strong>';
    }
    if (d.onlyMine.length) {
      listeEcarts += '<br>• ' + escapeHtml(nom) + ' ne voit pas : <strong>' +
        d.onlyMine.map(function (x) {
          return escapeHtml(x.name) + ' (' + x.carbsG + ' g)';
        }).join(', ') + '</strong>';
    }
    if (d.amountDiffs.length) {
      listeEcarts += '<br>• Répartition différente : <strong>' +
        d.amountDiffs.map(function (pair) {
          return escapeHtml(pair.a.name) + ' ' + Math.round(pair.a.carbsG || 0) +
            ' g / ' + Math.round(pair.b.carbsG || 0) + ' g';
        }).join(', ') + '</strong>';
    }

    if (ecart <= seuil && d.same && !duplicateModel) {
      el.className = 'verify-box v-ok';
      el.innerHTML = '✅ <strong>Confirmé</strong> par ' + escapeHtml(nom) + ' : ' +
        v.total + ' g (' + parts + ' parts), soit ' + Math.round(ecart) + ' % d\'écart, ' +
        'et les deux modèles voient les mêmes aliments.';
    } else if (duplicateModel) {
      el.className = 'verify-box v-warn';
      el.innerHTML = '⚠️ <strong>Vérification non indépendante</strong> — les deux réponses ' +
        'viennent du même modèle appelé par deux routes différentes. Leur accord ne confirme rien.';
    } else if (ecart <= seuil) {
      /* Totaux proches mais désaccord sur le CONTENU : c'est le cas que la
         comparaison des seuls totaux laissait passer pour une confirmation. */
      el.className = 'verify-box v-warn';
      el.innerHTML = '🔍 <strong>Totaux proches, mais pas le même repas</strong> — ' +
        escapeHtml(nom) + ' arrive à ' + v.total + ' g (' + Math.round(ecart) +
        ' % d\'écart) en comptant des aliments différents.' + listeEcarts +
        '<br>Les deux erreurs se compensent peut-être. Relis « Ce que l\'IA a vu ».';
    } else {
      el.className = 'verify-box v-alert';
      el.innerHTML = '⚠️ <strong>Écart important</strong> — ' + escapeHtml(nom) +
        ' estime <strong>' + v.total + ' g</strong> (' + parts + ' parts), soit ' +
        Math.round(ecart) + ' % de différence.' + listeEcarts +
        '<br>Relis « Ce que l\'IA a vu » avant de saisir la dose.';
    }
  }

  /* Écart absolu au-delà duquel deux avis ne décrivent plus le même repas, quel
     que soit le pourcentage. 25 g, c'est deux parts et demie d'insuline. */
  var MAX_ECART_FUSION_G = 25;

  function mergePairValidated(mainResult, verification) {
    var a = (mainResult && mainResult.model || '').toLowerCase();
    var b = (verification && verification.model || '').toLowerCase();
    var gemini = function (m) { return /(^|\/)gemini-3\.1-flash-lite$/.test(m); };
    var complement = function (m) {
      return m === 'x-ai/grok-4.5' ||
        m === 'qwen/qwen3-vl-235b-a22b-thinking' ||
        m === 'qwen/qwen3-vl-235b-a22b-instruct';
    };
    if (!((gemini(a) && complement(b)) || (gemini(b) && complement(a)))) return false;
    return foodComparison(mainResult.items, verification.items).same;
  }

  function attachVerification(promise, generation) {
    if (!promise) return;
    var verifiedResult = lastResult;
    var verifiedTotal = lastResult ? lastResult.totalCarbsG : 0;
    var verifiedDate = currentHistoryDate;
    lastVerification = { loading: true };
    renderVerificationState();
    promise.then(function (v) {
      if (generation !== estimateGeneration || lastResult !== verifiedResult) return;
      v.checkedAt = Date.now();
      lastVerification = v;
      /* Fusion : la moyenne des deux avis remplace le chiffre affiché. Mesuré
         meilleur que chacun des deux pris seul, parce que leurs erreurs sont
         faiblement corrélées. On re-rend TOUTE la page plutôt que la seule
         encadré de vérification, sinon le héros garderait l'ancien nombre —
         et c'est le nombre saisi dans la pompe. */
      /* La garde ci-dessus compare l'identité de lastResult, mais corriger une
         portion mute cet objet SUR PLACE : une correction faite pendant que la
         vérification tournait ne serait donc pas détectée, et la fusion
         écraserait la valeur corrigée. On compare aussi le total, et on
         s'abstient dès que le repas a été confirmé. */
      var touched = lastResult.totalCarbsG !== verifiedTotal || currentHistoryConfirmed;
      /* Moyenner n'a de sens que si les deux avis parlent du même repas. Sans
         cette borne, 20 g et 200 g donnaient 110 g — un nombre qu'aucun des
         deux modèles n'a proposé, affiché pendant que l'écran signalait par
         ailleurs une divergence majeure. Le seuil configuré ne servait qu'au
         message ; il décide maintenant aussi de la fusion.

         Deux bornes, parce qu'une seule ne suffit pas : le relatif laisse
         passer 200 contre 260 g, l'absolu laisse passer 4 contre 8 g. */
      var fusionRaisonnable = Estimator.mergeAllowed(
        lastResult.totalCarbsG, v.total, settings.verifyThresholdPct, MAX_ECART_FUSION_G);
      if (settings.mergeVerification && v.ok && v.total > 0 && lastResult.totalCarbsG > 0
          && !touched && fusionRaisonnable && mergePairValidated(lastResult, v)) {
        lastResult.mergedTotalCarbsG = Math.round((lastResult.totalCarbsG + v.total) / 2);
        lastResult.verifyTotalCarbsG = v.total;
        lastResult.rangeLowG = Math.min(lastResult.rangeLowG, v.total);
        lastResult.rangeHighG = Math.max(lastResult.rangeHighG, v.total);
        renderResults(lastResult, true);
        if (verifiedDate) {
          if (!Storage.updateHistory(verifiedDate, {
            totalCarbsG: lastResult.mergedTotalCarbsG,
            parts: partsFrom(lastResult.mergedTotalCarbsG),
            mergedFrom: [lastResult.totalCarbsG, v.total]
          })) toast('La fusion est affichée, mais n’a pas pu être enregistrée.');
        }
      }
      renderVerificationState();
      if (verifiedDate) {
        if (!Storage.updateHistory(verifiedDate, {
          verification: {
            provider: v.provider,
            model: v.model || '',
            ok: !!v.ok,
            totalCarbsG: v.ok ? v.total : null,
            items: v.ok ? (v.items || []) : [],
            error: v.ok ? '' : (v.error || ''),
            checkedAt: v.checkedAt
          }
        })) toast('Le second avis est affiché, mais n’a pas pu être enregistré.');
      }
    });
  }

  /* ---------- Confirmation de l'aliment glucidique dominant ----------

     Le pire échec du banc d'essai n'était pas une erreur de quantité mais
     d'IDENTIFICATION : des flocons d'avoine pris pour du fromage blanc, 47 g de
     glucides réels contre 14 estimés, 33 g d'écart médian sur les quatorze
     modèles testés. Sous des fruits rouges, un porridge et un yaourt se
     ressemblent, et leur densité glucidique n'a rien à voir.

     Aucun changement de modèle ne corrige cela — les quatorze se sont trompés
     de la même façon. Un humain, lui, le voit en une seconde : il sait ce qu'il
     a dans son assiette. Encore faut-il lui poser la question, et la poser sur
     l'aliment qui compte plutôt que sur la liste entière.

     D'où cet encadré : il isole l'aliment qui porte la majorité des glucides et
     demande confirmation de sa NATURE. C'est le seul point du parcours où une
     seconde d'attention peut valoir 30 g. */
  function dominantItem(r) {
    var items = (r.items || []).filter(function (it) { return it.carbsG > 0; });
    if (!items.length || !(r.totalCarbsG > 0)) return null;

    var top = items.reduce(function (a, b) { return b.carbsG > a.carbsG ? b : a; });
    var part = top.carbsG / r.totalCarbsG;
    // En dessous de la moitié du total, se tromper dessus ne déplace pas la dose.
    if (part < 0.5) return null;
    return { item: top, part: part };
  }

  function dominantHtml(r) {
    var dominant = dominantItem(r);
    if (!dominant) return '';
    var top = dominant.item, part = dominant.part;

    return '<div class="dominant-box' + (currentDominantConfirmed ? ' dominant-done' : '') + '">' +
      '<div class="dominant-head">🔎 À vérifier en priorité</div>' +
      '<p><strong>' + escapeHtml(top.name) + '</strong> porte ' +
      Math.round(part * 100) + ' % des glucides de ce repas (' + top.carbsG + ' g). ' +
      'Est-ce bien ça ?</p>' +
      '<p class="tiny">Se tromper d\'aliment coûte bien plus qu\'une portion mal jaugée : ' +
      'des flocons d\'avoine pris pour du fromage blanc, c\'est 33 g d\'écart.</p>' +
      '<div class="btn-row">' +
      '<button id="dominant-ok" class="btn btn-secondary"' +
      (currentDominantConfirmed ? ' disabled' : '') + '>' +
      (currentDominantConfirmed ? '✓ Confirmé' : '✓ Oui, c\'est bien ça') + '</button>' +
      '<button id="dominant-no" class="btn btn-ghost">✗ Non, corriger</button>' +
      '</div></div>';
  }

  function initDominant() {
    var ok = $('dominant-ok');
    var no = $('dominant-no');
    if (ok) {
      ok.addEventListener('click', function () {
        currentDominantConfirmed = true;
        if (lastResult) lastResult.dominantConfirmed = true;
        var box = ok.closest('.dominant-box');
        if (box) box.classList.add('dominant-done');
        ok.textContent = '✓ Confirmé';
        ok.disabled = true;
        autoSaveCurrentResult();
      });
    }
    if (no) {
      no.addEventListener('click', function () {
        /* « Corriger » doit aboutir à un champ, pas à un message : on envoie
           directement sur la liste éditable. */
        var list = $('items-list');
        if (list) list.scrollIntoView({ behavior: 'smooth', block: 'center' });
        var first = list && list.querySelector('.item-name-edit');
        if (first) first.focus();
        toast('Corrige le nom ou la quantité dans le détail ci-dessous.');
      });
    }
  }

  /* ---------- « Tu as déjà mangé ça » ----------
     Affiché seulement quand un repas passé RESSEMBLE vraiment et que sa valeur
     réelle a été relevée. C'est une mesure sur ce plat précis, pas une moyenne :
     ça vaut mieux que le biais global, qui mélange tous les repas. */
  function similarMealHtml(r) {
    if (!Storage.findSimilarMeal) return '';
    var sim = null;
    try { sim = Storage.findSimilarMeal(r.items, r.totalCarbsG); } catch (e) { sim = null; }
    if (!sim) return '';

    var d = new Date(sim.date).toLocaleDateString('fr-FR');
    var sens = sim.pct > 0 ? 'plus' : 'moins';
    var ligne = Math.abs(sim.pct) < 5
      ? 'L\'estimation était juste ce jour-là (' + sim.estimated + ' g estimés, ' +
        sim.real + ' g réels).'
      : 'Ce jour-là le repas contenait <strong>' + Math.abs(sim.pct) + ' % de ' + sens +
        '</strong> que l\'estimation : ' + sim.estimated + ' g estimés, <strong>' +
        sim.real + ' g réels</strong>.';

    return '<div class="similar-box">' +
      '<div class="similar-head">🔁 Tu as déjà mangé quelque chose de très proche</div>' +
      '<div class="similar-body">Le ' + d + ' — ' + escapeHtml(sim.names.join(', ')) + '.<br>' +
      ligne + '</div>' +
      '<div class="similar-foot">Une valeur mesurée sur ce plat précis est un meilleur ' +
      'repère qu\'une moyenne. À toi de juger si la portion est comparable.</div>' +
      '</div>';
  }

  /* ---------- Relancer avec un autre modèle ----------
     Quand un résultat paraît douteux, il fallait ouvrir les Réglages, changer
     de fournisseur, revenir, puis REPRENDRE la photo — souvent impossible,
     l'assiette est entamée. Les images sont déjà en mémoire : on relance
     simplement le même repas ailleurs, et le résultat remplace l'affichage. */
  function rerunOptions() {
    var out = [];
    var core = function (model) {
      return String(model || '').toLowerCase().trim().split('/').pop();
    };
    /* Après une double analyse, DEUX modèles ont déjà répondu. N'en exclure
       qu'un laissait l'autre en tête de liste : la relance proposée par défaut
       aurait refait à l'identique l'un des deux avis déjà affichés. */
    var faits = [];
    if (lastRunProvider) faits.push(lastRunProvider + '|' + lastRunModel);
    if (lastCompareRun) faits = faits.concat(lastCompareRun);
    // Les avis DÉJÀ affichés en colonne ne doivent pas être reproposés.
    if (lastCompare) {
      var mdl2 = settings.models || {};
      lastCompare.forEach(function (x) {
        faits.push(x.provider + '|' + ((x.result && x.result.model) || mdl2[x.provider] || ''));
      });
    }
    var coresDejaFaits = faits.map(function (entry) {
      return core(String(entry).split('|').slice(1).join('|'));
    }).filter(Boolean);
    (Storage.PROVIDERS || []).forEach(function (p) {
      if (!(settings.apiKeys || {})[p]) return;          // pas de clé, pas d'option
      var cat = (Storage.MODEL_CATALOG || {})[p] || [];
      cat.forEach(function (m) {
        // On ne propose pas de refaire exactement ce qui vient d'être fait.
        var dejaFait = faits.indexOf(p + '|' + m.id) !== -1 ||
          coresDejaFaits.indexOf(core(m.id)) !== -1;
        if (dejaFait) return;
        out.push({ provider: p, model: m.id,
                   label: (PROVIDER_NAME[p] || p) + ' · ' + m.label });
      });
    });
    /* Le modèle du DOUTE en tête de liste, donc pré-sélectionné. Le sélecteur
       liste tous les modèles disponibles — laisser l'ordre des fournisseurs
       décider mettrait en premier celui qui vient justement de répondre, ou un
       modèle proche de lui. Après un désaccord entre les deux premiers avis, ce
       qu'on cherche est le plus indépendant, pas le plus proche. */
    var dp = settings.doubtProvider, dm = settings.doubtModel;
    /* Le même modèle est atteignable par deux routes : en direct chez son
       éditeur, ou via OpenRouter. Sans clé Anthropic, Claude Opus 5 sortait
       purement et simplement de la liste alors qu'une clé OpenRouter suffit à
       l'appeler. On accepte donc la seconde route, juste derrière la première. */
    var rang = function (o) {
      if (o.provider === dp && o.model === dm) return 0;
      if (o.provider === 'openrouter' && o.model.split('/').pop() === String(dm).replace(/-(\d)-(\d)$/, '-$1.$2')) return 1;
      return 2;
    };
    out.sort(function (x, y) { return rang(x) - rang(y); });
    return out;
  }

  /* `troisieme` : rendu sous les deux avis plutôt que sous le détail éditable.
     Le besoin n'est pas le même et le texte non plus — devant deux estimations
     qui divergent, on ne se demande pas si le résultat est douteux, on sait
     déjà qu'il l'est. */
  function rerunHtml(troisieme) {
    if (resumedPhotoDraft) {
      return '<div class="rerun-box"><div class="rerun-title">Photo conservée dans l’historique</div>' +
        '<p class="hint tiny">Le brouillon peut être corrigé et confirmé, mais sa photo n’est plus ' +
        'chargée en mémoire après le redémarrage. Une relance IA exigerait de reprendre ou sélectionner la photo.</p></div>';
    }
    var rememberedText = lastEstimateContext &&
      ((lastEstimateContext.notes && lastEstimateContext.notes.trim()) ||
       (lastEstimateContext.extras && lastEstimateContext.extras.trim()));
    if (!images.length && !describedMeal() && !rememberedText) return '';
    var opts = rerunOptions();
    if (!opts.length) return '';
    var titre = troisieme
      ? '<div class="rerun-title">🧭 Un doute ? Troisième avis</div>' +
        '<p class="rerun-intro">Un modèle d\'une autre famille, indépendant des deux ci-dessus. ' +
        'Même photo, rien à reprendre.</p>'
      : '<label for="rerun-model">Ce résultat te paraît douteux ?</label>';
    return '<div class="rerun-box' + (troisieme ? ' rerun-third' : '') + '">' +
      titre +
      '<div class="rerun-row">' +
      '<select id="rerun-model" class="input">' +
        opts.map(function (o, i) {
          return '<option value="' + i + '">' + escapeHtml(o.label) + '</option>';
        }).join('') +
      '</select>' +
      '<button id="rerun-btn" class="btn btn-primary">↻ Relancer</button>' +
      '</div>' +
      /* Le retour visuel doit être ICI, pas en haut de page : le bouton est en
         bas du résultat, et un indicateur placé au-dessus de l'écran ne se voit
         pas — l'appel semblait ne rien déclencher. */
      '<div id="rerun-status" class="rerun-status" hidden></div>' +
      (troisieme ? ''
        : '<p class="hint tiny" id="rerun-hint">Même repas, même photo, autre modèle. Aucune photo à reprendre.</p>') +
      '</div>';
  }

  function initRerun() {
    var btn = $('rerun-btn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      if (estimateBusy) { toast('Une analyse est déjà en cours.'); return; }
      var opts = rerunOptions();
      var o = opts[parseInt($('rerun-model').value, 10)];
      if (!o) return;

      estimateBusy = true;
      var rerunGeneration = ++estimateGeneration;
      updateEstimateBtn();
      var isCurrentRerun = function () {
        return rerunGeneration === estimateGeneration;
      };

      var status = $('rerun-status');
      var sel = $('rerun-model');
      var hint = $('rerun-hint');
      var debut = Date.now();
      var sourceCompare = lastCompare;
      var sourceResult = lastResult;
      var sourceDate = currentHistoryDate;

      // Tout se verrouille et s'annonce sur place : bouton, sélecteur, message.
      btn.disabled = true;
      btn.textContent = '↻ En cours…';
      if (sel) sel.disabled = true;
      document.querySelectorAll('.cmp-use').forEach(function (choice) {
        choice.disabled = true;
      });
      if (hint) hint.hidden = true;
      if (status) {
        status.hidden = false;
        status.className = 'rerun-status';
        status.innerHTML = '<span class="spinner"></span>Nouvelle estimation avec <strong>' +
          escapeHtml(o.label) + '</strong>… <span id="rerun-timer">0 s</span>';
      }
      /* Un compteur : ces modèles prennent 10 à 40 s, et sans lui on ne sait pas
         si l'app travaille ou si elle est bloquée. */
      var tick = setInterval(function () {
        var el = $('rerun-timer');
        if (el) el.textContent = Math.round((Date.now() - debut) / 1000) + ' s';
      }, 1000);
      var fini = function () {
        clearInterval(tick);
        if (isCurrentRerun()) {
          estimateBusy = false;
          updateEstimateBtn();
        }
        btn.disabled = false;
        btn.textContent = '↻ Relancer';
        if (sel) sel.disabled = false;
        document.querySelectorAll('.cmp-use').forEach(function (choice) {
          choice.disabled = false;
        });
        if (hint) hint.hidden = false;
      };

      /* On force le modèle pour CE seul appel, sans toucher aux réglages : une
         relance ponctuelle ne doit pas changer le fournisseur par défaut. */
      var ponctuel = Object.assign({}, settings, {
        models: Object.assign({}, settings.models, (function () {
          var m = {}; m[o.provider] = o.model; return m;
        })())
      });
      /* Rejoue exactement le contexte du repas estimé, pas les champs que
         l'utilisateur aurait pu commencer à remplir pour le repas suivant. */
      var ctx = lastEstimateContext
        ? safePendingContext(lastEstimateContext, lastEstimateContext.imageCount || 0)
        : {
            referenceMode: inputMode === 'texte' ? 'none' : selectedReferenceMode(),
            notes: $('user-notes').value,
            extras: extrasText(),
            imageCount: inputMode === 'texte' ? 0 : images.length,
            viewMeasurements: inputMode === 'texte' ? [] :
              viewMeasurementsOfSent(images, selectedReferenceMode())
          };
      var sent = ctx.imageCount > 0 ? lastEstimateImages.slice() : [];

      var avant = lastResult ? lastResult.totalCarbsG : null;
      var isStillSource = function () {
        if (!isCurrentRerun() || currentHistoryDate !== sourceDate) return false;
        return sourceCompare ? lastCompare === sourceCompare
          : (lastCompare === null && lastResult === sourceResult);
      };

      Estimator.estimateWith(o.provider, sent, ctx, ponctuel).then(function (r) {
        if (!isStillSource()) { fini(); return; }
        fini();
        lastRunProvider = o.provider;
        lastRunModel = o.model;

        /* Depuis l'écran de comparaison, le nouvel avis s'AJOUTE en colonne.
           Le remplacer par son seul résultat effaçait les deux avis qu'on
           venait justement de lui demander de départager — on se retrouvait
           avec un troisième chiffre isolé, et plus rien à quoi le comparer. */
        if (lastCompare) {
          var suite = lastCompare.concat([{ ok: true, provider: o.provider, result: r }]);
          renderCompare(suite);
          toast(escapeHtml(o.label) + ' : ' + r.totalCarbsG + ' g (' +
                fr(partsFrom(r.totalCarbsG)) + ' parts)');
          return;
        }

        lastResult = r;
        currentDominantConfirmed = false;
        currentHistoryConfirmed = false;
        /* keepPosition : sans ça la page remonte en haut et on perd le fil de ce
           qu'on était en train de comparer. */
        renderResults(r, true);
        var ecart = (avant != null && avant > 0)
          ? ' · ' + (r.totalCarbsG > avant ? '+' : '') + (r.totalCarbsG - avant) + ' g vs ' + avant + ' g'
          : '';
        toast(escapeHtml(o.label) + ' : ' + r.totalCarbsG + ' g (' +
              fr(partsFrom(r.totalCarbsG)) + ' parts)' + ecart);
      }).catch(function (e) {
        if (!isStillSource()) { fini(); return; }
        fini();
        if (status) {
          status.className = 'rerun-status rerun-fail';
          status.innerHTML = '❌ ' + escapeHtml(e.message);
        }
        toast(e.message);
      });
    });
  }

  // ---------- Repas fréquents ----------
  function promptSaveMeal(items) {
    if (!items || !items.length) { toast('Rien à enregistrer.'); return; }
    var suggestion = items.slice(0, 2).map(function (it) { return it.name; }).join(' + ');
    var name = prompt('Nom de ce repas fréquent :', suggestion);
    if (name == null) return;
    name = name.trim();
    if (!name) { toast('Donne un nom au repas.'); return; }
    if (!Storage.saveMeal(name, items)) {
      toast('Repas fréquent non enregistré : stockage indisponible.');
      return;
    }
    renderSavedMeals();
    toast('« ' + name + ' » enregistré. Retrouve-le dans l\'onglet Manuel.');
  }

  function renderSavedMeals() {
    var box = $('saved-meals'), empty = $('saved-meals-empty');
    if (!box) return;
    var meals = Storage.getSavedMeals();
    // Le volet reste accessible même vide : on y explique alors comment le remplir.
    if (empty) empty.hidden = meals.length > 0;
    box.innerHTML = '';
    meals.forEach(function (m) {
      var el = document.createElement('div');
      el.className = 'saved-meal';
      el.innerHTML =
        '<button class="saved-meal-load" data-load="' + m.id + '">' +
          '<span class="saved-meal-name">' + escapeHtml(m.name) + '</span>' +
          '<span class="saved-meal-carbs">' + fr(partsFrom(m.totalCarbsG)) + ' parts · ' + m.totalCarbsG + ' g</span>' +
        '</button>' +
        '<button class="saved-meal-del" data-del="' + m.id + '" aria-label="Supprimer">🗑️</button>';
      box.appendChild(el);
    });
    box.querySelectorAll('[data-load]').forEach(function (b) {
      b.addEventListener('click', function () { loadSavedMeal(b.dataset.load); });
    });
    box.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        Storage.deleteSavedMeal(b.dataset.del);
        renderSavedMeals();
        toast('Repas supprimé.');
      });
    });
  }

  /* Recharge un repas enregistré dans le mode manuel. Les glucides sont ceux
     validés la première fois : on les réinjecte tels quels (mode grammes avec
     une densité de 100 %) plutôt que de les ré-estimer. */
  function loadSavedMeal(id) {
    var meal = Storage.getSavedMeals().filter(function (m) { return m.id === id; })[0];
    if (!meal) return;
    manualItems = meal.items.map(function (it) {
      return {
        name: it.name, carb: 100, custom: false,
        portions: [], mode: 'grams', portionIndex: 0, qty: 1,
        grams: Math.round(it.carbsG)
      };
    });
    renderManualItems();
    toast('« ' + meal.name +' » chargé.');
    var t = $('manual-total');
    if (t) t.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function renderItems() {
    var list = $('items-list');
    list.innerHTML = '';
    lastResult.items.forEach(function (it, idx) {
      // densité pour recalcul si on édite les grammes
      var density = it.carbDensityPer100g;
      if ((density == null || !isFinite(density)) && it.estimatedMassG) {
        density = it.carbsG / it.estimatedMassG * 100;
      }
      var editableGrams = it.estimatedMassG != null && density != null && isFinite(density);

      var row = document.createElement('div');
      row.className = 'item-row';
      /* La portion et les hypothèses sont déjà détaillées dans « Ce que l'IA a
         vu » : ici on ne garde que ce qui sert à CORRIGER, sinon la même
         information s'affiche deux fois d'affilée. */

      var editControl = editableGrams
        ? '<input class="input small item-grams-edit" type="number" min="0" step="5" value="' +
          Math.round(it.estimatedMassG) + '" data-i="' + idx + '" data-d="' + density + '"> g'
        : '<input class="input small item-grams-edit" type="number" min="0" step="1" value="' +
          it.carbsG + '" data-i="' + idx + '" data-carb="1"> g gluc.';

      row.innerHTML =
        '<div class="item-main">' +
        '  <div class="item-name"><input class="input item-name-edit" type="text" value="' +
             escapeHtml(it.name) + '" data-name-i="' + idx + '" aria-label="Nom de l’aliment">' +
             ' <span class="mini-conf conf-' + it.confidence + '">' +
             (CONF_SHORT[it.confidence] || it.confidence) + '</span></div>' +
        '  <div class="item-detail">' + editControl + '</div>' +
        '</div>' +
        '<div class="item-carb">' + it.carbsG + ' g</div>' +
        '<button class="item-remove" data-rm="' + idx + '" aria-label="Retirer">🗑️</button>';
      list.appendChild(row);
    });

    // Édition des grammes / glucides
    list.querySelectorAll('.item-name-edit').forEach(function (inp) {
      inp.addEventListener('change', function () {
        var i = parseInt(inp.dataset.nameI, 10);
        var name = inp.value.trim();
        if (!name) { inp.value = lastResult.items[i].name; return; }
        var it = lastResult.items[i];
        if (name !== it.name) {
          /* Changer le nom ne change RIEN au calcul : les glucides, la masse et
             la densité restent ceux de l'aliment d'avant. On marque donc la
             ligne, ce qui pose un blocage et retire le nombre, jusqu'à ce que
             les glucides soient repris à la main. Sans ça, renommer donnait le
             sentiment d'avoir corrigé une erreur d'identification alors que le
             chiffre saisi dans la pompe n'avait pas bougé d'un gramme. */
          if (!it.needsNutrition) it.renamedFrom = it.name;
          it.needsNutrition = true;
          /* Masse, densité et macros décrivent l'ancien aliment. Les garder
             permettait de débloquer la ligne en changeant seulement sa masse,
             donc de calculer l'avoine avec la densité du fromage blanc. */
          it.estimatedMassG = null;
          it.carbDensityPer100g = null;
          it.proteinG = null;
          it.fatG = null;
          it.kcal = null;
        }
        it.name = name;
        recomputeTotal();
        renderResults(lastResult, true);
      });
    });
    list.querySelectorAll('.item-grams-edit').forEach(function (inp) {
      inp.addEventListener('change', function () {
        var i = parseInt(inp.dataset.i, 10);
        var v = Math.max(0, parseFloat(inp.value) || 0);
        if (inp.dataset.carb) {
          lastResult.items[i].carbsG = Math.round(v);
        } else {
          var d = parseFloat(inp.dataset.d);
          lastResult.items[i].estimatedMassG = v;
          lastResult.items[i].carbsG = Math.round(v * d / 100);
        }
        /* Reprendre le chiffre à la main est ce qui lève le blocage posé par un
           renommage : à partir d'ici les glucides ne viennent plus de l'aliment
           précédent, ils viennent de l'utilisateur. */
        delete lastResult.items[i].needsNutrition;
        delete lastResult.items[i].renamedFrom;
        recomputeTotal();
        renderResults(lastResult, true);
      });
    });
    list.querySelectorAll('.item-remove').forEach(function (b) {
      b.addEventListener('click', function () {
        lastResult.items.splice(parseInt(b.dataset.rm, 10), 1);
        recomputeTotal();
        renderResults(lastResult, true);
      });
    });
  }

  /* Réparer un oubli du modèle sans jeter toute l'analyse. La valeur demandée
     est celle de LA portion réellement mangée, pas une densité pour 100 g :
     cela évite d'obliger l'utilisateur à inventer une masse. */
  function initResultItemAdder() {
    var btn = $('add-result-item');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var name = prompt('Quel aliment manque dans le résultat ?');
      if (name == null) return;
      name = name.trim().slice(0, 160);
      if (!name) { toast('Indique le nom de l’aliment manquant.'); return; }
      var raw = prompt('Combien de grammes de glucides contient la portion mangée de « ' + name + ' » ?');
      if (raw == null) return;
      var carbs = Number(String(raw).replace(',', '.'));
      if (!isFinite(carbs) || carbs <= 0 || carbs > 400) {
        toast('Indique un nombre de glucides entre 1 et 400 g.');
        return;
      }
      lastResult.items.push({
        name: name,
        portionDescription: 'portion ajoutée manuellement',
        estimatedMassG: null,
        carbDensityPer100g: null,
        carbsG: Math.round(carbs),
        added: true,
        confidence: 'medium',
        assumptions: 'Valeur saisie manuellement.'
      });
      recomputeTotal();
      renderResults(lastResult, true);
      toast('« ' + name + ' » ajouté au calcul.');
    });
  }

  function currentResultEntry(date) {
    var entry = {
      date: date,
      // Distinguer les trois origines : l'historique et la synthèse médecin
      // n'ont pas la même valeur selon qu'une portion a été vue ou décrite.
      source: lastResult.fromText ? 'texte' : 'photo',
      draft: !currentHistoryConfirmed,
      confirmed: !!currentHistoryConfirmed,
      /* Un avis provisoire autosauvegardé pendant la comparaison ne peut pas
         être confirmé depuis l'historique avant un clic explicite sur Retenir. */
      choiceRequired: !!currentChoiceRequired,
      // Le total enregistré est celui qui a été AFFICHÉ, donc la moyenne des deux
      // modèles quand la fusion est active : c'est lui qui a servi à doser, et
      // c'est donc lui que la calibration doit comparer aux glucides réels.
      totalCarbsG: shownTotal(lastResult),
      parts: partsFrom(shownTotal(lastResult)),
      /* Un brouillon incohérent reste enregistré — rien ne doit se perdre — mais
         il est marqué, pour qu'on ne le retrouve pas des semaines plus tard sans
         savoir que son total avait été refusé à l'écran. */
      blocked: !!(lastResult.blocking && lastResult.blocking.length),
      blocking: lastResult.blocking && lastResult.blocking.length
        ? lastResult.blocking.slice(0, 10) : [],
      dominantRequired: !!dominantItem(lastResult),
      dominantConfirmed: !dominantItem(lastResult) || !!currentDominantConfirmed,
      mergedFrom: typeof lastResult.mergedTotalCarbsG === 'number'
        ? [lastResult.totalCarbsG, lastResult.verifyTotalCarbsG] : null,
      partSizeG: settings.partSizeG,
      provider: lastResult.provider || settings.provider,
      model: lastResult.model || (settings.models || {})[settings.provider] || '',
      glycemicSpeed: lastResult.glycemicSpeed || null,
      gi: lastResult.gi ? { gl: lastResult.gi.gl, gi: lastResult.gi.gi } : null,
      seen: lastResult.seen || '',
      venue: lastEstimateContext && /^(maison|restaurant|cantine)$/.test(
        lastEstimateContext.venue || '') ? lastEstimateContext.venue : '',
      input: lastEstimateContext ? {
        referenceMode: lastEstimateContext.referenceMode || 'none',
        notes: lastEstimateContext.notes || '',
        extras: lastEstimateContext.extras || '',
        imageCount: lastEstimateContext.imageCount || 0,
        viewMeasurements: lastEstimateContext.viewMeasurements || [],
        mealAt: lastEstimateContext.mealAt || null,
        venue: lastEstimateContext.venue || '',
        clarificationAnswered: lastEstimateContext.clarificationAnswered === true
      } : null,
      /* On garde la portion et l'origine de chaque aliment : c'est ce qui rend
         le détail de l'historique consultable des semaines plus tard. Ce sont
         des chaînes courtes, sans commune mesure avec le poids d'une image. */
      items: lastResult.items.map(function (it) {
        return {
          name: it.name,
          carbsG: it.carbsG,
          portion: it.portionDescription || '',
          added: !!it.added
        };
      }),
      /* Les trois avis restent disponibles dans l'historique, même si un seul
         a ensuite été retenu pour les corrections. */
      opinions: (lastComparisonArchive || []).slice(0, 3).map(function (opinion) {
        return {
          provider: opinion.provider || '',
          ok: !!opinion.ok,
          error: opinion.ok ? '' : String(opinion.error || '').slice(0, 500),
          model: opinion.ok && opinion.result
            ? String(opinion.result.model || '').slice(0, 200) : '',
          totalCarbsG: opinion.ok && opinion.result ? opinion.result.totalCarbsG : null,
          items: opinion.ok && opinion.result
            ? (opinion.result.items || []).slice(0, 40).map(function (it) {
                return { name: it.name, carbsG: it.carbsG,
                         portion: it.portionDescription || '' };
              }) : []
        };
      })
    };
    /* Snapshot sans photo ni secret : il permet de reprendre un brouillon après
       que la WebView a été recyclée, puis de corriger/valider le même repas. */
    try { entry.resultSnapshot = JSON.parse(JSON.stringify(lastResult)); }
    catch (e) { entry.resultSnapshot = null; }
    if (lastVerification && !lastVerification.loading) {
      entry.verification = {
        provider: lastVerification.provider,
        model: lastVerification.model || '',
        ok: !!lastVerification.ok,
        totalCarbsG: lastVerification.ok ? lastVerification.total : null,
        items: lastVerification.ok ? (lastVerification.items || []) : [],
        error: lastVerification.ok ? '' : (lastVerification.error || ''),
        checkedAt: lastVerification.checkedAt || Date.now()
      };
    }
    return entry;
  }

  function updateResultSaveState() {
    var status = $('result-save-status');
    var btn = $('confirm-result');
    // En cas de blocage, l'encadré de résultat n'existe pas : rien à mettre à jour.
    if (!status || !btn) return;
    status.classList.toggle('confirmed', currentHistoryConfirmed);
    status.innerHTML = '<span class="autosave-dot"></span><span>' +
      (currentHistoryConfirmed
        ? 'Repas confirmé dans l\'historique'
        : 'Brouillon sauvegardé automatiquement') + '</span>';
    btn.disabled = currentHistoryConfirmed;
    if (currentChoiceRequired) {
      btn.disabled = true;
      btn.textContent = 'Choisis d’abord une estimation';
    } else {
      btn.textContent = currentHistoryConfirmed ? '✓ Repas confirmé' : '✓ Confirmer ce repas';
    }
  }

  function prepareCurrentHistoryPhoto(date) {
    if (currentHistoryPhotoStarted) return;
    currentHistoryPhotoStarted = true;

    /* Image de la 1ʳᵉ vue, pour revoir plus tard à quoi ressemblait la portion.
       PWA : une vignette de 320 px en base64, seule taille que le quota de
       localStorage tolère. APK : la photo entière, écrite comme un vrai fichier
       — aucune raison de la dégrader puisqu'il n'y a plus de quota. */
    var first = lastEstimateImages[0];
    if (!first || !first.previewUrl) return;

    if (Native.isApp && first && first.previewUrl) {
      var media = first.mediaType || 'image/jpeg';
      var extension = media === 'image/png' ? '.png' :
        (media === 'image/webp' ? '.webp' : '.jpg');
      var photoName = 'meal-' + date + extension;
      Native.photos.save(photoName, first.previewUrl)
        .then(function (name) {
          if (!name) {
            currentHistoryPhotoStarted = false;
            return;
          }
          var saved = Storage.updateHistory(date, { photo: name });
          var attached = saved && saved.some(function (e) {
            return e.date === date && e.photo === name;
          });
          if (!attached) {
            currentHistoryPhotoStarted = false;
            Native.photos.remove(name);
            toast('Photo non jointe au brouillon : stockage indisponible.');
          }
        })
        .catch(function () { currentHistoryPhotoStarted = false; });
    } else if (first && first.previewUrl && Camera.makeThumb) {
      Camera.makeThumb(first.previewUrl)
        .then(function (thumb) {
          if (!thumb) { currentHistoryPhotoStarted = false; return; }
          var saved = Storage.updateHistory(date, { thumb: thumb });
          var attached = saved && saved.some(function (e) {
            return e.date === date && e.thumb === thumb;
          });
          if (!attached) {
            currentHistoryPhotoStarted = false;
            toast('Vignette non jointe au brouillon : stockage indisponible.');
          }
        })
        .catch(function () { currentHistoryPhotoStarted = false; });
    }
  }

  function autoSaveCurrentResult() {
    if (!lastResult) return false;
    if (!currentHistoryDate) currentHistoryDate = Date.now();
    var entry = currentResultEntry(currentHistoryDate);
    var saved = Storage.upsertHistory(entry);
    if (!saved) {
      toast('Brouillon non enregistré : libère de l’espace puis réessaie.');
      return false;
    }
    prepareCurrentHistoryPhoto(currentHistoryDate);
    updateResultSaveState();
    return true;
  }

  function confirmCurrentResult() {
    if (!lastResult) return;
    if (currentChoiceRequired) {
      toast('Compare les colonnes puis appuie sur Retenir avant de confirmer ce repas.');
      return;
    }
    /* Un repas incohérent ne doit pas entrer dans l'historique : il y servirait
       ensuite de référence à la calibration personnelle, et un total faux s'y
       propagerait bien après avoir été oublié. */
    if (lastResult.blocking && lastResult.blocking.length) {
      toast('Corrige d\'abord l\'incohérence signalée : ce total ne peut pas être confirmé.');
      return;
    }
    if (dominantItem(lastResult) && !currentDominantConfirmed) {
      toast('Confirme d’abord la nature de l’aliment principal, ou corrige son nom.');
      var box = document.querySelector('.dominant-box');
      if (box) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (!autoSaveCurrentResult()) return;
    if (currentHistoryConfirmed) { oublierEnCours(); return; }
    currentHistoryConfirmed = true;
    var entry = currentResultEntry(currentHistoryDate);
    var saved = Storage.upsertHistory(entry);
    if (!saved) {
      currentHistoryConfirmed = false;
      toast('Impossible d’enregistrer ce repas : stockage indisponible.');
      updateResultSaveState();
      return;
    }
    oublierEnCours();
    updateResultSaveState();
    scheduleReminderFor(entry);
    toast('Repas confirmé dans l\'historique.');
  }

  // ---------- Rappel de contrôle (APK) ----------

  /* Délais par défaut calés sur la vitesse d'absorption déjà estimée par l'IA :
     un repas gras/protéiné pique tard, inutile de contrôler à 1 h. Ce sont des
     moments de MESURE, pas des recommandations de traitement — l'app ne propose
     jamais de dose, c'est la pompe qui dose. */
  var REMIND_DEFAULT_MIN = { rapide: 90, moderee: 120, lente: 180 };

  function scheduleReminderFor(entry) {
    if (!Native.isApp || !settings.remindEnabled) return;
    var delay = settings.remindDelayMin > 0
      ? settings.remindDelayMin
      : (REMIND_DEFAULT_MIN[entry.glycemicSpeed] || 120);
    var at = new Date(entry.date + delay * 60000);
    Native.notify.schedule({
      // Identifiant 32 bits stable et unique : l'horodatage du repas en secondes.
      id: Math.floor(entry.date / 1000),
      title: 'Contrôle glycémie',
      body: 'Ouvre GlucoVision pour ton contrôle après repas.',
      at: at
    }).then(function (ok) {
      if (ok) {
        toast('⏰ Rappel de contrôle à ' +
          at.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) + '.');
      }
    });
  }

  // ---------- Mode manuel ----------
  var currentCat = 'Tous';

  function initManual() {
    var search = $('food-search');
    search.addEventListener('input', function () { renderFoodResults(search.value); });
    initCustomFoodForm();
    initOnlineTools();
    initPortionCard();
    initUnknownProduct();
    renderLocalNote();
    renderChips();
    renderFoodResults('');
    renderSavedMeals();
    $('manual-dock-btn').addEventListener('click', function () {
      $('manual-meal-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  // ---------- Recherche en ligne (OpenFoodFacts) + code-barres ----------
  var scanBusy = false, lastScanCode = null, lastScanAt = 0;
  var scanGeneration = 0, offSearchGeneration = 0;

  function initOnlineTools() {
    var offGo = function () { runOffSearch($('off-search').value); };
    $('off-search-btn').addEventListener('click', offGo);
    // Entrée lance la recherche : c'est le geste attendu dans un champ de recherche.
    $('off-search').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); offGo(); }
    });
    $('barcode-btn').addEventListener('click', openBarcode);
    $('close-barcode').addEventListener('click', closeBarcode);
    $('barcode-manual-go').addEventListener('click', function () {
      var brut = $('barcode-manual').value || '';
      var code = Storage.canonicalBarcode ? Storage.canonicalBarcode(brut) : String(brut).trim();
      if (code) {
        $('barcode-manual').removeAttribute('aria-invalid');
        processBarcode(code);
      } else {
        $('barcode-manual').setAttribute('aria-invalid', 'true');
        showBarcodeStatus('Saisis uniquement les chiffres d’un code EAN/UPC, pas un QR code ou une URL.');
      }
    });
    $('barcode-manual').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); $('barcode-manual-go').click(); }
    });
  }

  function runOffSearch(query) {
    /* Une nouvelle intention invalide immédiatement la précédente, y compris si
       la nouvelle saisie est trop courte. Sans ce jeton, une réponse lente à A
       pouvait remplacer les résultats déjà affichés pour B. */
    var generation = ++offSearchGeneration;
    query = (query || '').trim();
    if (query.length < 2) { toast('Tape au moins 2 lettres avant de chercher en ligne.'); return; }
    var status = $('off-status'), box = $('off-results');
    box.hidden = true;
    status.hidden = false;
    status.innerHTML = '<div class="spinner"></div>Recherche « ' + escapeHtml(query) + ' » dans OpenFoodFacts…';
    OFF.search(query).then(function (list) {
      if (generation !== offSearchGeneration) return;
      status.hidden = true;
      renderOffResults(list);
    }).catch(function (e) {
      if (generation !== offSearchGeneration) return;
      status.hidden = true;
      /* OpenFoodFacts injoignable ou en panne. Les produits déjà rencontrés
         restent trouvables : c'est le seul moment où ce repli sert vraiment,
         et c'est aussi le moment où on est devant son frigo sans réseau. */
      var locaux = Storage.searchProducts ? Storage.searchProducts(query) : [];
      if (locaux.length) {
        renderOffResults(locaux, 'hors ligne');
        toast('OpenFoodFacts injoignable — ' + locaux.length +
              ' produit(s) trouvé(s) dans ta base locale.');
        return;
      }
      toast(e.message);
    });
  }

  function renderOffResults(list, origine) {
    var box = $('off-results');
    box.hidden = false;
    if (!list.length) {
      box.innerHTML = '<p class="empty">Aucun produit trouvé en ligne. Essaie un autre mot, ou un code-barres.</p>';
      return;
    }
    box.innerHTML = '<div class="off-head">' + list.length + ' produit(s) ' +
      (origine === 'hors ligne' ? 'dans ta base locale' : 'en ligne') + ' :</div>';
    list.forEach(function (f) {
      var el = document.createElement('div');
      el.className = 'food-item off-item';
      var brand = f.brand ? ' <span class="off-brand">' + escapeHtml(f.brand) + '</span>' : '';
      el.innerHTML =
        '<button type="button" class="food-label">' + escapeHtml(f.n) + brand +
        ' <span class="item-detail">(' + fr(f.carb) + ' g/100 g)</span></button>' +
        '<span class="food-actions"><button type="button" class="food-add" aria-label="Ajouter ' +
        escapeHtml(f.n) + '">＋</button></span>';
      var add = function () { showPortionCard(f); };
      el.querySelector('.food-label').addEventListener('click', add);
      el.querySelector('.food-add').addEventListener('click', function (e) { e.stopPropagation(); add(); });
      box.appendChild(el);
    });
  }

  // Ouvre une vraie saisie en grammes. La « portion » contributive d'OFF
  // n'est pas utilisée : elle peut être exprimée par portion, mal renseignée,
  // ou valoir 100 g par défaut. L'utilisateur donne donc lui-même le poids.
  function addOffFood(f) {
    addFoodToMeal({
      n: offName(f), carb: f.carb, portions: [], custom: false,
      startGrams: 0, focusGrams: true
    });
  }

  function offName(f) {
    return f.n + (f.brand ? ' (' + f.brand + ')' : '');
  }

  /* ---------- Calcul de portion à l'unité ----------
     L'emballage donne des glucides pour 100 g. On ne mange pas 100 g : on mange
     deux biscuits. Faire la conversion de tête suppose de connaître le poids du
     paquet, de le diviser par le nombre d'unités, puis de multiplier — pendant
     qu'on est en train de se servir.

     OpenFoodFacts sait presque toujours ce que pèse le paquet, et presque jamais
     combien d'unités il contient : personne ne saisit « 12 biscuits ». Ce
     dernier chiffre vient donc de toi, mais une seule fois par code-barres.

     serving_size n'est volontairement pas utilisé comme raccourci : il est
     saisi par les contributeurs et régulièrement faux (le Prince au chocolat y
     annonce une portion de 250 g, soit la moitié du paquet). */
  var portionProduit = null;
  var portionDefinitionConfirmed = false;
  var portionSuggestionPending = false;

  function portionNombre(id) {
    var el = $(id);
    return parseFloat(((el && el.value) || '').replace(',', '.'));
  }

  function portionMode() {
    var direct = $('portion-mode-unit');
    return direct && direct.checked ? 'unite' : 'paquet';
  }

  function setPortionMode(mode) {
    var direct = mode === 'unite';
    if ($('portion-mode-unit')) $('portion-mode-unit').checked = direct;
    if ($('portion-mode-pack')) $('portion-mode-pack').checked = !direct;
    if ($('portion-unit-fields')) $('portion-unit-fields').hidden = !direct;
    if ($('portion-pack-fields')) $('portion-pack-fields').hidden = direct;
  }

  function portionFingerprint(total, unite) {
    if (Storage.packageFingerprint) return Storage.packageFingerprint(total, unite);
    var n = parseFloat(total);
    return (isFinite(n) && n > 0) ? String(unite || 'g') + ':' + Math.round(n * 100) / 100 : '';
  }

  function packagingStillMatches(memoire, pack, unite) {
    if (!memoire || memoire.confirmed === false) return false;
    /* Un poids saisi/pesé directement pour une unité ne dépend pas du poids
       total du paquet. Seule la méthode « total ÷ compte » est invalidée par
       un changement de format. */
    if (memoire.methode === 'unite') {
      return memoire.parUnite > 0 && memoire.unite === unite;
    }
    if (!pack || !(pack.total > 0)) return true;
    var actuel = portionFingerprint(pack.total, unite);
    var ancien = memoire.fingerprint || memoire.packageFingerprint ||
      portionFingerprint(memoire.fingerprintTotal || memoire.total, memoire.fingerprintUnit || memoire.unite);
    return !ancien || ancien === actuel;
  }

  function updatePortionSuggestion(message) {
    var box = $('portion-suggestion');
    if (!box) return;
    box.hidden = !portionSuggestionPending;
    if ($('portion-suggestion-text') && message) $('portion-suggestion-text').textContent = message;
  }

  function showPortionCard(f) {
    var carte = $('portion-card');
    if (!carte) { addOffFood(f); return; }
    /* Une correction recopiée sur l'étiquette reste prioritaire quel que soit
       le chemin d'entrée. Le scanner le garantissait déjà ; une recherche OFF
       par nom ne doit pas contourner ce choix et calculer avec la fiche publique. */
    var personnel = f && f.code && Storage.getProduct ? Storage.getProduct(f.code) : null;
    if (personnel && personnel.source === 'perso') f = personnel;
    portionProduit = f;

    /* Le produit est conservé hors ligne, sans qu'une réponse OFF puisse
       remplacer une correction personnelle déjà enregistrée. */
    if (f.code && Storage.setProduct) Storage.setProduct(f.code, f, f.source || 'off');
    renderLocalNote();

    var pack = f.pack || null;
    var memoire = (f.code && Storage.getPackaging) ? Storage.getPackaging(f.code, pack) : null;
    var unite = (pack && pack.unite) || (memoire && memoire.unite) || 'g';
    var memoireValide = packagingStillMatches(memoire, pack, unite);
    /* Le poids courant d'OFF gagne sur un ancien poids mémorisé. Ce qui est
       personnel et durable, c'est le compte de biscuits, pas une fiche produit
       qui peut avoir changé de format. */
    var total = (pack && pack.total) || (memoireValide && memoire.total) || '';
    var unites = (memoireValide && memoire.unites) ||
      (pack && pack.unitesSuggerees) || '';
    var poidsUnite = (memoireValide && memoire.parUnite) ||
      (pack && pack.parUniteSuggeree) || '';
    var mode = memoireValide && memoire.methode === 'unite' ? 'unite' : 'paquet';
    var label = (memoireValide && memoire.label) || (pack && pack.labelSuggere) ||
      (Portion.labelFromText && Portion.labelFromText(f.n)) || 'unité';

    $('portion-name').textContent = offName(f);
    $('portion-carb').textContent = fr(f.carb) + ' g de glucides pour 100 ' + unite +
      ' · valeur d’étiquette à vérifier' + (f.code ? ' · code ' + f.code : '');
    $('portion-total').value = total;
    $('portion-units').value = unites;
    $('portion-label').value = label;
    $('portion-eat').value = 1;
    $('portion-unite').textContent = unite;
    if ($('portion-unit-weight')) $('portion-unit-weight').value = poidsUnite;
    if ($('portion-unit-weight-unit')) $('portion-unit-weight-unit').textContent = unite;
    setPortionMode(mode);

    portionDefinitionConfirmed = !!memoireValide;
    portionSuggestionPending = !portionDefinitionConfirmed && !!(
      (pack && (pack.unitesSuggerees > 0 || pack.parUniteSuggeree > 0)) ||
      (total > 0 && unites > 0)
    );
    var suggestionMessage = pack && pack.suggestionConflit
      ? 'Les nombres trouvés sur la fiche se contredisent. Regarde le paquet et corrige-les avant de confirmer.'
      : 'Suggestion lue sur la fiche produit. Vérifie le nombre d’unités sur ton paquet avant de confirmer.';
    updatePortionSuggestion(suggestionMessage);

    carte.hidden = false;
    updatePortion();
    var vide = mode === 'unite'
      ? (!(poidsUnite > 0) ? $('portion-unit-weight') : $('portion-eat'))
      : (!(total > 0) ? $('portion-total') : (!(unites > 0) ? $('portion-units') : $('portion-eat')));
    carte.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    /* La fermeture du scanner ne restaure pas son propre focus. On attend le
       rendu de la carte avant de cibler le premier champ utile. */
    requestAnimationFrame(function () {
      if (!portionProduit || !vide) return;
      try { vide.focus(); } catch (e) {}
    });
  }

  function hidePortionCard() {
    var carte = $('portion-card');
    if (carte) carte.hidden = true;
    portionProduit = null;
    portionDefinitionConfirmed = false;
    portionSuggestionPending = false;
  }

  function portionSaisie() {
    return {
      methode: portionMode(),
      total: portionNombre('portion-total'),
      unites: portionNombre('portion-units'),
      parUnite: portionNombre('portion-unit-weight'),
      mange: portionNombre('portion-eat'),
      label: ($('portion-label').value || '').trim() || 'unité'
    };
  }

  /* Singulier/pluriel du nom d'unité. Sans ça on lit « 1 biscuits », et une
     interface qui écrit mal un nombre inspire moins confiance dans le nombre. */
  function nomUnite(label, n) {
    var base = label || 'unité';
    if (n <= 1) return base.replace(/s$/, '');
    return /s$/.test(base) ? base : base + 's';
  }

  function updatePortion() {
    if (!portionProduit) return;
    var s = portionSaisie();
    var unite = $('portion-unite').textContent || 'g';
    var res = $('portion-result');
    var btn = $('portion-add');
    $('portion-eat-unit').textContent = nomUnite(s.label, s.mange || 1);

    var r = Portion.calculeUnites({
      methode: s.methode, total: s.total, unites: s.unites,
      parUnite: s.parUnite, mange: s.mange, pour100: portionProduit.carb
    });
    if (!r) {
      btn.disabled = true;
      btn.textContent = 'Complète les informations';
      res.className = 'portion-result';
      res.textContent = s.methode === 'unite'
        ? (!(s.parUnite > 0) ? 'Indique le poids d’un ' + nomUnite(s.label, 1) + '.'
          : 'Indique combien tu en manges.')
        : (!(s.total > 0) ? 'Indique le poids total du paquet.'
          : !(s.unites > 0 && Math.floor(s.unites) === s.unites)
            ? 'Combien d’unités entières contient le paquet ?'
            : 'Indique combien tu en manges.');
      return;
    }
    btn.disabled = !portionDefinitionConfirmed;
    res.className = 'portion-result ok' + (!portionDefinitionConfirmed ? ' needs-confirmation' : '');
    res.innerHTML =
      '1 ' + escapeHtml(nomUnite(s.label, 1)) + ' = <strong>' + fr(r.parUnite) + ' ' + unite + '</strong><br>' +
      fr(s.mange) + ' ' + escapeHtml(nomUnite(s.label, s.mange)) + ' = <strong>' +
      fr(r.quantite) + ' ' + unite + '</strong> → <strong>' + fr(r.glucides) +
      ' g de glucides</strong>' +
      (!portionDefinitionConfirmed ? '<br><span>Vérifie puis confirme les données du paquet.</span>' : '') +
      (r.depassePaquet ? '<br><span class="portion-warning">Attention : cela dépasse un paquet complet.</span>' : '');
    if (portionDefinitionConfirmed) {
      btn.textContent = 'Ajouter ' + fr(s.mange) + ' ' + nomUnite(s.label, s.mange) +
        ' · ' + fr(r.glucides) + ' g';
    } else {
      btn.textContent = 'Vérifie le paquet pour continuer';
    }
  }

  function ajouterPortion() {
    if (!portionProduit) return;
    var s = portionSaisie();
    var r = Portion.calculeUnites({
      methode: s.methode, total: s.total, unites: s.unites,
      parUnite: s.parUnite, mange: s.mange, pour100: portionProduit.carb
    });
    if (!r || !portionDefinitionConfirmed) return;

    if (portionProduit.code && Storage.setPackaging) {
      Storage.setPackaging(portionProduit.code, {
        methode: s.methode, total: s.total, unites: s.unites,
        parUnite: r.parUnite, label: s.label,
        unite: $('portion-unite').textContent, confirmed: true,
        fingerprintTotal: s.methode === 'paquet' ? s.total : null,
        fingerprintUnit: $('portion-unite').textContent
      });
    }

    /* On enregistre l'unité comme PORTION, pas comme un poids figé : la ligne du
       repas garde ainsi son sélecteur et son compteur, et corriger « finalement
       j'en ai pris trois » reste un seul appui. */
    var nom = offName(portionProduit);
    addFoodToMeal({
      n: nom, carb: portionProduit.carb, custom: false,
      portions: [['1 ' + nomUnite(s.label, 1), r.parUnite]],
      qty: s.mange
    });
    hidePortionCard();
  }

  /* Le nombre de produits gardés localement. Ce n'est pas de la décoration : il
     dit combien de produits restent utilisables quand OpenFoodFacts tombe ou
     qu'il n'y a pas de réseau — et il grandit à chaque scan. */
  function renderLocalNote() {
    var el = $('off-local-note');
    if (!el || !Storage.countProducts) return;
    var n = Storage.countProducts();
    var reperes = Foods && Foods.all ? Foods.all.length : 0;
    el.textContent = reperes + ' repères alimentaires fonctionnent hors ligne. ' +
      (n
        ? n + ' produit(s) scanné(s) sont aussi gardés sur ce téléphone.'
        : 'Chaque produit scanné sera ensuite gardé sur ce téléphone.');
  }

  function initPortionCard() {
    if (!$('portion-card')) return;
    ['portion-total', 'portion-units', 'portion-unit-weight'].forEach(function (id) {
      if (!$(id)) return;
      $(id).addEventListener('input', function () {
        /* Modifier le compte (ou le poids direct) vaut vérification explicite.
           Modifier seulement le poids total ne valide jamais un compte suggéré
           par OFF : « 2 × 250 g » peut encore être deux sous-paquets. */
        if (id === 'portion-units' || id === 'portion-unit-weight' || !portionSuggestionPending) {
          portionDefinitionConfirmed = true;
          portionSuggestionPending = false;
        }
        updatePortionSuggestion();
        updatePortion();
      });
    });
    ['portion-eat', 'portion-label'].forEach(function (id) {
      if ($(id)) $(id).addEventListener('input', updatePortion);
    });
    ['portion-mode-pack', 'portion-mode-unit'].forEach(function (id) {
      if (!$(id)) return;
      $(id).addEventListener('change', function () {
        setPortionMode(portionMode());
        portionDefinitionConfirmed = false;
        var s = portionSaisie();
        portionSuggestionPending = s.methode === 'unite'
          ? s.parUnite > 0
          : s.total > 0 && s.unites > 0;
        updatePortionSuggestion('Vérifie le poids utilisé par ce mode, puis confirme.');
        updatePortion();
      });
    });
    Array.from(document.querySelectorAll('[data-portion-eat]')).forEach(function (b) {
      b.addEventListener('click', function () {
        $('portion-eat').value = b.dataset.portionEat;
        updatePortion();
      });
    });
    if ($('portion-confirm-suggestion')) {
      $('portion-confirm-suggestion').addEventListener('click', function () {
        var s = portionSaisie();
        var definitionComplete = s.methode === 'unite'
          ? s.parUnite > 0
          : s.total > 0 && s.unites > 0 && Math.floor(s.unites) === s.unites;
        if (!definitionComplete) {
          toast('Complète d’abord les informations du paquet.');
          updatePortion();
          return;
        }
        portionDefinitionConfirmed = true;
        portionSuggestionPending = false;
        updatePortionSuggestion();
        updatePortion();
      });
    }
    $('portion-add').addEventListener('click', ajouterPortion);
    $('portion-close').addEventListener('click', hidePortionCard);
    // Sortie de secours : un produit qu'on pèse (pâte à tartiner, riz) n'a pas
    // d'unités, et forcer un nombre d'unités n'aurait aucun sens.
    $('portion-whole').addEventListener('click', function () {
      if (portionProduit) addOffFood(portionProduit);
      hidePortionCard();
    });
  }

  function openBarcode() {
    $('barcode-manual').value = '';
    $('barcode-manual').removeAttribute('aria-invalid');
    scanGeneration++;
    codeEnCours = null;
    scanBusy = false; lastScanCode = null; lastScanAt = 0;
    $('barcode-status').hidden = true;
    $('barcode-unknown').hidden = true;
    showModal('barcode-modal', 'close-barcode');
    var video = $('barcode-video');
    if (Barcode.supported()) {
      Barcode.start(video, function (code) {
        var now = Date.now();
        if (scanBusy) return;
        if (code === lastScanCode && now - lastScanAt < 3000) return;
        lastScanCode = code; lastScanAt = now;
        processBarcode(code);
      }, function (err) {
        if (!scanBusy && activeModal === $('barcode-modal')) {
          showBarcodeStatus('📷 ' + err.message);
        }
      });
    } else {
      showBarcodeStatus('Scan caméra indisponible ici. Saisis le code-barres à la main ci-dessous.');
    }
  }

  function closeBarcode(restoreFocus) {
    try { Barcode.stop(); } catch (e) {}
    scanBusy = false;
    scanGeneration++;
    codeEnCours = null;
    hideModal('barcode-modal', restoreFocus !== false);
  }

  function showBarcodeStatus(msg) {
    var s = $('barcode-status');
    s.hidden = false;
    s.innerHTML = msg;
  }

  /* Recherche d'un code-barres.

     OpenFoodFacts d'abord, parce que c'est la source la plus complète. Mais deux
     situations le rendaient inutilisable et n'étaient pas traitées :

     — le service est en panne ou il n'y a pas de réseau (une cuisine n'est pas
       toujours couverte) : un produit déjà scanné échouait quand même ;
     — le produit n'est dans aucun catalogue : c'était un cul-de-sac.

     Désormais tout produit trouvé est conservé, et un produit inconnu peut être
     recopié une fois depuis son étiquette. La base qui compte n'est pas la plus
     grosse, c'est celle qui contient ce que tu achètes. */
  var codeEnCours = null;

  function scanToujoursActif(generation, code) {
    return generation === scanGeneration && code === codeEnCours &&
      activeModal === $('barcode-modal') && !$('barcode-modal').hidden;
  }

  function ouvrirPortionDepuisScan(f, generation, code, message) {
    if (!scanToujoursActif(generation, code)) return false;
    closeBarcode(false);
    showPortionCard(f);
    if (message) toast(message);
    return true;
  }

  function processBarcode(rawCode) {
    var code = Storage.canonicalBarcode
      ? Storage.canonicalBarcode(rawCode) : String(rawCode || '').trim();
    if (!code) {
      scanBusy = false;
      showBarcodeStatus('Ce contenu n’est pas un code-barres EAN/UPC utilisable.');
      return Promise.resolve(false);
    }

    /* La caméra est coupée dès la première lecture : elle ne consomme plus de
       batterie et ne peut pas lancer un second code pendant la requête. */
    try { Barcode.stop(); } catch (e) {}
    scanBusy = true;
    codeEnCours = code;
    var generation = ++scanGeneration;
    $('barcode-unknown').hidden = true;
    var checksumWarning = Storage.barcodeChecksumValid &&
      Storage.barcodeChecksumValid(code) === false
      ? '<br><span class="tiny">Le chiffre de contrôle paraît inhabituel ; recherche quand même.</span>' : '';
    showBarcodeStatus('<div class="spinner"></div>Recherche du produit ' + escapeHtml(code) + '…' + checksumWarning);

    var connu = Storage.getProduct ? Storage.getProduct(code) : null;

    /* Une valeur recopiée sur l'étiquette est un choix explicite : le réseau
       ne doit pas la remplacer visuellement par une ancienne fiche publique. */
    if (connu && connu.source === 'perso') {
      ouvrirPortionDepuisScan(connu, generation, code,
        'Valeur personnelle reprise pour ce produit.');
      return Promise.resolve(connu);
    }

    return OFF.lookupBarcode(code).then(function (f) {
      if (!scanToujoursActif(generation, code)) return null;
      if (f) {
        ouvrirPortionDepuisScan(f, generation, code);
        return f;
      }
      // Réseau bon, produit réellement absent d'OpenFoodFacts.
      if (connu) {
        ouvrirPortionDepuisScan(connu, generation, code);
        return connu;
      }
      demanderProduit(code, 'Ce produit n’est pas dans OpenFoodFacts.', generation);
      return null;
    }).catch(function (e) {
      if (!scanToujoursActif(generation, code)) return null;
      /* Réseau en panne. Un produit déjà connu localement doit continuer à
         marcher : c'est tout l'intérêt de l'avoir gardé. */
      if (connu) {
        ouvrirPortionDepuisScan(connu, generation, code,
          'Hors ligne : ' + connu.n + ' repris de ta base locale.');
        return connu;
      }
      demanderProduit(code, e.message, generation);
      return null;
    });
  }

  function demanderProduit(code, raison, generation) {
    if (generation != null && !scanToujoursActif(generation, code)) return;
    scanBusy = false;
    showBarcodeStatus(escapeHtml(raison));
    var bloc = $('barcode-unknown');
    if (!bloc) return;
    bloc.hidden = false;
    $('bu-name').value = '';
    $('bu-carb').value = '';
    $('bu-pack').value = '';
    requestAnimationFrame(function () {
      if (codeEnCours === code && !bloc.hidden) {
        try { $('bu-name').focus(); } catch (e) {}
      }
    });
  }

  function initUnknownProduct() {
    var save = $('bu-save');
    if (!save) return;
    save.addEventListener('click', function () {
      var nom = ($('bu-name').value || '').trim();
      var carb = parseFloat(($('bu-carb').value || '').replace(',', '.'));
      var pack = parseFloat(($('bu-pack').value || '').replace(',', '.'));
      if (!nom) { toast('Donne un nom au produit.'); return; }
      if (!(carb >= 0 && carb <= 100 && isFinite(carb))) {
        toast('Indique les glucides pour 100 g, entre 0 et 100.');
        return;
      }
      var f = {
        n: nom, brand: '', carb: Math.round(carb * 10) / 10,
        code: codeEnCours || '', serving: null, source: 'perso',
        pack: (pack > 0 && isFinite(pack)) ? {
          total: pack, unitesSuggerees: null, parUniteSuggeree: null,
          labelSuggere: '', unite: 'g', confirme: false
        } : null
      };
      if (codeEnCours && Storage.setProduct) Storage.setProduct(codeEnCours, f, 'perso');
      closeBarcode(false);
      showPortionCard(f);
      toast(nom + ' enregistré : ce code-barres est maintenant reconnu.');
    });
  }

  // Grammes effectifs d'un aliment du repas (portion × quantité, ou grammes directs).
  function itemGrams(it) {
    if (it.mode === 'grams') return it.grams || 0;
    var p = it.portions[it.portionIndex];
    return (p ? p[1] : 0) * (it.qty || 1);
  }

  function manualCalculation() {
    return ManualCalc.calculate(manualItems.map(function (it) {
      return { name: it.name, grams: itemGrams(it), carb: it.carb };
    }));
  }

  function renderChips() {
    var wrap = $('cat-chips');
    wrap.innerHTML = '';
    var cats = Foods.activeCategories();
    // « Récents » en tête si des aliments ont déjà été utilisés.
    if (Storage.getRecentFoods().length) cats = ['⭐ Récents'].concat(cats);
    cats.forEach(function (c) {
      var b = document.createElement('button');
      b.className = 'chip' + (c === currentCat ? ' active' : '');
      b.textContent = c;
      b.addEventListener('click', function () {
        currentCat = c;
        renderChips();
        renderFoodResults($('food-search').value);
      });
      wrap.appendChild(b);
    });
  }

  function renderFoodResults(q) {
    var box = $('food-results');
    var list;
    if (currentCat === '⭐ Récents') {
      var qq = (q || '').toLowerCase();
      list = Storage.getRecentFoods().filter(function (f) {
        return !qq || (f.n || '').toLowerCase().indexOf(qq) !== -1;
      });
    } else {
      list = Foods.search(q, currentCat);
    }
    if (!list.length) {
      box.innerHTML = '<p class="empty">Aucun repère local pour cette recherche.</p>' +
        ((q || '').trim().length >= 2
          ? '<button type="button" class="btn btn-secondary food-online-fallback">Chercher ce produit en ligne</button>'
          : '<p class="hint tiny">Essaie un autre mot ou ajoute un aliment personnalisé.</p>');
      var online = box.querySelector('.food-online-fallback');
      if (online) online.addEventListener('click', function () {
        selectPane('tab-manual', 'produit');
        $('off-search').value = q;
        runOffSearch(q);
      });
      return;
    }
    box.innerHTML = '';
    list.forEach(function (f) {
      var el = document.createElement('div');
      el.className = 'food-item';
      var perso = f.custom ? ' <span class="tag">perso</span>' :
        (f.packaged ? ' <span class="tag">produit connu</span>' : '');
      var approx = f.meta && f.meta.approximate ? '≈ ' : '';
      var del = f.custom ? '<button class="food-del" aria-label="Supprimer">🗑️</button>' : '';
      el.innerHTML =
        '<button type="button" class="food-label">' + escapeHtml(f.n) + perso +
        ' <span class="item-detail">(' + approx + f.carb + ' g/100 g)</span></button>' +
        '<span class="food-actions">' + del + '<button type="button" class="food-add" aria-label="Ajouter ' +
        escapeHtml(f.n) + '">＋</button></span>';
      var choose = function () { if (f.packaged) showPortionCard(f); else addFoodToMeal(f); };
      el.querySelector('.food-label').addEventListener('click', choose);
      el.querySelector('.food-add').addEventListener('click', function (e) { e.stopPropagation(); choose(); });
      if (f.custom) {
        el.querySelector('.food-del').addEventListener('click', function (e) {
          e.stopPropagation();
          Storage.deleteCustomFood(f.id);
          renderChips();
          renderFoodResults($('food-search').value);
          toast('Aliment supprimé.');
        });
      }
      box.appendChild(el);
    });
  }

  function addFoodToMeal(f) {
    var portions = (f.portions && f.portions.length) ? f.portions.slice() : [];
    var itemIndex = manualItems.length;
    var startGrams = Number(f.startGrams);
    if (!isFinite(startGrams) || startGrams < 0) startGrams = 100;
    manualItems.push({
      name: f.n, carb: f.carb, custom: !!f.custom,
      portions: portions,
      mode: portions.length ? 'preset' : 'grams',
      portionIndex: 0,
      // qty vient du calcul de portion (« j'en mange 2 ») ; 1 partout ailleurs.
      qty: (portions.length && f.qty > 0) ? f.qty : 1,
      grams: portions.length ? 0 : startGrams
    });
    Storage.addRecentFood(f); // mémorise pour la catégorie « Récents »
    renderChips();            // fait apparaître/rafraîchir la puce « Récents »
    renderManualItems();
    toast(f.n + ' ajouté.');
    if (f.focusGrams && !portions.length) {
      requestAnimationFrame(function () {
        var input = document.querySelector('.manual-grams[data-i="' + itemIndex + '"]');
        if (!input) return;
        try { input.focus(); input.select(); } catch (e) {}
      });
    }
  }

  function initCustomFoodForm() {
    $('add-custom-toggle').addEventListener('click', function () {
      var f = $('custom-form');
      f.hidden = !f.hidden;
    });
    $('cf-cancel').addEventListener('click', function () { $('custom-form').hidden = true; });
    $('cf-save').addEventListener('click', function () {
      var name = $('cf-name').value.trim();
      var carb = parseFloat(($('cf-carb').value || '').replace(',', '.'));
      var portion = parseFloat($('cf-portion').value);
      if (!name) { toast('Donne un nom à l\'aliment.'); return; }
      if (!(carb >= 0 && carb <= 100 && isFinite(carb))) { toast('Indique les glucides pour 100 g (entre 0 et 100).'); return; }
      var portions = (portion > 0 && isFinite(portion)) ? [['1 portion', Math.round(portion)]] : [];
      Storage.addCustomFood({ n: name, carb: Math.round(carb * 10) / 10, portions: portions });
      $('cf-name').value = ''; $('cf-carb').value = ''; $('cf-portion').value = '';
      $('custom-form').hidden = true;
      currentCat = 'Perso';
      renderChips();
      renderFoodResults('');
      toast('Aliment « ' + name + ' » enregistré.');
    });
  }

  function renderManualItems() {
    var wrap = $('manual-items');
    if (!manualItems.length) {
      wrap.innerHTML = '<p class="empty">Aucun aliment ajouté.</p>';
      $('manual-total').hidden = true;
      $('manual-dock').hidden = true;
      return;
    }
    wrap.innerHTML = '';
    var calculation = manualCalculation();
    manualItems.forEach(function (it, idx) {
      var grams = itemGrams(it);
      var carbs = calculation.rows[idx] ? calculation.rows[idx].carbsG : 0;

      // Sélecteur de portion : chaque mesure courante + « Grammes… »
      var opts = it.portions.map(function (p, i) {
        var sel = (it.mode === 'preset' && it.portionIndex === i) ? ' selected' : '';
        /* fr() et non p[1] brut : depuis le calcul de portion, une portion peut
           valoir 41,67 g. Sans mise en forme on lisait « 41.67 g », avec un
           point, au milieu d'une interface qui écrit partout ailleurs « 41,7 ».
           La valeur exacte reste utilisée pour le calcul — seul l'affichage est
           arrondi, sinon 12 unités ne feraient plus le paquet. */
        return '<option value="' + i + '"' + sel + '>' + escapeHtml(p[0]) + ' (' + fr(p[1]) + ' g)</option>';
      }).join('');
      opts += '<option value="g"' + (it.mode === 'grams' ? ' selected' : '') + '>Grammes…</option>';

      // Contrôle de quantité : stepper (mode portion) ou champ grammes (mode grammes)
      var control;
      if (it.mode === 'grams') {
        control = '<span class="grams-field"><input class="input small manual-grams" type="number" inputmode="decimal" min="0.1" max="' +
                  ManualCalc.MAX_ITEM_GRAMS + '" step="5" value="' + (Math.round(grams * 10) / 10) + '" data-i="' + idx +
                  '" aria-label="Quantité de ' + escapeHtml(it.name) + ' en grammes"> g</span>';
      } else {
        control = '<span class="stepper">' +
                  '<button class="step-btn" data-dec="' + idx + '" aria-label="Diminuer ' + escapeHtml(it.name) + '">−</button>' +
                  '<span class="step-qty">' + (it.qty || 1) + '</span>' +
                  '<button class="step-btn" data-inc="' + idx + '" aria-label="Augmenter ' + escapeHtml(it.name) + '">+</button>' +
                  '</span><span class="grams-eq">= ' + Math.round(grams) + ' g</span>';
      }

      var row = document.createElement('div');
      row.className = 'item-row manual-row';
      row.innerHTML =
        '<div class="item-main">' +
        '  <div class="item-name">' + escapeHtml(it.name) + '</div>' +
        '  <div class="manual-controls">' +
        '    <select class="input small portion-select" data-i="' + idx + '" aria-label="Portion de ' +
             escapeHtml(it.name) + '">' + opts + '</select>' +
        '    ' + control +
        '  </div>' +
        '</div>' +
        '<div class="item-carb">' + carbs + ' g</div>' +
        '<button class="item-remove" data-rm="' + idx + '" aria-label="Retirer">🗑️</button>';
      wrap.appendChild(row);
    });

    // Changement de portion / passage en grammes
    wrap.querySelectorAll('.portion-select').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var it = manualItems[parseInt(sel.dataset.i, 10)];
        if (sel.value === 'g') {
          if (it.mode !== 'grams') it.grams = itemGrams(it); // conserve la valeur courante
          it.mode = 'grams';
        } else {
          it.mode = 'preset';
          it.portionIndex = parseInt(sel.value, 10);
        }
        renderManualItems();
      });
    });
    // Steppers +/−
    wrap.querySelectorAll('[data-inc]').forEach(function (b) {
      b.addEventListener('click', function () {
        var it = manualItems[parseInt(b.dataset.inc, 10)];
        it.qty = (it.qty || 1) + 1;
        renderManualItems();
      });
    });
    wrap.querySelectorAll('[data-dec]').forEach(function (b) {
      b.addEventListener('click', function () {
        var it = manualItems[parseInt(b.dataset.dec, 10)];
        it.qty = Math.max(1, (it.qty || 1) - 1);
        renderManualItems();
      });
    });
    // Saisie directe en grammes
    wrap.querySelectorAll('.manual-grams').forEach(function (inp) {
      inp.addEventListener('change', function () {
        var index = parseInt(inp.dataset.i, 10);
        var grams = ManualCalc.normalizeGrams(inp.value);
        if (grams == null) {
          inp.setAttribute('aria-invalid', 'true');
          toast('Quantité invalide : indique plus de 0 g, jusqu’à ' + ManualCalc.MAX_ITEM_GRAMS + ' g.');
          inp.value = Math.round(itemGrams(manualItems[index]) * 10) / 10;
          return;
        }
        manualItems[index].grams = grams;
        renderManualItems();
      });
    });
    // Retrait d'un aliment
    wrap.querySelectorAll('.item-remove').forEach(function (b) {
      b.addEventListener('click', function () {
        manualItems.splice(parseInt(b.dataset.rm, 10), 1);
        renderManualItems();
      });
    });
    renderManualTotal();
  }

  function renderManualTotal() {
    var calculation = manualCalculation();
    var total = calculation.totalCarbsG;
    var parts = partsFrom(total);
    // La charge glycémique du mode manuel sort entièrement de la table locale :
    // aucun appel réseau, donc elle fonctionne aussi hors ligne.
    var giInfo = GI.meal(calculation.rows.map(function (row) {
      return { name: row.name, carbsG: row.carbsG };
    }));
    var el = $('manual-total');
    var blocked = !calculation.ok;
    var errorHtml = blocked
      ? '<div class="manual-blocked" role="alert"><strong>Calcul bloqué</strong><ul>' +
        calculation.errors.map(function (msg) { return '<li>' + escapeHtml(msg) + '</li>'; }).join('') +
        '</ul></div>'
      : '';
    el.innerHTML =
      '<div class="result-hero' + (blocked ? ' manual-result-blocked' : '') + '">' +
      '  <div class="hero-carbs">' + (blocked ? '—' : total + ' <small>g</small>') + '</div>' +
      '  <div class="hero-parts">' + (blocked ? 'Corrige les quantités' : fr(parts) + ' <small>parts de glucides</small>') + '</div>' +
      errorHtml +
      (blocked ? '' : '  <div class="pump-hint">💉 <strong>Total calculé</strong> : <strong>' + total + ' g</strong> (soit <strong>' + fr(parts) + ' parts</strong>). Vérifie avant de saisir.</div>') +
      (blocked ? '' : giHtml({ gi: giInfo })) +
      '  <div class="btn-row" style="margin-top:12px">' +
      '    <button id="save-manual" class="btn btn-primary"' + (blocked ? ' disabled' : '') + '>💾 Enregistrer</button>' +
      '    <button id="save-manual-meal" class="btn btn-ghost"' + (blocked ? ' disabled' : '') + '>⭐ Repas fréquent</button>' +
      '  </div>' +
      '</div>';
    el.hidden = false;
    $('manual-dock-total').textContent = blocked ? 'Quantités à corriger' : total + ' g · ' + fr(parts) + ' parts';
    $('manual-dock').hidden = false;
    if (blocked) return;
    $('save-manual-meal').addEventListener('click', function () {
      promptSaveMeal(calculation.rows.map(function (row) {
        return { name: row.name, carbsG: row.carbsG };
      }));
    });
    $('save-manual').addEventListener('click', function () {
      var saveButton = $('save-manual');
      if (!saveButton || saveButton.disabled) return;
      saveButton.disabled = true;
      var entry = {
        date: Date.now(), source: 'manuel', draft: false, confirmed: true,
        blocked: false, dominantRequired: false, dominantConfirmed: true,
        totalCarbsG: total,
        parts: parts, partSizeG: settings.partSizeG,
        gi: giInfo ? { gl: giInfo.gl, gi: giInfo.gi } : null,
        items: calculation.rows.map(function (row) {
          return {
            name: row.name,
            carbsG: row.carbsG,
            portion: fr(row.grams) + ' g'
          };
        })
      };
      if (!Storage.addHistory(entry)) {
        saveButton.disabled = false;
        toast('Repas non enregistré : stockage indisponible.');
        return;
      }
      saveButton.textContent = '✓ Enregistré';
      toast('Enregistré dans l\'historique.');
      // Un repas saisi à la main mérite le même rappel qu'un repas photographié.
      // Faute de vitesse d'absorption estimée par l'IA, le délai reste le défaut.
      scheduleReminderFor(entry);
    });
  }

  // ---------- Historique ----------
  /* Repas dépliés. Conservé hors du rendu pour qu'un rafraîchissement (saisie
     d'une valeur réelle, suppression) ne referme pas ce que l'on consultait. */
  var openMeals = {};

  function mealDetailHtml(e) {
    var out = '';

    if (historyImg(e)) {
      out += '<img class="detail-photo" src="' + historyImg(e) + '" alt="photo du repas">';
    }
    if (e.seen) {
      out += '<p class="detail-seen">« ' + escapeHtml(e.seen) + ' »</p>';
    }

    var vus = (e.items || []).filter(function (it) { return !it.added; });
    var ajoutes = (e.items || []).filter(function (it) { return it.added; });
    var ligne = function (it) {
      return '<li>' +
        '<span class="detail-food">' + escapeHtml(it.name) +
          (it.portion ? ' <em>' + escapeHtml(it.portion) + '</em>' : '') + '</span>' +
        '<span class="detail-carb">' + (it.carbsG > 0 ? it.carbsG + ' g' : '—') + '</span>' +
        '</li>';
    };
    if (vus.length) out += '<ul class="detail-foods">' + vus.map(ligne).join('') + '</ul>';
    if (ajoutes.length) {
      out += '<div class="detail-label">Ajouté par toi</div>' +
             '<ul class="detail-foods">' + ajoutes.map(ligne).join('') + '</ul>';
    }
    if (Array.isArray(e.opinions) && e.opinions.length > 1) {
      out += '<div class="detail-label">Avis comparés à l’origine</div>' +
        '<ul class="detail-foods detail-opinions">' + e.opinions.slice(0, 3).map(function (opinion) {
          var model = String(opinion.model || opinion.provider || 'modèle').split('/').pop();
          return '<li><span class="detail-food">' + escapeHtml(model) + '</span>' +
            '<span class="detail-carb">' + (opinion.ok && opinion.totalCarbsG != null
              ? Math.round(opinion.totalCarbsG) + ' g' : 'indisponible') + '</span></li>';
        }).join('') + '</ul>';
    }

    if (!(e.items || []).length) {
      out += '<p class="detail-none">Le détail des aliments n\'a pas été enregistré ' +
             'pour ce repas.</p>';
    } else if (!e.seen && !(e.items || []).some(function (it) { return it.portion; })) {
      /* Repas d'avant la v33 : la phrase de lecture et les portions n'étaient
         pas conservées. On l'explique, sinon l'écart de richesse entre deux
         repas de l'historique passe pour un bug. */
      out += '<p class="detail-none">Repas enregistré avant la mise à jour : les ' +
             'portions et la description n\'avaient pas encore été conservées.</p>';
    }

    var tags = [];
    if (e.gi && e.gi.gl != null) {
      tags.push('<span class="detail-tag">Charge glycémique ' + e.gi.gl +
        ' · ' + GI.glBand(e.gi.gl).label + '</span>');
    }
    if (e.glycemicSpeed && GLYCEMIC[e.glycemicSpeed]) {
      tags.push('<span class="detail-tag">' + GLYCEMIC[e.glycemicSpeed].icon + ' ' +
        GLYCEMIC[e.glycemicSpeed].label + '</span>');
    }
    if (tags.length) out += '<div class="detail-tags">' + tags.join('') + '</div>';

    if (e.draft) {
      out += '<div class="draft-note">Sauvegardé automatiquement. Confirme ce repas pour ' +
        'l\'inclure dans tes synthèses.</div>';
      if (e.choiceRequired) {
        out += '<div class="cmp-warn">⚠️ <strong>Comparaison non tranchée.</strong> ' +
          'Aucun modèle n’a encore été retenu : retourne dans Analyser et choisis une colonne. ' +
          'Ce brouillon ne peut pas être confirmé tel quel.</div>';
      } else if (e.resultSnapshot) {
        out += '<button class="btn btn-secondary history-resume" data-resume="' + e.date +
          '">↩ Reprendre et corriger</button>';
      }
      if (e.choiceRequired) {
        /* Le premier avis n'est qu'un support de sauvegarde : pas de raccourci
           Confirmer tant que l'utilisateur n'a pas réellement choisi. */
      } else if (e.blocked) {
        out += '<p class="hint tiny">⛔ Ce brouillon est incohérent : reprends-le pour le corriger.</p>';
      } else if (e.dominantRequired && !e.dominantConfirmed) {
        out += '<p class="hint tiny">🔎 Confirme d’abord l’aliment principal dans le résultat.</p>';
      } else {
        out += '<button class="btn btn-primary history-confirm" data-confirm="' + e.date +
          '">✓ Confirmer ce repas</button>';
      }
    }

    out += '<div class="history-real-line" data-line="' + e.date + '" hidden></div>' +
      '<div class="history-real">' +
      '  <label>Glucides réels</label>' +
      '  <input class="input small real-input" type="number" inputmode="numeric" min="0" step="1" ' +
      '         placeholder="g" value="' + (e.realCarbsG != null ? e.realCarbsG : '') +
      '" data-real="' + e.date + '">' +
      '  <span class="real-unit">g</span>' +
      '</div>' +
      /* La source qualifie la valeur : une pesée arbitre, une estimation à
         l'oeil non. Sans ce champ, l'app calibrait le modèle avec du bruit. */
      '<div class="real-source">' +
      '  <label for="src-' + e.date + '">Source de cette valeur</label>' +
      '  <select id="src-' + e.date + '" class="input real-source-sel" data-src="' + e.date + '">' +
        (Storage.REAL_SOURCES || []).map(function (o) {
          var sel = (e.realSource || 'estimation') === o.id ? ' selected' : '';
          return '<option value="' + o.id + '"' + sel + '>' + escapeHtml(o.label) + '</option>';
        }).join('') +
      '  </select>' +
      '  <p class="hint tiny">Seules une pesée, une étiquette ou une recette calculée servent à calibrer le modèle.</p>' +
      '</div>' +
      '<button class="btn btn-ghost history-del" data-del="' + e.date + '">🗑️ Supprimer ce repas</button>';
    return out;
  }

  /* Filtre du journal. Avec 500 repas conservés, retrouver « le couscous de la
     semaine dernière » était impossible. On cherche dans les noms d'aliments et
     dans la phrase de lecture, pas dans les dates : c'est le plat qu'on a en
     tête, pas la date. */
  var historyFilter = '';

  function matchesFilter(e) {
    if (!historyFilter) return true;
    var q = historyFilter;
    var hay = ((e.items || []).map(function (it) { return it.name; }).join(' ') + ' ' +
               (e.seen || '')).toLowerCase();
    return hay.indexOf(q) !== -1;
  }

  function resumeHistoryDraft(date) {
    var e = Storage.getHistory().filter(function (x) { return x.date === date; })[0];
    if (e && e.choiceRequired) {
      toast('Ce brouillon attend encore ton choix dans les colonnes de comparaison.');
      return;
    }
    if (!e || !e.draft || !e.resultSnapshot || !Array.isArray(e.resultSnapshot.items)) {
      toast('Ce brouillon ancien ne contient pas assez de données pour être repris.');
      return;
    }
    var snapshot;
    try { snapshot = JSON.parse(JSON.stringify(e.resultSnapshot)); }
    catch (err) { toast('Brouillon illisible.'); return; }
    var ctx = safePendingContext(e.input, e.source === 'photo' ? 1 : 0);
    try { lastResult = Estimator.sanitize(snapshot, ctx); }
    catch (err2) { toast('Brouillon invalide : impossible de le reprendre.'); return; }

    /* Une reprise change de repas. Rien de l'écran précédent ne doit survivre :
       ni une réponse IA encore en vol, ni surtout l'archive de ses colonnes.
       Sinon le brouillon B proposait « Revoir les colonnes d'origine » du
       repas A et un clic suffisait à remplacer silencieusement B par A. Les
       opinions compactes de l'historique restent consultables dans son détail,
       mais elles n'ont plus la fourchette/confiance nécessaires pour recréer
       honnêtement le tableau complet. */
    ++estimateGeneration;
    estimateBusy = false;
    updateEstimateBtn();
    lastCompare = null;
    lastComparisonArchive = null;
    lastCompareRun = null;
    oublierEnCours();

    lastResult.provider = (Storage.PROVIDERS || []).indexOf(e.provider) >= 0 ? e.provider : '';
    lastResult.model = typeof e.model === 'string' ? e.model.slice(0, 200) : '';
    var restoredVerification = e.verification ? {
      provider: e.verification.provider,
      model: e.verification.model || '',
      ok: !!e.verification.ok,
      total: e.verification.totalCarbsG,
      items: e.verification.items || [],
      error: e.verification.error || '',
      checkedAt: e.verification.checkedAt
    } : null;

    /* Le snapshot normalisé repart volontairement de la somme de ses aliments.
       Une moyenne de deux modèles n'est restaurée que si toutes ses traces
       indépendantes concordent encore : entrée, snapshot, second avis et paire
       de modèles/aliments autorisée. Sinon on l'abandonne explicitement. */
    var fusionDropped = false;
    if (Array.isArray(e.mergedFrom)) {
      var restoredMerge = Storage.validateStoredMerge
        ? Storage.validateStoredMerge(e, snapshot, lastResult, restoredVerification)
        : null;
      if (restoredMerge && mergePairValidated(lastResult, restoredVerification) &&
          Estimator.mergeAllowed(restoredMerge.primaryTotal, restoredMerge.verifyTotal,
            settings.verifyThresholdPct || 20, MAX_ECART_FUSION_G)) {
        lastResult.mergedTotalCarbsG = restoredMerge.mergedTotal;
        lastResult.verifyTotalCarbsG = restoredMerge.verifyTotal;
        lastResult.rangeLowG = Math.min(lastResult.rangeLowG, restoredMerge.verifyTotal);
        lastResult.rangeHighG = Math.max(lastResult.rangeHighG, restoredMerge.verifyTotal);
      } else {
        fusionDropped = true;
      }
    }
    /* Un blocage brut (total/fourchette incohérents dans la réponse initiale)
       ne doit pas disparaître au simple fait de recharger la WebView. Une
       correction explicite appellera ensuite recomputeTotal et le lèvera. */
    if (e.blocked) {
      var prior = Array.isArray(snapshot.blocking) ? snapshot.blocking : e.blocking;
      prior = (Array.isArray(prior) ? prior : ['Ce brouillon avait été refusé avant son enregistrement.'])
        .filter(function (m) { return typeof m === 'string' && m; }).slice(0, 10);
      prior = (lastResult.sourceBlocking || []).concat(prior)
        .filter(function (m, i, a) { return a.indexOf(m) === i; });
      lastResult.sourceBlocking = prior;
      Estimator.refresh(lastResult);
    }
    currentHistoryDate = e.date;
    currentHistoryConfirmed = false;
    currentChoiceRequired = false;
    currentHistoryPhotoStarted = true;
    currentDominantConfirmed = !!e.dominantConfirmed;
    lastResult.dominantConfirmed = currentDominantConfirmed;
    lastEstimateContext = ctx;
    clarificationRepondue = ctx.clarificationAnswered === true;
    lastVerification = restoredVerification;
    images = [];
    lastEstimateImages = [];
    resumedPhotoDraft = ctx.imageCount > 0;
    lastRunProvider = e.provider || null;
    lastRunModel = e.model || null;
    setMode(e.source === 'texte' ? 'texte' : 'photo');
    if (e.source === 'texte' && ctx.notes) $('user-notes').value = ctx.notes;
    renderThumbs();
    renderDepthResult(depthForContextDisplay(ctx));
    selectTab('analyze');
    renderResults(lastResult);
    toast(fusionDropped
      ? 'Brouillon repris : l’ancienne moyenne n’était plus vérifiable, le total du modèle principal est affiché. Relis avant de confirmer.'
      : 'Brouillon repris. Relis, corrige puis confirme.');
  }

  function initHistorySearch() {
    var inp = $('history-search');
    if (!inp) return;
    inp.addEventListener('input', function () {
      historyFilter = inp.value.trim().toLowerCase();
      renderHistory();
    });
  }

  function renderHistory() {
    renderBiasCard();
    var list = $('history-list');
    var tous = Storage.getHistory();
    // Le champ de filtre n'apparaît que quand la liste devient longue : sur cinq
    // repas il n'apporte rien et occupe de la place.
    var wrap = $('history-search-wrap');
    if (wrap) wrap.hidden = tous.length < 8;

    if (!tous.length) {
      list.innerHTML = '<p class="empty">Aucune estimation enregistrée.</p>';
      $('clear-history').hidden = true;
      return;
    }
    var h = tous.filter(matchesFilter);
    if (!h.length) {
      list.innerHTML = '<p class="empty">Aucun repas ne contient « ' +
        escapeHtml(historyFilter) + ' ».</p>';
      $('clear-history').hidden = false;
      return;
    }
    list.innerHTML = '';

    var confirmed = h.filter(function (e) {
      return Storage.isConfirmedMeal ? Storage.isConfirmedMeal(e) : !e.draft;
    });
    var draftCount = h.length - confirmed.length;
    var summary = document.createElement('div');
    summary.className = 'history-summary';
    var summaryBits = [
      h.length + ' repas enregistré' + (h.length > 1 ? 's' : '')
    ];
    if (draftCount) {
      summaryBits.push(draftCount + ' brouillon' + (draftCount > 1 ? 's' : ''));
    }
    if (confirmed.length) {
      var avgParts = confirmed.reduce(function (s, e) {
        return s + partsFromStored(e);
      }, 0) / confirmed.length;
      summaryBits.push('moyenne <strong>' + fr(avgParts) + ' parts</strong>');
    }
    summary.innerHTML = summaryBits.join(' · ');
    list.appendChild(summary);

    h.forEach(function (e) {
      var d = new Date(e.date);
      var dateStr = d.toLocaleDateString('fr-FR') + ' ' +
        d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      var open = !!openMeals[e.date];

      var item = document.createElement('div');
      item.className = 'history-item' + (open ? ' open' : '');

      /* Ligne repliée : uniquement ce qu'on lit d'un coup d'œil en parcourant
         la liste. Le reste (aliments, photo, charge, valeur réelle) est dans le
         détail — sinon quelques dizaines de repas deviennent illisibles. */
      var resume =
        '<button class="history-head" data-open="' + e.date + '" aria-expanded="' + open + '">' +
          (historyImg(e)
            ? '<img class="history-thumb" src="' + historyImg(e) + '" alt="">'
            : '<span class="history-noimg">' + (e.source === 'photo' ? '📷' : '✍️') + '</span>') +
          '<span class="history-lines">' +
            '<span class="history-date">' + dateStr + ' · ' +
              (HISTORY_SOURCE[e.source] || HISTORY_SOURCE.manuel) + '</span>' +
            '<span class="history-total"><b>' + fr(partsFromStored(e)) + ' parts</b> · ' +
              e.totalCarbsG + ' g' +
              (e.draft ? ' <span class="history-draft-tag">brouillon</span>' : '') +
              (e.realCarbsG != null ? ' <span class="history-real-tag">réel ' + e.realCarbsG + ' g</span>' : '') +
            '</span>' +
          '</span>' +
          '<span class="history-chev">' + (open ? '▲' : '▼') + '</span>' +
        '</button>';

      item.innerHTML = resume +
        '<div class="history-detail"' + (open ? '' : ' hidden') + '>' +
          (open ? mealDetailHtml(e) : '') + '</div>';
      list.appendChild(item);
      if (open) updateRealLine(e.date, e.totalCarbsG, e.realCarbsG);
    });

    list.querySelectorAll('[data-open]').forEach(function (b) {
      b.addEventListener('click', function () {
        var date = Number(b.dataset.open);
        // Un seul repas ouvert à la fois : la liste reste parcourable.
        var etait = openMeals[date];
        openMeals = {};
        if (!etait) openMeals[date] = true;
        renderHistory();
      });
    });

    list.querySelectorAll('.history-del').forEach(function (b) {
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var deletedDate = Number(b.dataset.del);
        if (!Storage.deleteHistory(deletedDate)) {
          toast('Suppression non enregistrée : stockage indisponible.');
          return;
        }
        if (Native.isApp) Native.notify.cancel(Math.floor(deletedDate / 1000));
        delete openMeals[deletedDate];
        renderHistory();
      });
    });

    list.querySelectorAll('.history-resume').forEach(function (b) {
      b.addEventListener('click', function () {
        resumeHistoryDraft(Number(b.dataset.resume));
      });
    });

    list.querySelectorAll('.history-confirm').forEach(function (b) {
      b.addEventListener('click', function () {
        var date = Number(b.dataset.confirm);
        var entry = Storage.getHistory().filter(function (x) { return x.date === date; })[0];
        if (!entry || entry.choiceRequired || entry.blocked ||
            (entry.dominantRequired && !entry.dominantConfirmed)) {
          toast('Reprends ce brouillon et termine ses vérifications avant de le confirmer.');
          return;
        }
        var saved = Storage.updateHistory(date, { draft: false, confirmed: true });
        var confirmed = saved && saved.some(function (e) {
          return e.date === date && e.draft === false;
        });
        if (!confirmed) {
          toast('Confirmation non enregistrée : stockage indisponible.');
          return;
        }
        scheduleReminderFor(Object.assign({}, entry, { draft: false, confirmed: true }));
        renderHistory();
        toast('Repas confirmé.');
      });
    });

    /* Saisie du réel. On met à jour UNIQUEMENT la ligne concernée et la carte de
       biais : re-rendre toute la liste ferait perdre la saisie en cours (le
       'change' se déclenche au moment où l'on quitte le champ). */
    list.querySelectorAll('.real-source-sel').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var date = Number(sel.dataset.src);
        var entry = Storage.getHistory().filter(function (x) { return x.date === date; })[0];
        if (!entry || entry.realCarbsG == null) {
          toast('Saisis d\'abord les glucides réels.');
          return;
        }
        if (!Storage.setHistoryReal(date, entry.realCarbsG, sel.value)) {
          toast('Source non enregistrée : stockage indisponible.');
          return;
        }
        refreshBiasCard();
        toast(sel.value === 'estimation'
          ? 'Marqué comme estimation : ne sert plus à calibrer.'
          : 'Source enregistrée — cette valeur calibre le modèle.');
      });
    });

    list.querySelectorAll('.real-input').forEach(function (inp) {
      var commit = function (announce) {
        var date = Number(inp.dataset.real);
        var v = inp.value.trim();
        var real = v === '' ? null : parseFloat(v);
        if (real != null && (!isFinite(real) || real < 0)) return;
        if (!Storage.setHistoryReal(date, real)) {
          if (announce) toast('Valeur non enregistrée : stockage indisponible.');
          return;
        }
        var entry = Storage.getHistory().filter(function (x) { return x.date === date; })[0];
        if (entry) updateRealLine(date, entry.totalCarbsG, entry.realCarbsG);
        refreshBiasCard();
        if (announce) toast(real == null ? 'Valeur réelle effacée.' : 'Réel enregistré — l\'app apprend ton biais.');
      };
      inp.addEventListener('input', function () {
        clearTimeout(inp._t);
        inp._t = setTimeout(function () { commit(false); }, 600);
      });
      inp.addEventListener('change', function () {
        clearTimeout(inp._t);
        var showedDraft = !!inp.closest('.history-item').querySelector('.history-draft-tag');
        commit(true);
        var date = Number(inp.dataset.real);
        var entry = Storage.getHistory().filter(function (x) { return x.date === date; })[0];
        if (showedDraft && entry && !entry.draft) renderHistory();
      });
    });
    $('clear-history').hidden = false;
  }

  function updateRealLine(date, estG, realG) {
    var el = document.querySelector('[data-line="' + date + '"]');
    if (!el) return;
    if (realG == null) { el.hidden = true; el.textContent = ''; return; }
    var delta = realG - estG;
    var sign = delta > 0 ? '+' : '';
    el.className = 'history-real-line ' + (Math.abs(delta) <= 5 ? 'ok' : 'off');
    el.innerHTML = 'Réel : <strong>' + realG + ' g</strong> (' + sign + delta + ' g vs estimation)';
    el.hidden = false;
  }

  // Remplace la carte de biais sans toucher au reste de la liste.
  /* La carte d'apprentissage vit dans le volet « Analyse ». Elle est rendue là
     plutôt qu'en tête du journal : on ne veut pas faire défiler des centaines de
     repas pour la retrouver, ni la relire à chaque consultation du journal. */
  function renderBiasCard() {
    var slot = $('bias-slot');
    if (!slot) return;
    slot.innerHTML = '';
    slot.appendChild(buildBiasCard());
  }

  function refreshBiasCard() {
    renderBiasCard();
  }

  // Carte « apprentissage » : montre la tendance personnelle (sous/sur-estimation).
  function buildBiasCard() {
    var bias = Storage.getBias();
    var card = document.createElement('div');
    card.className = 'bias-card';
    if (bias.count < 3) {
      var left = 3 - bias.count;
      card.innerHTML = '<div class="bias-title">🎯 Apprentissage</div>' +
        '<div class="bias-text">Saisis les <strong>glucides réels</strong> sous chaque repas (étiquette, pesée, ' +
        'ou ton comptage vérifié). Encore <strong>' + left + '</strong> repas' + (left > 1 ? '' : '') +
        ' pour calculer ta tendance personnelle.</div>';
      return card;
    }
    var pct = bias.pct;
    var abs = Math.abs(pct);
    var verdict, cls;
    if (abs < 5) {
      verdict = 'Aucun <strong>biais directionnel net</strong> n’est détecté (&lt; 5 %). ' +
        'Cela ne mesure pas la précision repas par repas : continue à vérifier chaque estimation.';
      cls = 'good';
    } else if (pct > 0) {
      verdict = 'Tu as tendance à <strong>SOUS-estimer d\'environ ' + abs + ' %</strong>. ' +
        'Sur une estimation à 60 g, le réel tourne plutôt autour de ' + Math.round(60 * bias.meanRatio) + ' g.';
      cls = 'warn';
    } else {
      verdict = 'Tu as tendance à <strong>SUR-estimer d\'environ ' + abs + ' %</strong>. ' +
        'Sur une estimation à 60 g, le réel tourne plutôt autour de ' + Math.round(60 * bias.meanRatio) + ' g.';
      cls = 'warn';
    }
    card.className = 'bias-card ' + cls;
    card.innerHTML = '<div class="bias-title">🎯 Ta tendance personnelle</div>' +
      '<div class="bias-text">' + verdict + '</div>' +
      byCategoryHtml() +
      '<div class="bias-meta">Calculé sur ' + bias.count + ' repas avec valeur réelle. ' +
      'Indicatif — ne remplace pas ton jugement.</div>';
    return card;
  }

  /* Détail par catégorie : bien plus actionnable qu'une moyenne globale.
     N'apparaît qu'à partir de 3 repas corrigés dans une même catégorie. */
  function byCategoryHtml() {
    var groups = Storage.getBiasByCategory(3);
    if (!groups.length) return '';
    var rows = groups.slice(0, 4).map(function (g) {
      var pct = Math.abs(g.pct);
      var verdict = pct < 5 ? '<span class="cat-ok">sans biais net</span>'
        : (g.pct > 0 ? 'sous-estimé de <b>' + pct + ' %</b>' : 'sur-estimé de <b>' + pct + ' %</b>');
      return '<li><span class="cat-name">' + escapeHtml(g.category) + '</span> ' + verdict +
             ' <span class="cat-count">(' + g.count + ' repas)</span></li>';
    }).join('');
    return '<ul class="bias-cats">' + rows + '</ul>';
  }
  // Un ancien repas garde la taille de part utilisée le jour de son calcul.
  function partsFromStored(e) {
    var savedSize = Number(e && e.partSizeG);
    if (isFinite(savedSize) && savedSize >= 5 && savedSize <= 20) {
      return e.totalCarbsG / savedSize;
    }
    var savedParts = Number(e && e.parts);
    return isFinite(savedParts) && savedParts >= 0 ? savedParts : partsFrom(e.totalCarbsG);
  }

  function initHistory() {
    $('clear-history').addEventListener('click', function () {
      if (!confirm('Vider tout l\'historique ?')) return;
      var reminderIds = Storage.getHistory().map(function (entry) {
        return Math.floor(entry.date / 1000);
      });
      if (!Storage.clearHistory()) {
        toast('Historique non effacé : stockage indisponible.');
        return;
      }
      if (Native.isApp) reminderIds.forEach(function (id) { Native.notify.cancel(id); });
      renderHistory();
    });
    // La synthèse médecin vivait dans les Réglages, où personne ne la cherchait.
    initReport();
    initBench();
    initHistorySearch();
    // Le volet Analyse est recalculé à l'ouverture : le biais bouge à chaque
    // valeur réelle saisie dans le journal.
    initPanes('tab-history', function (pane) {
      if (pane === 'analyse') { renderBiasCard(); renderBench(); }
    });
    initPanes('tab-manual');
  }

  // ---------- Réglages ----------
  var PROVIDER_NAME = { claude: 'Claude', gemini: 'Gemini', openai: 'ChatGPT', openrouter: 'OpenRouter' };
  var KEY_FIELD = { claude: 'set-key-claude', gemini: 'set-key-gemini',
                    openai: 'set-key-openai', openrouter: 'set-key-openrouter' };
  var CUSTOM_VALUE = '__custom__';

  function initSettings() {
    $('open-settings').addEventListener('click', openSettings);
    $('close-settings').addEventListener('click', function () { hideModal('settings-modal'); });
    $('save-settings').addEventListener('click', saveSettingsFromForm);
    $('clear-key').addEventListener('click', function () {
      var field = KEY_FIELD[$('set-provider').value];
      if (field) $(field).value = '';
      toast('Clé du fournisseur actif vidée — clique Enregistrer pour valider.');
    });
    $('set-provider').addEventListener('change', function () {
      var p = $('set-provider').value;
      var models = settings.models || {};
      populateModelSelect(p, models[p] || Storage.DEFAULT_MODELS[p] || '');
      updateVerificationSettingsForm();
      updateSettingsSummaries();
    });
    // Bascule vers le champ « modèle personnalisé » quand on choisit « Autre modèle… ».
    $('set-model').addEventListener('change', function () {
      $('set-model-custom-wrap').hidden = $('set-model').value !== CUSTOM_VALUE;
    });
    $('set-merge').addEventListener('change', updateSettingsSummaries);
    $('set-verify-mode').addEventListener('change', function () {
      updateVerificationSettingsForm();
      updateSettingsSummaries();
    });
    $('set-verify-provider').addEventListener('change', function () {
      var cp = $('set-verify-provider').value;
      var models = settings.models || {};
      populateVerifyModelSelect(cp, models[cp] || Storage.DEFAULT_MODELS[cp] || '');
      updateSettingsSummaries();
    });
    $('set-verify-model').addEventListener('change', function () {
      $('set-verify-model-custom-wrap').hidden = $('set-verify-model').value !== CUSTOM_VALUE;
    });
    initUpdateCheck();
    initApkCheck();
    var purge = $('purge-photos');
    if (purge) {
      purge.addEventListener('click', function () {
        if (!confirm('Supprimer toutes les photos de l\'historique ?\n\nLes repas et leurs estimations sont conservés.')) return;
        var h = Storage.getHistory();
        h.forEach(function (e) { delete e.photo; delete e.thumb; });
        var saved = Storage.replaceHistory(h);
        if (!saved) {
          toast('Photos non supprimées : impossible d\'enregistrer l\'historique.');
          return;
        }
        Storage.prunePhotos(saved).then(function () {
          refreshStorageUsage();
          renderHistory();
          toast('Photos supprimées.');
        }).catch(function (err) {
          refreshStorageUsage();
          renderHistory();
          toast('Repas conservés, mais certaines photos n’ont pas pu être supprimées : ' +
            ((err && err.message) || 'stockage indisponible') + '. Réessaie après redémarrage.');
        });
      });
    }
    initBackup();
  }

  /* ---------- Écriture d'un fichier vers l'extérieur ----------

     Quatre chemins, parce qu'aucun n'existe partout, et surtout parce que le
     mobile et le bureau n'ont pas la même API pour la même intention :

     1. APK → feuille de partage Android (Fichiers, Drive, mail…). Sans elle,
        l'ancre <a download> d'une WebView écrit dans un dossier interne que le
        gestionnaire de fichiers ne montre pas : le fichier existe, mais reste
        introuvable.
     2. Bureau → showSaveFilePicker, vraie boîte « Enregistrer sous ». L'API
        n'existe QUE sur les navigateurs de bureau : sur Chrome Android elle est
        absente, ce qui faisait retomber la PWA du téléphone sur un
        téléchargement silencieux — sans invite, exactement le symptôme d'origine.
     3. Mobile → partage Web avec fichier. C'est l'équivalent mobile du point 2 :
        la feuille de partage d'Android propose « Enregistrer dans Fichiers ».
     4. Repli <a download>.

     Les points 2 et 3 doivent être déclenchés DANS le geste utilisateur, d'où
     l'absence de toute attente avant l'appel. */
  /* Renseignés par saveTextFile pour que le message final puisse nommer
     l'endroit réellement utilisé, ou l'erreur rencontrée. */
  var lastSavePath = '';
  var lastSaveError = '';

  function saveTextFile(name, content, mime, title) {
    lastSavePath = '';
    lastSaveError = '';
    function fallback() {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([content], { type: mime }));
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 30000);
      return Promise.resolve('telecharge');
    }

    /* Partage Web : seulement si le navigateur accepte CE fichier. canShare()
       sans argument répondrait oui pour du texte seul, et share() échouerait
       ensuite sur la pièce jointe. */
    function webShare() {
      if (typeof File !== 'function' || !navigator.share || !navigator.canShare) return null;
      var file;
      try {
        file = new File([content], name, { type: mime });
      } catch (e) { return null; }
      if (!navigator.canShare({ files: [file] })) return null;
      return navigator.share({ files: [file], title: title || name })
        .then(function () { return 'partage'; })
        .catch(function (err) {
          if (err && err.name === 'AbortError') return 'annule';
          return fallback();
        });
    }

    if (Native.isApp) {
      return Native.shareFile(name, content, title).then(function (r) {
        if (r && r.ok) return r.cancelled ? 'annule' : 'partage';
        /* La feuille de partage a échoué. Plutôt que de laisser le bouton sans
           effet, on écrit le fichier dans un dossier visible et on dit lequel,
           en gardant l'erreur d'origine pour qu'elle soit rapportable. */
        lastSaveError = (r && r.error) || '';
        return Native.saveToDocuments(name, content).then(function (saved) {
          if (!saved) return fallback();
          lastSavePath = saved.uri || '';
          return 'documents';
        });
      });
    }

    if (typeof window.showSaveFilePicker === 'function') {
      var ext = (name.split('.').pop() || 'json');
      return window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: title || name, accept: (function (o) { o[mime] = ['.' + ext]; return o; })({}) }]
      }).then(function (handle) {
        return handle.createWritable();
      }).then(function (w) {
        return w.write(content).then(function () { return w.close(); });
      }).then(function () { return 'enregistre'; })
        .catch(function (err) {
          // Annulation : l'utilisateur a fermé la boîte, il ne s'est rien passé.
          if (err && (err.name === 'AbortError' || /abort/i.test(err.message || ''))) return 'annule';
          return fallback();
        });
    }

    return webShare() || fallback();
  }

  // ---------- Sauvegarde / restauration ----------
  function finishRestore(restored, afterUi) {
    settings = Storage.getSettings();
    renderSavedMeals();
    renderHistory();
    renderChips();
    renderFoodResults($('food-search').value);
    updateCompareToggle();
    if (typeof afterUi === 'function') afterUi();
    hideModal('settings-modal');
    var ok = 'Sauvegarde restaurée (' + restored.length + ' catégories).';
    if (!Native.isApp) { toast(ok); return Promise.resolve(); }
    /* Le format JSON ne contient pas les photos originales : après un vrai
       remplacement, les anciens fichiers sont orphelins et doivent partir. */
    return Storage.prunePhotos().then(function () {
      refreshStorageUsage();
      toast(ok);
    }).catch(function (err) {
      refreshStorageUsage();
      toast(ok + ' Anciennes photos non nettoyées : ' +
        ((err && err.message) || 'stockage indisponible') + '.');
    });
  }

  function initBackup() {
    $('export-data').addEventListener('click', function () {
      var payload = Storage.exportAll();
      var d = new Date();
      var stamp = d.getFullYear() + '-' +
                  ('0' + (d.getMonth() + 1)).slice(-2) + '-' +
                  ('0' + d.getDate()).slice(-2);
      var name = 'glucovision-sauvegarde-' + stamp + '.json';

      saveTextFile(name, JSON.stringify(payload, null, 2), 'application/json',
                   'Sauvegarde GlucoVision').then(function (mode) {
        if (mode === 'annule') return;
        // Les trois chemins résolvent APRÈS le choix de l'utilisateur : le
        // message doit donc constater, pas donner une consigne déjà exécutée.
        var ou = mode === 'partage' ? 'Envoyée à la destination choisie.'
               : mode === 'enregistre' ? 'Enregistrée à l\'emplacement choisi.'
               : mode === 'documents' ? 'Partage indisponible' +
                   (lastSaveError ? ' (' + lastSaveError + ')' : '') +
                   ' — fichier écrit ici : ' + lastSavePath
               : 'Téléchargée dans le dossier de téléchargements.';
        toast('Sauvegarde exportée sans clé API. ' + ou);
      });
    });

    $('import-data').addEventListener('click', function (e) {
      // Restauration destructive : on demande confirmation AVANT d'ouvrir le sélecteur.
      if (!confirm('Restaurer une sauvegarde remplacera ton historique, tes aliments perso et ta calibration actuels. Continuer ?')) {
        e.preventDefault();
      }
    });

    $('import-data').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) {
        toast('Sauvegarde trop volumineuse (maximum 10 Mo).');
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        var parsed;
        try {
          parsed = JSON.parse(reader.result);
        } catch (err) {
          toast(err.message || 'Fichier illisible.');
          return;
        }
        Storage.importAll(parsed).then(function (restored) {
          return finishRestore(restored);
        }).catch(function (err) {
          toast(err.message || 'Fichier illisible.');
        });
      };
      reader.onerror = function () { toast('Impossible de lire le fichier.'); };
      reader.readAsText(file);
    });

    initTextBackup();
  }

  /* ---------- Sauvegarde par copier-coller ----------
     Le seul chemin qui ne dépend d'AUCUNE écriture de fichier : ni partage, ni
     gestionnaire de fichiers, ni permission de stockage. Les clés API restent
     volontairement dans le Keystore et ne sont jamais placées dans ce texte. */
  function initTextBackup() {
    var wrap = $('text-backup-wrap');
    var box = $('text-backup-box');
    var hint = $('text-backup-hint');
    var copy = $('text-backup-copy');
    var apply = $('text-backup-apply');

    function open(mode) {
      wrap.hidden = false;
      if (mode === 'export') {
        var payload = Storage.exportAll();
        box.value = JSON.stringify(payload);
        box.readOnly = true;
        copy.hidden = false;
        apply.hidden = true;
        hint.textContent = 'Copie ce texte et colle-le dans une note. Il ne contient aucune clé API.';
        box.focus();
        box.setSelectionRange(0, box.value.length);
      } else {
        box.value = '';
        box.readOnly = false;
        copy.hidden = true;
        apply.hidden = false;
        hint.textContent = 'Colle ici le texte d\'une sauvegarde, puis « Restaurer ce texte ».';
        box.focus();
      }
    }

    $('text-backup').addEventListener('click', function () { open('export'); });
    $('text-restore').addEventListener('click', function () { open('import'); });
    $('text-backup-close').addEventListener('click', function () {
      wrap.hidden = true; box.value = '';
    });

    copy.addEventListener('click', function () {
      box.focus();
      box.setSelectionRange(0, box.value.length);
      /* execCommand est déprécié mais reste le seul chemin fiable dans une
         WebView sans contexte sécurisé : on tente l'API moderne d'abord. */
      var done = function () { toast('Sauvegarde copiée. Colle-la dans une note MAINTENANT.'); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(box.value).then(done).catch(function () {
          if (document.execCommand('copy')) done();
          else toast('Copie refusée : sélectionne le texte et copie-le à la main.');
        });
      } else if (document.execCommand('copy')) {
        done();
      } else {
        toast('Copie refusée : sélectionne le texte et copie-le à la main.');
      }
    });

    apply.addEventListener('click', function () {
      var raw = box.value.trim();
      if (!raw) { toast('Colle d\'abord le texte de ta sauvegarde.'); return; }
      if (raw.length > 10 * 1024 * 1024) {
        toast('Sauvegarde trop volumineuse (maximum 10 Mo).');
        return;
      }
      if (!confirm('Restaurer remplacera ton historique, tes aliments perso et ta calibration actuels. Continuer ?')) return;
      var parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        toast('Texte illisible : ' + (err.message || 'ce n\'est pas une sauvegarde JSON.'));
        return;
      }
      Storage.importAll(parsed).then(function (restored) {
        return finishRestore(restored, function () {
          wrap.hidden = true; box.value = '';
        });
      }).catch(function (err) {
        toast('Texte illisible : ' + (err.message || 'ce n\'est pas une sauvegarde JSON.'));
      });
    });
  }

  // Indice de qualité visuel (●●● = précision max, ●○○ = rapide/économique).
  function starDots(stars) {
    stars = Math.max(0, Math.min(3, stars || 0));
    return '●'.repeat(stars) + '○'.repeat(3 - stars);
  }

  // Remplit un <select> de modèles pour un fournisseur ; gère l'option « Autre modèle… ».
  // Retourne true si le modèle courant correspond à une entrée du catalogue.
  function fillModelSelect(sel, provider, current) {
    var catalog = (Storage.MODEL_CATALOG && Storage.MODEL_CATALOG[provider]) || [];
    sel.innerHTML = '';
    var matched = false;
    catalog.forEach(function (m) {
      var opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label + '  ' + starDots(m.stars) + ' · ' + m.note;
      if (m.id === current) { opt.selected = true; matched = true; }
      sel.appendChild(opt);
    });
    var customOpt = document.createElement('option');
    customOpt.value = CUSTOM_VALUE;
    customOpt.textContent = 'Autre modèle… (saisir l\'id)';
    sel.appendChild(customOpt);
    return matched;
  }

  // Menu déroulant des modèles du fournisseur ACTIF.
  function populateModelSelect(provider, current) {
    var matched = fillModelSelect($('set-model'), provider, current);
    var wrap = $('set-model-custom-wrap');
    if (!matched && current) {
      $('set-model').value = CUSTOM_VALUE;
      $('set-model-custom').value = current;
      wrap.hidden = false;
    } else {
      wrap.hidden = true;
      $('set-model-custom').value = '';
    }
    $('set-model-provider-name').textContent = PROVIDER_NAME[provider] || provider;

    var m = $('model-hint');
    if (provider === 'openai') {
      m.textContent = 'GPT-4o lit les images. ⚠️ « Codex » / l\'abonnement ChatGPT Pro ne donnent pas accès à l\'API.';
    } else if (provider === 'gemini') {
      m.textContent = 'Les modèles « flash » sont rapides et gratuits ; « pro » est plus fin mais son quota gratuit est très limité.';
    } else {
      m.textContent = 'Sonnet 5 = bon équilibre. Opus 4.8 = précision maximale (raisonnement approfondi).';
    }
  }

  // Menu du modèle utilisé pour le second avis, quel que soit son mode.
  function populateVerifyModelSelect(provider, current) {
    var matched = fillModelSelect($('set-verify-model'), provider, current);
    var cw = $('set-verify-model-custom-wrap');
    if (!matched && current) {
      $('set-verify-model').value = CUSTOM_VALUE;
      $('set-verify-model-custom').value = current;
      cw.hidden = false;
    } else {
      cw.hidden = true;
      $('set-verify-model-custom').value = '';
    }
    $('set-verify-provider-name').textContent = PROVIDER_NAME[provider] || provider;
  }

  function updateVerificationSettingsForm() {
    var mode = $('set-verify-mode').value;
    var provider = $('set-provider').value;
    var verifyProvider = $('set-verify-provider');
    Array.from(verifyProvider.options).forEach(function (opt) {
      opt.disabled = opt.value === provider;
    });
    if (mode !== 'off' && (!verifyProvider.value || verifyProvider.value === provider)) {
      var order = ['openrouter', 'claude', 'gemini', 'openai'];
      var replacement = order.filter(function (candidate) {
        return candidate !== provider &&
          Array.from(verifyProvider.options).some(function (opt) {
            return opt.value === candidate;
          });
      })[0];
      if (!replacement) return;
      verifyProvider.value = replacement;
      var models = settings.models || {};
      populateVerifyModelSelect(replacement,
        models[replacement] || Storage.DEFAULT_MODELS[replacement] || '');
    }
    $('set-verify-options').hidden = mode === 'off';
    $('set-verify-threshold-wrap').hidden = mode !== 'auto';
    // Rien à moyenner tant que le second avis ne tourne pas à chaque estimation.
    $('set-merge-wrap').hidden = mode !== 'auto';
    if (mode !== 'auto') $('set-merge').checked = false;
  }

  function updateSettingsSummaries() {
    var provider = $('set-provider').value;
    $('settings-ai-summary').textContent = PROVIDER_NAME[provider] || provider;
    var labels = { off: 'Désactivé', ask: 'Sur demande', auto: 'Automatique' };
    var mode = $('set-verify-mode').value;
    var suffix = mode === 'off' ? '' : ' · ' +
      (PROVIDER_NAME[$('set-verify-provider').value] || $('set-verify-provider').value);
    // La fusion change le nombre affiché : elle mérite d'être lisible sans
    // déplier la section.
    if (mode === 'auto' && $('set-merge').checked) suffix += ' · moyenne des deux';
    $('settings-verification-summary').textContent = (labels[mode] || labels.off) + suffix;
  }

  // Renvoie l'id de modèle sélectionné dans une paire (select + champ perso).
  function getModelFrom(selectId, customId, provider) {
    var v = $(selectId).value;
    if (v === CUSTOM_VALUE) {
      return $(customId).value.trim() || Storage.DEFAULT_MODELS[provider];
    }
    return v || Storage.DEFAULT_MODELS[provider];
  }

  function openSettings() {
    settings = Storage.getSettings();
    var keys = settings.apiKeys || {};
    var models = settings.models || {};
    $('set-provider').value = settings.provider;
    $('set-fallback-provider').value = settings.fallbackProvider || '';
    $('set-key-claude').value = keys.claude || '';
    $('set-key-gemini').value = keys.gemini || '';
    $('set-key-openai').value = keys.openai || '';
    populateModelSelect(settings.provider, models[settings.provider] || Storage.DEFAULT_MODELS[settings.provider] || '');
    $('set-key-openrouter').value = keys.openrouter || '';
    $('set-verify-mode').value = settings.verificationMode || 'off';
    var vp = settings.verifyProvider || 'openrouter';
    $('set-verify-provider').value = vp;
    populateVerifyModelSelect(vp, models[vp] || Storage.DEFAULT_MODELS[vp] || '');
    $('set-verify-threshold').value = String(settings.verifyThresholdPct || 20);
    $('set-merge').checked = !!settings.mergeVerification;
    $('set-partsize').value = settings.partSizeG;
    $('set-round-half').checked = settings.roundHalf;
    if ($('set-experimental')) $('set-experimental').checked = !!settings.experimentalDepth;
    updateVerificationSettingsForm();
    updateSettingsSummaries();
    renderUsage();
    openNativeSettings();
    showModal('settings-modal', 'close-settings');
  }

  /* Réglages qui n'existent que dans l'APK. Les blocs sont dans le HTML commun
     mais restent masqués dans la PWA : rien ne sert de proposer un rappel
     programmé là où le navigateur ne sait pas le déclencher de façon fiable. */
  function openNativeSettings() {
    if (!Native.isApp) return;
    ['set-group-remind', 'set-group-storage', 'set-group-depth', 'keystore-note'].forEach(function (id) {
      var el = $(id);
      if (el) el.hidden = false;
    });
    $('set-remind').checked = !!settings.remindEnabled;
    $('set-remind-delay').value = String(settings.remindDelayMin || 0);
    refreshStorageUsage();
  }

  function refreshStorageUsage() {
    var el = $('storage-usage');
    if (!el || !Native.isApp) return;
    Native.photos.size().then(function (bytes) {
      var mb = bytes / (1024 * 1024);
      var n = Storage.getHistory().filter(function (e) { return e.photo; }).length;
      el.textContent = n + ' photo' + (n > 1 ? 's' : '') + ' conservée' + (n > 1 ? 's' : '') +
        ' · ' + (mb < 0.1 ? '<0,1' : fr(mb)) + ' Mo. ' +
        'Les photos sont des fichiers sur le téléphone : elles ne sont plus rognées comme dans la version web.';
    }).catch(function () {
      el.textContent = 'Espace photo indisponible : le stockage Android n’a pas pu être lu.';
    });
  }

  function saveSettingsFromForm() {
    var provider = $('set-provider').value;
    /* Construit une copie : si le Keystore ou localStorage refuse l'écriture,
       l'application continue d'utiliser les derniers réglages réellement
       persistés au lieu d'un mélange non sauvegardé. */
    var nextSettings = Object.assign({}, settings, {
      provider: provider,
      apiKeys: Object.assign({}, settings.apiKeys || {}),
      models: Object.assign({}, settings.models || {})
    });
    nextSettings.apiKeys.claude = $('set-key-claude').value.trim();
    nextSettings.apiKeys.gemini = $('set-key-gemini').value.trim();
    nextSettings.apiKeys.openai = $('set-key-openai').value.trim();
    nextSettings.apiKeys.openrouter = $('set-key-openrouter').value.trim();
    /* Même exigence que pour le second avis : un secours servi par l'API qui
       vient de tomber n'est pas un secours. On refuse plutôt que d'enregistrer
       un réglage qui donnerait une fausse impression de filet. */
    var fallbackProvider = $('set-fallback-provider').value;
    if (fallbackProvider && fallbackProvider === provider) {
      toast('Choisis un fournisseur de secours différent du fournisseur actif.');
      return;
    }
    nextSettings.fallbackProvider = fallbackProvider;
    var verificationMode = $('set-verify-mode').value;
    var verifyProvider = $('set-verify-provider').value;
    if (verificationMode !== 'off' && verifyProvider === provider) {
      toast('Choisis un fournisseur différent pour le second avis.');
      return;
    }
    nextSettings.verificationMode = verificationMode;
    nextSettings.verifyEnabled = verificationMode === 'auto';
    nextSettings.verifyProvider = verifyProvider;
    nextSettings.verifyThresholdPct = parseInt($('set-verify-threshold').value, 10) || 20;
    nextSettings.mergeVerification = verificationMode === 'auto' && $('set-merge').checked;
    nextSettings.models[provider] = getModelFrom('set-model', 'set-model-custom', provider);
    nextSettings.compareProvider = verificationMode === 'ask' ? verifyProvider : '';
    if (verificationMode !== 'off') {
      nextSettings.models[verifyProvider] =
        getModelFrom('set-verify-model', 'set-verify-model-custom', verifyProvider);
    }
    var ps = parseInt($('set-partsize').value, 10);
    nextSettings.partSizeG = (ps >= 5 && ps <= 20) ? ps : 10;
    nextSettings.roundHalf = $('set-round-half').checked;
    nextSettings.experimentalDepth = !!($('set-experimental') && $('set-experimental').checked);

    var hadRemind = !!settings.remindEnabled;
    var wantsRemind = Native.isApp && $('set-remind').checked;
    if (Native.isApp) {
      nextSettings.remindDelayMin = parseInt($('set-remind-delay').value, 10) || 0;
    }

    var permission = (wantsRemind && !hadRemind)
      ? Native.notify.permission()
      : Promise.resolve(wantsRemind);
    var saveBtn = $('save-settings');
    saveBtn.disabled = true;
    permission.then(function (allowed) {
      nextSettings.remindEnabled = wantsRemind && !!allowed;
      if (wantsRemind && !allowed) {
        toast('Notifications refusées : active-les dans les réglages Android.');
      }
      return Storage.saveSettings(nextSettings);
    }).then(function (savedSettings) {
      if (!savedSettings) throw new Error('Le téléphone a refusé d’enregistrer les réglages.');
      settings = savedSettings;
      hideModal('settings-modal');
      updateCompareToggle();
      updateDepthButtonVisibility();
      toast('Réglages enregistrés.');
    }).catch(function (e) {
      toast('Réglages non enregistrés : ' + ((e && e.message) || 'erreur de stockage'));
    }).then(function () { saveBtn.disabled = false; });
  }

  // En mode « sur demande », affiche une seule case près de l'action principale.
  function updateCompareToggle() {
    var wrap = $('compare-wrap');
    if (!wrap) return;
    var cmp = settings.verifyProvider;
    if (settings.verificationMode === 'ask' && cmp && cmp !== settings.provider) {
      wrap.hidden = false;
      $('compare-label').textContent = 'Demander un 2ᵉ avis (' +
        (PROVIDER_NAME[settings.provider] || settings.provider) + ' + ' +
        (PROVIDER_NAME[cmp] || cmp) + ')';
    } else {
      wrap.hidden = true;
      var cb = $('compare-toggle');
      if (cb) cb.checked = false;
    }
  }

  /* ---------- Banc d'essai ----------
     Aucun classement public ne dit quel modèle lit le mieux TES assiettes. La
     seule référence valable est la valeur réelle relevée sur tes repas — et
     seulement quand elle vient d'une pesée, d'une étiquette ou d'une recette.

     Chaque essai est un vrai appel facturé : on annonce le coût AVANT, et on
     exécute en série pour ne pas déclencher de limitation de débit. */
  // Coût approximatif d'une estimation, en dollars, par identifiant de modèle.
  var COST_HINT = {
    'gemini-3.1-flash-lite': 0.0020,
    'google/gemini-3.1-flash-lite': 0.0020,
    'x-ai/grok-4.5': 0.0212,
    'qwen/qwen3-vl-235b-a22b-thinking': 0.0140,
    'qwen/qwen3.7-flash': 0.00025, 'qwen/qwen3.7-plus': 0.0026,
    'qwen/qwen3-vl-235b-a22b-instruct': 0.0025,
    'anthropic/claude-sonnet-5': 0.018, 'openai/gpt-5.6-terra': 0.0123,
    'google/gemini-3.6-flash': 0.0135,
    'claude-opus-5': 0.045, 'claude-opus-4-8': 0.045,
    'claude-sonnet-5': 0.018, 'claude-haiku-4-5': 0.005,
    'gpt-5.6-sol': 0.03, 'gpt-5.6-terra': 0.0123, 'gpt-5.6-luna': 0.004
  };
  function costOf(model) { return COST_HINT[model] != null ? COST_HINT[model] : 0.015; }

  function benchModelList() {
    var out = [];
    (Storage.PROVIDERS || []).forEach(function (p) {
      if (!(settings.apiKeys || {})[p]) return;
      ((Storage.MODEL_CATALOG || {})[p] || []).forEach(function (m) {
        out.push({ provider: p, model: m.id,
                   label: (PROVIDER_NAME[p] || p) + ' · ' + m.label });
      });
    });
    return out;
  }

  var benchList = [];

  function renderBench() {
    var box = $('bench-cases'), sel = $('bench-models'), sum = $('bench-summary');
    if (!box || !sel) return;

    benchList = Bench.cases(12);
    var models = benchModelList();

    if (!benchList.length) {
      box.innerHTML = '<p class="empty">Aucun repas utilisable pour l\'instant. Il en faut ' +
        'avec une <strong>photo conservée</strong> et une valeur réelle <strong>pesée, ' +
        'lue sur l\'emballage ou calculée</strong> — une estimation personnelle ne peut ' +
        'pas servir d\'arbitre.</p>';
      if (sum) sum.textContent = 'aucun cas';
      $('bench-run').disabled = true;
    } else {
      var vignettes = benchList.filter(function (c) { return c.isThumb; }).length;
      box.innerHTML = '<p class="hint">' + benchList.length + ' repas utilisable' +
        (benchList.length > 1 ? 's' : '') + ' comme cas de test.</p>' +
        (vignettes
          ? '<p class="hint tiny">⚠️ ' + vignettes + ' d\'entre eux n\'ont qu\'une vignette ' +
            'de 320 px (repas enregistrés depuis la version web). La comparaison reste ' +
            'valable entre modèles, mais elle les désavantage tous : leurs erreurs ' +
            'paraîtront plus grandes qu\'en pleine définition.</p>'
          : '');
      if (sum) sum.textContent = benchList.length + ' cas';
      $('bench-run').disabled = false;
    }

    sel.innerHTML = models.map(function (m, i) {
      var pre = (m.provider === settings.provider || m.provider === settings.verifyProvider);
      return '<option value="' + i + '"' + (pre ? ' selected' : '') + '>' +
        escapeHtml(m.label) + '</option>';
    }).join('');
  }

  function initBench() {
    var btn = $('bench-run');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var models = benchModelList();
      var choisis = [].slice.call($('bench-models').selectedOptions)
        .map(function (o) { return models[parseInt(o.value, 10)]; })
        .filter(Boolean);
      if (!choisis.length) { toast('Choisis au moins un modèle.'); return; }
      if (!benchList.length) return;

      var total = choisis.reduce(function (s, m) {
        return s + costOf(m.model) * benchList.length;
      }, 0);
      var msg = choisis.length + ' modèle(s) × ' + benchList.length + ' repas = ' +
        (choisis.length * benchList.length) + ' appels.\n\n' +
        'Coût estimé : environ ' + (total < 0.01 ? 'moins de 0,01 $' : total.toFixed(2) + ' $') +
        '.\n\nLancer ?';
      if (!confirm(msg)) return;

      var status = $('bench-status'), out = $('bench-results');
      status.hidden = false;
      out.innerHTML = '';
      btn.disabled = true;

      var scores = [];
      var next = function (i) {
        if (i >= choisis.length) return Promise.resolve();
        var m = choisis[i];
        return Bench.runModel(m, benchList, settings, function (entry, k, n) {
          status.innerHTML = '<div class="spinner"></div>' + escapeHtml(entry.label) +
            ' — repas ' + (k + 1) + ' / ' + n + ' (modèle ' + (i + 1) + '/' + choisis.length + ')';
        }).then(function (res) {
          scores.push({ label: m.label, s: Bench.score(res) });
          renderBenchResults(scores);
          return next(i + 1);
        });
      };

      next(0).then(function () {
        status.hidden = true;
        btn.disabled = false;
        toast('Banc d\'essai terminé.');
      });
    });
  }

  function renderBenchResults(scores) {
    var out = $('bench-results');
    if (!out) return;
    // Classement par erreur relative moyenne : comparable d'un repas à l'autre,
    // contrairement à une erreur en grammes qui favorise les petits repas.
    var tri = scores.slice().filter(function (x) { return x.s.n; })
      .sort(function (a, b) { return a.s.mape - b.s.mape; });
    if (!tri.length) { out.innerHTML = ''; return; }

    out.innerHTML = '<table class="bench-table"><thead><tr>' +
      '<th>Modèle</th><th class="num">Erreur</th><th class="num">En grammes</th>' +
      '<th class="num">Tendance</th></tr></thead><tbody>' +
      tri.map(function (x, i) {
        var t = x.s.biais > 0 ? '+' + x.s.biais + ' g' : x.s.biais + ' g';
        return '<tr' + (i === 0 ? ' class="bench-best"' : '') + '>' +
          '<td>' + (i === 0 ? '🏆 ' : '') + escapeHtml(x.label) + '</td>' +
          '<td class="num">' + x.s.mape + ' %</td>' +
          '<td class="num">' + x.s.mae + ' g</td>' +
          '<td class="num">' + t + '</td></tr>';
      }).join('') + '</tbody></table>' +
      '<p class="hint tiny">Erreur = écart moyen à ta valeur réelle, en pourcentage. ' +
      'Tendance positive = le modèle surestime. Sur ' + tri[0].s.n + ' repas' +
      (tri[0].s.failed ? ' (' + tri[0].s.failed + ' échec(s) ignoré(s))' : '') + '.</p>';
  }

  // ---------- Synthèse pour la consultation ----------

  function buildReport() {
    var days = parseInt($('report-days').value, 10) || 90;
    var r = Report.html(days);
    if (!r) {
      toast('Aucun repas enregistré sur cette période.');
      return null;
    }
    return r;
  }

  function initReport() {
    var view = $('report-view'), share = $('report-share');
    if (!view || !share) return;

    /* Aperçu dans un onglet/une fenêtre : le document a sa propre mise en page
       (et sa propre feuille de style d'impression), l'encastrer dans l'app le
       dénaturerait. On passe par un Blob plutôt que document.write pour que
       « Imprimer » du navigateur voie un vrai document autonome. */
    view.addEventListener('click', function () {
      var r = buildReport();
      if (!r) return;
      var url = URL.createObjectURL(new Blob([r.html], { type: 'text/html' }));
      var w = window.open(url, '_blank');
      if (!w) {
        toast('Ouverture bloquée. Utilise « Envoyer » pour récupérer le fichier.');
      }
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    });

    share.addEventListener('click', function () {
      var r = buildReport();
      if (!r) return;
      var stamp = new Date().toISOString().slice(0, 10);
      var name = 'glucovision-synthese-' + stamp + '.html';
      var title = 'Synthèse glucides — ' + r.stats.count + ' repas';

      saveTextFile(name, r.html, 'text/html', title).then(function (mode) {
        if (mode === 'annule' || mode === 'partage') return;
        toast(mode === 'enregistre' ? 'Synthèse enregistrée.'
            : mode === 'documents' ? 'Partage indisponible — synthèse écrite ici : ' + lastSavePath
            : 'Synthèse téléchargée.');
      });
    });
  }

  // ---------- Divers ----------
  /* Source d'image d'une entrée d'historique, quel que soit le support :
     vignette base64 héritée de la PWA, ou fichier sur disque dans l'APK.
     Les deux formes coexistent — un historique créé avant l'APK garde ses
     vignettes, et elles restent affichables. */
  function historyImg(e) {
    if (e.thumb) return e.thumb;
    if (e.photo && Native.isApp) return Native.photos.src(e.photo);
    return null;
  }

  function escapeHtml(s) {
    return (s || '').toString()
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* Bandeau « Actualiser ». Volontairement partagé par les deux mécanismes de
     mise à jour — service worker dans la PWA, bundle téléchargé dans l'APK :
     l'utilisateur voit la même chose et décide du moment de la bascule, plutôt
     que de voir l'app se recharger toute seule en plein repas. */
  function showUpdate(apply) {
    var banner = $('update-banner');
    if (!banner || typeof apply !== 'function') return;
    banner.hidden = false;
    var btn = $('update-btn');
    btn.onclick = function () {
      btn.disabled = true;
      btn.textContent = 'Mise à jour…';
      Promise.resolve().then(apply).catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Actualiser';
        setUpdateStatus('❌ Mise à jour non appliquée : ' +
          escapeHtml((err && err.message) || 'erreur inconnue') + '.', 'warn');
      });
    };
  }

  /* Mises à jour du contenu web de l'APK (OTA).
     Sans ça, chaque version imposerait de retélécharger et réinstaller l'APK.
     Seul un changement de plugin NATIF impose encore un nouvel APK. */
  var OTA_MANIFEST =
    'https://github.com/rachid598/Diab-te/releases/download/ota-codex/latest.json';
  var APK_DOWNLOAD =
    'https://github.com/rachid598/Diab-te/releases/download/apk-codex/glucovision.apk';
  /* Publié par la CI à côté de l'APK, sur le même tag : versionCode, versionName
     et empreinte de l'APK réellement en ligne. C'est ce qui permet de COMPARER
     au lieu de proposer un lien aveugle. */
  var APK_MANIFEST =
    'https://github.com/rachid598/Diab-te/releases/download/apk-codex/apk.json';

  function showApkRequired(info, installedBuild) {
    var el = $('native-outdated');
    if (!el) return;
    el.hidden = false;
    el.innerHTML = '⚠️ <strong>Nouvel APK nécessaire</strong> — la version ' +
      escapeHtml(String((info && info.appVersion) || '')) + ' exige le build ' +
      escapeHtml(String((info && info.minNativeBuild) || '')) + ', tu as le ' +
      escapeHtml(String(installedBuild || 0)) + '. ' +
      '<a href="' + APK_DOWNLOAD + '">Télécharger l\'APK codex signé</a>.';
  }

  function initNativeUpdate() {
    if (!Native.isApp) return;
    var run = function () {
      Native.update.check(OTA_MANIFEST, APP_VERSION).then(function (status) {
        if (!status) return null;
        if (status.kind === 'apk-required') {
          showApkRequired(status.info, status.nativeBuild);
          return null;
        }
        if (status.kind !== 'available') return null;
        return Native.update.download(status);
      }).then(function (bundle) {
        if (bundle) showUpdate(function () { return Native.update.apply(bundle); });
      }).catch(function () { /* hors ligne : on retentera */ });
    };
    run();
    setInterval(run, 6 * 60 * 60 * 1000);
  }

  /* ---------- Vérification manuelle des mises à jour ----------
     La vérification automatique échouait en SILENCE : pas de réseau, publication
     en retard, worker en attente — dans tous les cas l'app restait sur son
     ancienne version sans rien dire, et on ne pouvait pas distinguer « à jour »
     de « quelque chose ne marche pas ». Ce bouton nomme la situation. */

  function setUpdateStatus(msg, kind) {
    var el = $('update-status');
    if (!el) return;
    el.hidden = false;
    el.className = 'update-status' + (kind ? ' us-' + kind : '');
    el.innerHTML = msg;
  }

  /* Version réellement publiée. Deux chemins, parce que les contraintes ne sont
     pas les mêmes : l'APK lit le manifeste des releases par le réseau natif
     (aucun blocage d'origine croisée), la PWA relit son propre js/app.js avec un
     anti-cache — c'est la seule source qui dise ce que le serveur sert VRAIMENT,
     par opposition à ce que le cache du navigateur veut bien montrer. */
  function fetchPublishedVersion() {
    if (Native.isApp) {
      /* currentVersion=0 demande le manifeste validé même si l'app est déjà à
         jour ; le bouton manuel peut ainsi distinguer « à jour » de « APK natif
         trop ancien » sans dupliquer le validateur de native.js. */
      return Native.update.check(OTA_MANIFEST, 0)
        .then(function (status) {
          if (!status || !status.info) throw new Error('Manifeste illisible.');
          return { version: String(status.info.appVersion), info: status.info,
                   nativeStatus: status };
        });
    }
    return fetch('js/app.js?maj=' + Date.now(), { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function (txt) {
        var m = /APP_VERSION = '(\d+)'/.exec(txt);
        if (!m) throw new Error('Version introuvable.');
        return { version: m[1], info: null };
      });
  }

  /* ---------- Consommation d'API ----------
     Le coût est appliqué à l'AFFICHAGE et non enregistré : corriger un tarif ne
     doit pas réécrire l'historique des appels déjà passés. */
  function renderUsage() {
    var box = $('usage-box');
    if (!box || !Storage.getUsage) return;
    var mois = new Date().toISOString().slice(0, 7);
    var u = Storage.getUsage(mois);
    var cles = Object.keys(u);
    if (!cles.length) {
      box.innerHTML = '<p class="hint tiny">Aucun appel ce mois-ci.</p>';
      return;
    }
    var total = 0, lignes = cles.map(function (k) {
      var parts = k.split('|');
      var n = u[k], c = costOf(parts[1]) * n;
      total += c;
      return { label: (PROVIDER_NAME[parts[0]] || parts[0]) + ' · ' + parts[1], n: n, c: c };
    }).sort(function (a, b) { return b.c - a.c; });

    box.innerHTML = '<table class="usage-table"><tbody>' +
      lignes.map(function (l) {
        return '<tr><td>' + escapeHtml(l.label) + '</td>' +
          '<td class="num">' + l.n + ' tentative' + (l.n > 1 ? 's' : '') + '</td>' +
          '<td class="num">' + (l.c < 0.01 ? '<0,01' : l.c.toFixed(2)) + ' $</td></tr>';
      }).join('') +
      '<tr class="usage-total"><td>Total du mois</td><td class="num"></td><td class="num">' +
      (total < 0.01 ? '<0,01' : total.toFixed(2)) + ' $ max.</td></tr>' +
      '</tbody></table>';
  }

  /* Demande une mise à jour PWA sans recharger tant que le nouveau worker n'a
     pas fini de précharger toute sa coquille. Recharger juste après reg.update()
     provoquait parfois une seconde demande « Actualiser », ou une page encore
     servie par l'ancien worker. */
  function installAndActivateWorker(reg) {
    if (!reg) { window.location.reload(); return Promise.resolve(); }
    if (reg.waiting) {
      reg.waiting.postMessage('SKIP_WAITING');
      return Promise.resolve();
    }
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error('Le nouveau contenu n’a pas fini de s’installer. Réessaie.'));
      }, 20000);
      var activate = function (worker) {
        if (!worker) return;
        var check = function () {
          if (done || worker.state !== 'installed') return;
          done = true;
          clearTimeout(timer);
          worker.postMessage('SKIP_WAITING');
          resolve();
        };
        worker.addEventListener('statechange', check);
        check();
      };
      reg.addEventListener('updatefound', function () { activate(reg.installing); }, { once: true });
      activate(reg.installing);
      reg.update().then(function () {
        if (reg.waiting && !done) {
          done = true;
          clearTimeout(timer);
          reg.waiting.postMessage('SKIP_WAITING');
          resolve();
        } else {
          activate(reg.installing);
        }
      }).catch(function (err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  function initUpdateCheck() {
    var btn = $('check-update');
    if (!btn) return;
    btn.addEventListener('click', function () {
      btn.disabled = true;
      setUpdateStatus('<span class="spinner"></span>Vérification…', '');

      fetchPublishedVersion().then(function (pub) {
        var local = parseInt(APP_VERSION, 10);
        var online = parseInt(pub.version, 10);

        if (Native.isApp && pub.nativeStatus && pub.nativeStatus.kind === 'apk-required') {
          btn.disabled = false;
          showApkRequired(pub.nativeStatus.info, pub.nativeStatus.nativeBuild);
          setUpdateStatus('⚠️ La version ' + pub.version +
            ' nécessite un nouvel APK signé ; une actualisation du contenu ne suffit pas.', 'warn');
          return;
        }

        if (online <= local) {
          setUpdateStatus('✅ Tu es à jour — version ' + APP_VERSION +
            ', et c\'est bien la dernière publiée.', 'ok');
          btn.disabled = false;
          return;
        }

        setUpdateStatus('⬇️ Version ' + pub.version + ' disponible (tu es en ' +
          APP_VERSION + '). Téléchargement…', '');

        if (Native.isApp) {
          return Native.update.download(pub.info).then(function (bundle) {
            btn.disabled = false;
            if (!bundle) {
              setUpdateStatus('⚠️ Version ' + pub.version + ' trouvée, mais le ' +
                'téléchargement a échoué. Réessaie avec une meilleure connexion.', 'warn');
              return;
            }
            setUpdateStatus('✅ Version ' + pub.version + ' prête.', 'ok');
            showUpdate(function () { return Native.update.apply(bundle); });
          });
        }

        /* PWA : le service worker peut détenir l'ancienne page en cache. On le
           force à se remettre à jour, puis on recharge en contournant le cache. */
        btn.disabled = false;
        setUpdateStatus('✅ Version ' + pub.version + ' disponible.', 'ok');
        var apply = function () {
          if (!('serviceWorker' in navigator)) { window.location.reload(); return; }
          return navigator.serviceWorker.getRegistration().then(function (reg) {
            return installAndActivateWorker(reg);
          });
        };
        showUpdate(apply);
      }).catch(function (e) {
        btn.disabled = false;
        setUpdateStatus('❌ Impossible de vérifier : ' + escapeHtml(e.message || 'réseau injoignable') +
          '. Réessaie une fois connecté.', 'warn');
      });
    });
  }

  /* ---------- APK : lien permanent et comparaison de version ----------
     Jusqu'ici le lien de téléchargement n'existait que dans le bandeau « APK
     trop ancien » : il n'apparaissait donc qu'une fois déjà bloqué, et il n'y
     avait aucun moyen de simplement DEMANDER s'il y a mieux. Le lien est
     maintenant permanent, et le bouton compare le build installé à celui
     réellement publié — ce que apk.json permet de savoir sans deviner. */

  function setApkStatus(msg, kind) {
    var el = $('apk-status');
    if (!el) return;
    el.hidden = false;
    el.className = 'update-status' + (kind ? ' us-' + kind : '');
    el.innerHTML = msg;
  }

  function fetchApkInfo() {
    /* Un JSON incomplet ne doit pas produire un « à jour » rassurant : sans
       versionCode exploitable il n'y a rien à comparer, et on le dit. */
    var valide = function (data) {
      var code = data ? parseInt(data.versionCode, 10) : NaN;
      if (!isFinite(code) || code <= 0) throw new Error('publication illisible');
      return data;
    };
    if (Native.isApp) {
      // Dans l'APK la requête part du natif : pas de blocage d'origine croisée.
      return Native.httpJson(APK_MANIFEST, 15000).then(function (r) {
        if (!r || r.status !== 200) throw new Error('HTTP ' + ((r && r.status) || '?'));
        return valide(r.data);
      });
    }
    return fetch(APK_MANIFEST, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(valide);
  }

  /* Le même auto-diagnostic que celui lu par la CI, mais à l'écran. L'émulateur
     de CI n'a ni ARCore, ni capteur de profondeur, ni vrai appareil photo : il
     prouve que l'app démarre, jamais qu'elle fonctionne SUR TON TÉLÉPHONE. Ici
     tu as la réponse en cinq secondes, au lieu de la deviner. */
  var DIAG_NOMS = {
    camera: 'appareil photo', fichiers: 'fichiers', http: 'réseau natif',
    maj: 'mises à jour', coffre: 'coffre à clés', notif: 'notifications',
    partage: 'partage', app: 'infos app', profondeur: 'profondeur (LiDAR/ARCore)'
  };

  function renderDiagNatif() {
    var el = $('diag-natif');
    if (!el || !Native.selfCheck) return;
    var d = Native.selfCheck();
    if (!d.isApp) return;                 // dans le navigateur, rien à diagnostiquer
    el.hidden = false;
    var bouts = Object.keys(DIAG_NOMS).map(function (k) {
      var v = d[k];
      // Majuscules = requis et cassé ; minuscules = optionnel et simplement absent.
      var marque = v === 'ok' ? '✅'
        : (v === 'ABSENT' || v === 'SANS-NATIF') ? '❌' : '—';
      return marque + ' ' + escapeHtml(DIAG_NOMS[k]);
    });
    /* Deux pannes différentes, deux messages différents : un module absent du
       bundle et un plugin non enregistré côté Android ne se réparent pas de la
       même façon, et les confondre enverrait réinstaller pour rien. */
    var casse = d.manques.concat(d.manquesNatifs);
    el.className = 'update-status' + (casse.length ? ' us-warn' : ' us-ok');
    var tete;
    if (d.manques.length) {
      tete = '<strong>Application incomplète</strong> — ' +
        escapeHtml(d.manques.join(', ')) + ' manque(nt) au contenu web. ' +
        'Vérifie les mises à jour.';
    } else if (d.manquesNatifs.length) {
      tete = '<strong>Capacités natives absentes</strong> — ' +
        escapeHtml(d.manquesNatifs.join(', ')) + ' n\'est pas enregistré dans ' +
        'cet APK. Réinstalle-le.';
    } else if (!d.entetes) {
      tete = '<strong>Capacités natives</strong> — non vérifiables ici.';
    } else {
      tete = '<strong>Capacités natives</strong> — tout ce qui est requis répond.';
    }
    el.innerHTML = tete + '<br><span class="tiny">' + bouts.join(' · ') + '</span>';
  }

  function initApkCheck() {
    renderDiagNatif();
    var bloc = $('apk-block');
    if (!bloc) return;
    /* Sur iOS l'APK n'existe pas : l'app y est posée par Xcode, et proposer un
       fichier Android n'y serait qu'une fausse piste. */
    if (Native.isApp && Native.platform === 'ios') { bloc.hidden = true; return; }

    // Une seule source pour l'URL : la constante, pas un href figé dans le HTML.
    var lien = $('apk-link');
    if (lien) lien.href = APK_DOWNLOAD;

    var btn = $('check-apk');
    if (!btn) return;
    btn.addEventListener('click', function () {
      btn.disabled = true;
      setApkStatus('<span class="spinner"></span>Lecture de la version publiée…', '');
      fetchApkInfo().then(function (info) {
        btn.disabled = false;
        var publie = parseInt(info.versionCode, 10);
        var nom = escapeHtml(String(info.versionName || ('build ' + publie)));
        var emp = String(info.sha256 || '').slice(0, 12);
        // L'empreinte permet de vérifier le fichier téléchargé avant installation.
        var pied = emp ? '<br><span class="tiny">Empreinte SHA-256 : ' +
                         escapeHtml(emp) + '…</span>' : '';

        if (!Native.isApp) {
          setApkStatus('📦 Dernier APK publié : <strong>' + nom + '</strong> (build ' +
            publie + '). Tu n\'es pas dans l\'application Android — rien à comparer, ' +
            'mais le lien ci-dessous installe bien cette version.' + pied, '');
          return;
        }
        if (nativeBuild == null) {
          setApkStatus('📦 Dernier APK publié : <strong>' + nom + '</strong> (build ' +
            publie + '). Le build installé n\'a pas pu être lu, la comparaison ' +
            'est donc impossible.' + pied, 'warn');
          return;
        }
        if (publie <= nativeBuild) {
          setApkStatus('✅ Ton APK est à jour — <strong>' + nom + '</strong> (build ' +
            nativeBuild + '), c\'est bien le dernier publié.' + pied, 'ok');
          return;
        }
        setApkStatus('⬇️ APK <strong>' + nom + '</strong> (build ' + publie +
          ') disponible — tu as le build ' + nativeBuild + '. Télécharge-le ' +
          'ci-dessous et installe-le par-dessus.' + pied, 'warn');
      }).catch(function (e) {
        btn.disabled = false;
        setApkStatus('❌ Version publiée illisible : ' +
          escapeHtml((e && e.message) || 'réseau injoignable') +
          '. Le lien de téléchargement reste utilisable.', 'warn');
      });
    });
  }

  function registerSW() {
    // Dans l'APK les fichiers sont déjà locaux : le service worker n'a pas lieu
    // d'être, et c'est le mécanisme OTA qui gère les mises à jour.
    if (Native.isApp) return;
    if (!('serviceWorker' in navigator)) return;

    // Quand la nouvelle version prend le contrôle, on recharge une seule fois.
    var refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });

    navigator.serviceWorker.register('service-worker.js').then(function (reg) {
      var applyWorker = function (worker) {
        return function () { worker.postMessage('SKIP_WAITING'); }; // → controllerchange → reload
      };

      // Une version est déjà en attente au chargement.
      if (reg.waiting && navigator.serviceWorker.controller) showUpdate(applyWorker(reg.waiting));

      // Une nouvelle version vient d'être trouvée et installée.
      reg.addEventListener('updatefound', function () {
        var nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', function () {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdate(applyWorker(nw));
          }
        });
      });

      // Vérifie périodiquement s'il y a une mise à jour (sessions longues).
      setInterval(function () { try { reg.update(); } catch (e) {} }, 60 * 60 * 1000);
    }).catch(function () {});
  }

  function controlledWorkerVersion() {
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller ||
        typeof MessageChannel === 'undefined') return Promise.resolve(null);
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (!done) { done = true; resolve(null); }
      }, 500);
      var channel = new MessageChannel();
      channel.port1.onmessage = function (event) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(String(event.data || ''));
      };
      try {
        navigator.serviceWorker.controller.postMessage(
          { type: 'GET_VERSION' }, [channel.port2]);
      } catch (e) {
        clearTimeout(timer);
        done = true;
        resolve(null);
      }
    });
  }

  /* Protection de transition v79 → v80. L'ancien worker v79 était
     network-first : un rechargement pouvait donc exécuter index/app v80 avant
     que le worker v80 soit activé. On interroge le contrôleur AVANT toute
     hydratation ou interaction. S'il est ancien (ou ne sait pas répondre), on
     termine l'installation atomique et recharge ; l'utilisateur ne manipule
     jamais cette coquille intermédiaire. Les mises à jour normales restent,
     elles, soumises au bouton Actualiser. */
  function ensureCurrentPwaShell() {
    if (Native.isApp || !('serviceWorker' in navigator) ||
        !navigator.serviceWorker.controller) return Promise.resolve(true);
    return controlledWorkerVersion().then(function (version) {
      if (version === APP_VERSION) return true;
      var banner = $('update-banner'), updateBtn = $('update-btn');
      if (banner) banner.hidden = false;
      if (updateBtn) {
        updateBtn.disabled = true;
        updateBtn.textContent = 'Finalisation…';
      }
      return navigator.serviceWorker.getRegistration().then(function (reg) {
        if (!reg) return true;
        var reloading = false;
        navigator.serviceWorker.addEventListener('controllerchange', function () {
          if (reloading) return;
          reloading = true;
          window.location.reload();
        }, { once: true });
        return installAndActivateWorker(reg).then(function () { return false; });
      }).catch(function (err) {
        var el = $('native-outdated');
        if (el) {
          el.hidden = false;
          el.innerHTML = '⚠️ <strong>Mise à jour web incomplète.</strong> ' +
            'Reconnecte-toi puis recharge la page avant d’utiliser une estimation. ' +
            escapeHtml((err && err.message) || 'Service worker indisponible.');
        }
        return false;
      });
    });
  }

  function showVersion() {
    var el = $('app-version');
    if (!el) return;
    var txt = 'Version ' + APP_VERSION + ' · GlucoVision';
    if (Native.isApp) {
      var android = !Native.platform || Native.platform === 'android';
      txt += (android ? ' · APK ' : ' · iOS build ') +
             (nativeBuild == null ? '…' : nativeBuild);
      if (android && nativeBuild != null && nativeBuild < MIN_NATIVE_BUILD) {
        txt += ' (trop ancien, min. ' + MIN_NATIVE_BUILD + ')';
      }
    }
    el.textContent = txt;
  }

  /* Vérifie que le natif en cours d'exécution est au niveau exigé par ce bundle.
     Sans ce contrôle, un APK ancien chargeait un bundle récent, affichait sa
     version, et échouait silencieusement sur les capacités qu'il n'a pas. */
  function checkNativeFloor() {
    if (!Native.isApp || !Native.appBuild) return;
    Native.appBuild().then(function (build) {
      nativeBuild = build;
      showVersion();
      updateDepthButtonVisibility();
      /* Le plancher ne vaut QUE pour l'APK Android, où le contenu web se met à
         jour par OTA pendant que le code natif reste celui de l'APK installé.
         Sur iOS il n'y a pas d'OTA : natif et web sont compilés ensemble à
         chaque ▶, donc le natif est à jour par construction — et sa numérotation
         repart de 1. Le plancher se déclencherait donc systématiquement, et
         masquerait des fonctions en réalité présentes. */
      if (Native.platform && Native.platform !== 'android') return;
      if (build == null || build >= MIN_NATIVE_BUILD) return;
      var el = $('native-outdated');
      if (!el) return;
      el.hidden = false;
      el.innerHTML = '⚠️ <strong>Application Android trop ancienne</strong> — build ' + build +
        ', minimum requis ' + MIN_NATIVE_BUILD + '. Le contenu web s\'est mis à jour, ' +
        'mais le code natif non : certaines fonctions sont indisponibles. ' +
        '<a href="' + APK_DOWNLOAD + '">Réinstalle l\'APK codex signé</a>.';
    });
  }

  // ---------- Init ----------
  function init() {
    // Relu APRÈS l'hydratation : sur l'APK les clés API viennent du Keystore.
    settings = Storage.getSettings();
    showVersion();
    checkNativeFloor();
    initInstall();
    initSafetyBanner();
    initTabs();
    initPhotos();
    initModeSwitch();
    initExtras();
    initDepth();
    initEstimate();
    initManual();
    initHistory();
    initSettings();
    initVenue();
    updateCompareToggle();
    renderThumbs();
    updateEstimateBtn();
    registerSW();
    initNativeUpdate();
    initQueue();
    initShortcuts();
    // Rattrape les images orphelines laissées par un enregistrement interrompu.
    if (Native.isApp) Storage.prunePhotos().catch(function () {
      /* Nettoyage opportuniste : une permission temporairement refusée ne doit
         jamais empêcher l'app de démarrer. Le bouton Réglages donnera le
         diagnostic explicite si l'utilisateur demande une purge. */
    });
    /* En dernier : si une comparaison n'avait pas été tranchée, on la remet à
       l'écran. Après tout le reste, pour ne pas être écrasée par un rendu. */
    restaurerEnCours();
    if (Native.markReady) {
      Native.markReady().catch(function () {
        toast('La mise à jour n’a pas pu être validée ; l’APK gardera la version précédente.');
      });
    }
    annoncerDemarrage();
  }

  /* Dépose une ligne unique disant que l'app a fini de démarrer et quelles
     capacités natives ont répondu. La CI installe l'APK sur un émulateur, le
     lance, et lit cette ligne. Son ABSENCE est le signal recherché — un APK qui
     plante au lancement ou qui reste sur un écran blanc ne l'écrit jamais, et
     c'est précisément la panne que les contrôles d'intégrité de la chaîne de
     publication (signature, empreintes, versionCode) ne peuvent pas voir.

     Placée en toute fin d'init : elle n'est atteignable qu'une fois le pont
     natif prêt, le stockage déchiffré et l'interface rendue.

     Le numéro de build n'est connu qu'après appBuild(), d'où l'attente. */
  function annoncerDemarrage() {
    if (!Native.writeStartupReport) return;
    var ecrire = function () {
      Native.writeStartupReport(APP_VERSION).then(function (ligne) {
        // Sans effet dans l'APK publié (Capacitor n'y relaie pas la console),
        // mais c'est le seul canal disponible dans le navigateur.
        try { console.log(ligne); } catch (e) {}
      });
    };
    if (Native.isApp && Native.appBuild) Native.appBuild().then(ecrire, ecrire);
    else ecrire();
  }

  /* On attend que le pont natif soit prêt AVANT le premier rendu : les clés API
     doivent être déchiffrées et l'URL de base des photos connue, sinon la
     première ouverture afficherait des réglages vides et un historique sans
     images. Native.ready() a son propre garde-fou de 3 s et ne peut pas bloquer
     le démarrage ; dans le navigateur il se résout immédiatement. */
  document.addEventListener('DOMContentLoaded', function () {
    Native.ready()
      .then(ensureCurrentPwaShell)
      .then(function (ready) {
        if (!ready) return;
        return Storage.hydrate().then(init, init);
      });
  });
})();
