/* app.js — orchestration de l'interface. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var APP_VERSION = '32'; // à garder synchro avec la version du service worker
  var settings = Storage.getSettings();

  // État courant
  var images = [];        // [{base64, mediaType, previewUrl}]
  var lastResult = null;  // résultat IA (modifiable)
  var manualItems = [];   // [{name, carb(per100g), grams}]

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

  var CONF_LABEL = { high: 'Confiance élevée', medium: 'Confiance moyenne', low: 'Confiance faible' };
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
      d.innerHTML = '<img src="' + img.previewUrl + '" alt="angle ' + (i + 1) + '">' +
                    '<button data-i="' + i + '" aria-label="Retirer">✕</button>';
      wrap.appendChild(d);
    });
    wrap.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        images.splice(parseInt(b.dataset.i, 10), 1);
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
  }

  /* ---------- Source de l'estimation : photo ou description ----------
     Ce sont deux méthodes distinctes, pas deux étapes d'une même saisie. Le
     mode est donc porté par l'onglet actif et non déduit de la présence de
     photos : sans ça, ajouter une photo par erreur ferait basculer
     silencieusement une estimation qu'on voulait textuelle. */
  var inputMode = 'photo';

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
    });
    root.querySelectorAll(':scope > .mode-pane').forEach(function (p) {
      p.classList.toggle('active', p.dataset.pane === name);
    });
  }

  function initPanes(rootId, onSelect) {
    var root = $(rootId);
    if (!root) return;
    root.querySelectorAll(':scope > .mode-switch > .mode-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        selectPane(rootId, b.dataset.mode);
        if (onSelect) onSelect(b.dataset.mode);
      });
    });
  }

  function setMode(mode) {
    inputMode = (mode === 'texte') ? 'texte' : 'photo';
    selectPane('tab-analyze', inputMode);

    /* La zone de texte est déplacée dans le volet actif au lieu d'être
       dupliquée : le contenu déjà saisi et les écouteurs suivent le nœud. */
    var card = $('notes-card');
    if (inputMode === 'texte') {
      $('pane-texte').appendChild(card);
      $('notes-title').firstChild.nodeValue = 'Décris ton repas ';
      $('notes-tag').textContent = 'sans photo';
      $('notes-hint').innerHTML = 'Écris simplement ce que tu manges, en une phrase.';
    } else {
      $('pane-photo').appendChild(card);
      $('notes-title').firstChild.nodeValue = 'Précisions ';
      $('notes-tag').textContent = 'optionnel';
      $('notes-hint').innerHTML = 'Ce que tu sais déjà améliore l\'estimation (ex. « riz basmati ~150 g cuit, pain 60 g »).';
    }
    updateEstimateBtn();
  }

  function initModeSwitch() {
    initPanes('tab-analyze', setMode);
    setMode('photo');
  }

  function updateEstimateBtn() {
    var textMode = inputMode === 'texte';
    var ready = textMode ? describedMeal().length >= 4 : images.length > 0;
    var btn = $('estimate-btn');
    btn.disabled = !ready;
    btn.textContent = textMode ? '✍️ Estimer d\'après ma description' : '🔎 Estimer les glucides';

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

  function setExtractStatus(on) {
    var s = $('analyze-status');
    if (on) { s.hidden = false; s.innerHTML = '<div class="spinner"></div>Extraction des images de la vidéo…'; }
    else { s.hidden = true; }
  }

  function addFiles(files) {
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
  function addDataUrls(urls) {
    var room = Camera.MAX_ANGLES - images.length;
    if (room <= 0) { toast('Maximum ' + Camera.MAX_ANGLES + ' vues.'); return; }
    Camera.processDataUrls(urls.slice(0, room)).then(function (out) {
      out.results.forEach(function (r) { if (images.length < Camera.MAX_ANGLES) images.push(r); });
      renderThumbs();
      updateEstimateBtn();
      if (out.errors.length) toast(out.errors.length + ' photo(s) ignorée(s).');
    }).catch(function (e) { toast(e.message); });
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
      images = []; renderThumbs(); updateEstimateBtn();
    });
    $('reference-object').addEventListener('change', function (e) {
      $('plate-diameter-wrap').hidden = e.target.value !== 'assiette';
    });
    // La saisie d'une description active à elle seule le bouton d'estimation.
    $('user-notes').addEventListener('input', updateEstimateBtn);
  }

  // ---------- Estimation IA ----------
  function initEstimate() {
    $('estimate-btn').addEventListener('click', runEstimate);
  }

  function runEstimate() {
    var status = $('analyze-status');
    var resultsEl = $('results');
    resultsEl.hidden = true;
    status.hidden = false;
    $('estimate-btn').disabled = true;

    // En mode description, les photos éventuelles ne sont pas envoyées.
    var textOnly = inputMode === 'texte';
    var sent = textOnly ? [] : images;
    var ctx = {
      referenceObject: $('reference-object').value,
      plateDiameterCm: $('plate-diameter').value ? parseFloat($('plate-diameter').value) : null,
      notes: $('user-notes').value,
      imageCount: sent.length     // 0 fait basculer l'estimateur en mode description
    };

    var cmp = settings.compareProvider;
    var wantCompare = cmp && cmp !== settings.provider &&
                      $('compare-wrap') && !$('compare-wrap').hidden && $('compare-toggle').checked;

    if (wantCompare) {
      status.innerHTML = '<div class="spinner"></div>Double analyse en cours (' +
        (PROVIDER_NAME[settings.provider] || settings.provider) + ' + ' +
        (PROVIDER_NAME[cmp] || cmp) + ')… cela peut prendre 20 à 40 s.';
      // On lance les deux fournisseurs en parallèle ; chacun peut échouer indépendamment.
      var wrap = function (p) {
        return Estimator.estimateWith(p, sent, ctx, settings)
          .then(function (r) { return { ok: true, provider: p, result: r }; })
          .catch(function (e) { return { ok: false, provider: p, error: e.message }; });
      };
      Promise.all([wrap(settings.provider), wrap(cmp)]).then(function (pair) {
        status.hidden = true;
        var a = pair[0], b = pair[1];
        if (!a.ok && !b.ok) { toast(a.error || b.error); return; }
        renderCompare(a, b);
      }).then(function () { updateEstimateBtn(); });
      return;
    }

    status.innerHTML = '<div class="spinner"></div>' + (textOnly
      ? 'Estimation d\'après ta description… interprétation des portions et calcul des glucides.'
      : 'Analyse en cours… mesure des portions via le repère, calcul des glucides. Le raisonnement approfondi peut prendre 10 à 30 s.');
    Estimator.estimate(sent, ctx, settings).then(function (result) {
      lastResult = result;
      status.hidden = true;
      renderResults(result);
    }).catch(function (e) {
      status.hidden = true;
      offerQueue(e, ctx, sent);
    }).then(function () {
      updateEstimateBtn();
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
    Queue.prune();
    var pending = Queue.list();
    if (!pending.length) { renderQueue(); return; }
    if (!navigator.onLine && !manual) return;

    queueBusy = true;
    renderQueue();

    var next = function (i) {
      if (i >= pending.length) return Promise.resolve();
      var item = pending[i];
      return Queue.load(item)
        .then(function (imgs) { return Estimator.estimate(imgs, item.ctx, settings); })
        .then(function (result) {
          var entry = {
            date: item.date, source: 'photo', totalCarbsG: result.totalCarbsG,
            parts: partsFrom(result.totalCarbsG), partSizeG: settings.partSizeG,
            glycemicSpeed: result.glycemicSpeed || null,
            gi: result.gi ? { gl: result.gi.gl, gi: result.gi.gi } : null,
            items: result.items.map(function (it) { return { name: it.name, carbsG: it.carbsG }; })
          };
          Storage.addHistory(entry);
          Queue.remove(item.id);
          // L'utilisateur n'a pas l'app sous les yeux : c'est le rôle d'une notification.
          Native.notify.schedule({
            id: Math.floor(item.date / 1000),
            title: 'Estimation prête',
            body: 'Le repas mis de côté a été analysé : ' + result.totalCarbsG + ' g (' +
                  fr(partsFrom(result.totalCarbsG)) + ' parts).',
            at: new Date(Date.now() + 1000)
          });
          return next(i + 1);
        })
        .catch(function (e) {
          // Toujours hors ligne : on s'arrête et on retentera plus tard.
          if (Queue.isNetworkError(e)) return;
          // Erreur définitive (clé invalide) : inutile de la garder indéfiniment.
          Queue.remove(item.id);
          return next(i + 1);
        });
    };

    next(0).then(function () {
      queueBusy = false;
      renderQueue();
      if ($('tab-history').classList.contains('active')) renderHistory();
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
  function renderCompare(a, b) {
    var el = $('results');
    function card(x) {
      var name = PROVIDER_NAME[x.provider] || x.provider;
      if (!x.ok) {
        return '<div class="cmp-card cmp-fail"><div class="cmp-name">' + escapeHtml(name) + '</div>' +
               '<div class="cmp-err">⚠️ ' + escapeHtml(x.error || 'Échec') + '</div></div>';
      }
      var r = x.result;
      var parts = partsFrom(r.totalCarbsG);
      var modelLine = r.model ? '<div class="cmp-model">' + escapeHtml(r.model) + '</div>' : '';
      return '<div class="cmp-card">' +
        '<div class="cmp-name">' + escapeHtml(name) + '</div>' +
        modelLine +
        '<div class="cmp-parts">' + fr(parts) + ' <small>parts</small></div>' +
        '<div class="cmp-grams">≈ ' + r.totalCarbsG + ' g</div>' +
        '<div class="cmp-range">' + r.rangeLowG + ' – ' + r.rangeHighG + ' g</div>' +
        '<div class="confidence conf-' + r.overallConfidence + '">' + CONF_LABEL[r.overallConfidence] + '</div>' +
        '<button class="btn btn-primary cmp-use" data-p="' + x.provider + '">Utiliser cet avis →</button>' +
        '</div>';
    }

    var html = '<div class="cmp-head"><h2>Deux avis</h2>' +
      '<p class="hint">Compare les deux estimations. Choisis celle que tu retiens (tu pourras encore corriger les portions).</p></div>';

    // Écart / moyenne quand les deux ont réussi.
    if (a.ok && b.ok) {
      var avg = Math.round((a.result.totalCarbsG + b.result.totalCarbsG) / 2);
      var diff = Math.abs(a.result.totalCarbsG - b.result.totalCarbsG);
      var rel = avg ? diff / avg : 0;
      var pAvg = partsFrom(avg);
      // Divergence notable : > 20 % de la moyenne ET au moins 10 g d'écart.
      var bigGap = rel > 0.20 && diff >= 10;
      if (bigGap) {
        html += '<div class="cmp-warn">⚠️ Les deux IA divergent nettement : ' + diff +
                ' g d\'écart (' + Math.round(rel * 100) + ' %). La moyenne n\'est pas fiable ici — ' +
                'ajoute une photo <strong>de côté</strong> avec un objet-repère et relance, ' +
                'ou regarde le détail par aliment pour trancher toi-même.</div>';
      }
      html += '<div class="cmp-avg' + (bigGap ? ' muted' : '') + '">Moyenne : <strong>' + fr(pAvg) +
              ' parts</strong> (≈ ' + avg + ' g) · écart : ' + diff + ' g' +
              (bigGap ? '' : ' · <span class="cmp-agree">avis concordants ✓</span>') + '</div>';
    }

    html += '<div class="cmp-grid">' + card(a) + card(b) + '</div>';
    el.innerHTML = html;
    el.hidden = false;

    // Stocke les résultats pour la sélection.
    var results = {};
    if (a.ok) results[a.provider] = a.result;
    if (b.ok) results[b.provider] = b.result;

    el.querySelectorAll('.cmp-use').forEach(function (btn) {
      btn.addEventListener('click', function () {
        lastResult = results[btn.dataset.p];
        renderResults(lastResult); // remplace l'affichage par le détail éditable
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
      /* La note du modèle décrit le repas qu'il a analysé. Une fois un dessert
         ou une boisson ajoutés, elle ne les couvre plus : le dire vaut mieux
         que laisser croire qu'elle vaut pour l'ensemble. */
      (r.hasExtras
        ? '<div class="gly-why">Le dessert ou la boisson ajoutés ensuite ne sont pas ' +
          'couverts par cette phrase : un sucre liquide arrive nettement plus vite ' +
          'que le plat.</div>'
        : '') +
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
        ? '<p class="seen-ref">📐 Échelle : ' + escapeHtml(r.referenceUsed) + '</p>' : '') +
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

  function renderResults(r) {
    var el = $('results');
    var parts = partsFrom(r.totalCarbsG);

    var html = '';
    html += '<div class="result-hero">';
    html += '  <div class="hero-parts">' + fr(parts) + ' <small>parts</small></div>';
    html += '  <div class="hero-grams">≈ ' + r.totalCarbsG + ' <small>g de glucides</small></div>';
    html += rangeBarHtml(r.rangeLowG, r.totalCarbsG, r.rangeHighG);
    html += '  <div class="confidence conf-' + r.overallConfidence + '">' + CONF_LABEL[r.overallConfidence] + '</div>';
    html += '  <div class="pump-hint">💉 À saisir dans ta pompe : <strong>' + r.totalCarbsG +
            ' g</strong> (soit <strong>' + fr(parts) + ' parts</strong>). Ta pompe calcule le bolus.</div>';
    /* Estimation sans photo : on le dit franchement. Le chiffre s'affiche
       exactement comme celui d'une photo, et rien à l'écran ne rappellerait
       sinon qu'aucune portion n'a été vue — c'est précisément le moment où
       une vérification vaut le coup. */
    if (r.fromText) {
      html += '<div class="from-text">✍️ Estimé d\'après ta description, sans photo. ' +
        'La taille des portions est supposée, pas mesurée : la fourchette est plus large. ' +
        'Ajoute des quantités pour la resserrer.</div>';
    }
    html += biasHintHtml(r.totalCarbsG, r.items);
    html += glycemicHtml(r);
    html += giHtml(r);
    html += macrosHtml(r);
    html += '</div>';

    html += seenHtml(r);

    // Détail par aliment (grammes éditables)
    html += '<div class="card"><h2>Détail par aliment</h2>';
    html += '<p class="hint">Une portion te semble fausse dans la liste ci-dessus ? Corrige-la ici, le total se recalcule.</p>';
    html += '<div id="items-list"></div></div>';

    html += extrasHtml();

    if (r.notes) {
      html += '<div class="card"><div class="notes-box">📝 ' + escapeHtml(r.notes) + '</div></div>';
    }

    html += '<div class="btn-row">' +
            '<button id="save-result" class="btn btn-primary">💾 Enregistrer dans l\'historique</button>' +
            '<button id="save-meal" class="btn btn-ghost">⭐ Repas fréquent</button>' +
            '</div>';
    html += '<div class="disclaimer-mini">Estimation indicative — vérifie toujours avant de doser.</div>';

    el.innerHTML = html;
    el.hidden = false;
    renderItems();
    initExtras();
    $('save-result').addEventListener('click', saveCurrentResult);
    $('save-meal').addEventListener('click', function () { promptSaveMeal(lastResult.items); });
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------- Dessert et boisson prévus ----------
     Ils ne sont presque jamais sur la photo : on photographie le plat, et le
     yaourt ou le soda arrivent après. Les compter séparément obligerait à
     refaire une estimation ; ils s'ajoutent donc au repas déjà estimé, et le
     total, la charge glycémique et la vitesse d'absorption se recalculent. */
  var DRINK_CHIPS = [
    'un verre de jus d\'orange (20 cl)',
    'une canette de soda (33 cl)',
    'un verre de lait (20 cl)',
    'un verre de vin rouge (12 cl)',
    'une bière (25 cl)'
  ];

  function extrasHtml() {
    return '<div class="card extras-card">' +
      '<h2>➕ Tu prévois autre chose ?</h2>' +
      '<p class="hint">Le dessert et la boisson sont rarement sur la photo. Ajoute-les ici : ils seront comptés dans le total et dans la charge glycémique.</p>' +

      '<label for="extra-dessert">🍰 Dessert</label>' +
      '<input id="extra-dessert" class="input" type="text" ' +
        'placeholder="ex. une part de tarte aux pommes, un yaourt nature…">' +

      '<label for="extra-drink">🥤 Boisson</label>' +
      '<input id="extra-drink" class="input" type="text" ' +
        'placeholder="ex. un verre de jus d\'orange">' +
      '<div id="drink-chips" class="chips extras-chips">' +
        DRINK_CHIPS.map(function (d, i) {
          return '<button type="button" class="chip" data-drink="' + i + '">' +
            escapeHtml(d.replace(/ \(.*\)$/, '')) + '</button>';
        }).join('') +
      '</div>' +
      '<p class="hint tiny">Eau, café ou thé sans sucre, soda light : <strong>0 g</strong>, rien à ajouter.</p>' +

      '<button id="add-extras" class="btn btn-primary">＋ Ajouter au repas</button>' +
      '<div id="extras-status" class="status" hidden></div>' +
      '</div>';
  }

  function initExtras() {
    var chips = $('drink-chips');
    if (chips) {
      chips.querySelectorAll('[data-drink]').forEach(function (b) {
        b.addEventListener('click', function () {
          $('extra-drink').value = DRINK_CHIPS[parseInt(b.dataset.drink, 10)];
        });
      });
    }
    var btn = $('add-extras');
    if (btn) btn.addEventListener('click', addExtras);
  }

  function addExtras() {
    var dessert = ($('extra-dessert').value || '').trim();
    var drink = ($('extra-drink').value || '').trim();
    if (!dessert && !drink) { toast('Écris un dessert ou une boisson à ajouter.'); return; }

    var parts = [];
    if (dessert) parts.push('Dessert : ' + dessert);
    if (drink) parts.push('Boisson : ' + drink);

    var status = $('extras-status'), btn = $('add-extras');
    status.hidden = false;
    status.innerHTML = '<div class="spinner"></div>Estimation du complément…';
    btn.disabled = true;

    /* Estimation en mode DESCRIPTION (aucune image) : ces aliments n'ont pas été
       photographiés, il n'y a rien à mesurer. On n'envoie que le complément,
       jamais le repas déjà estimé — le recompter fausserait le total. */
    Estimator.estimate([], {
      referenceObject: 'none',
      imageCount: 0,
      notes: parts.join('. ') + '.'
    }, settings).then(function (extra) {
      var added = (extra.items || []).filter(function (it) { return it.name; });
      if (!added.length) throw new Error('Rien n\'a pu être estimé à partir de ce texte.');

      /* Marqués comme ajoutés : la carte « Ce que l'IA a vu » ne doit pas les
         présenter comme vus sur la photo, ils ont été saisis après coup. */
      added.forEach(function (it) { it.added = true; });
      lastResult.items = lastResult.items.concat(added);
      lastResult.hasExtras = true;
      recomputeTotal();

      var g = added.reduce(function (s, it) { return s + it.carbsG; }, 0);
      renderResults(lastResult);
      toast(added.length + ' ajouté(s) · +' + g + ' g de glucides.');
    }).catch(function (e) {
      status.hidden = true;
      btn.disabled = false;
      toast(e.message);
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
    Storage.saveMeal(name, items);
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
        '  <div class="item-name">' + escapeHtml(it.name) +
             ' <span class="mini-conf conf-' + it.confidence + '">' +
             (CONF_SHORT[it.confidence] || it.confidence) + '</span></div>' +
        '  <div class="item-detail">' + editControl + '</div>' +
        '</div>' +
        '<div class="item-carb">' + it.carbsG + ' g</div>' +
        '<button class="item-remove" data-rm="' + idx + '" aria-label="Retirer">🗑️</button>';
      list.appendChild(row);
    });

    // Édition des grammes / glucides
    list.querySelectorAll('.item-grams-edit').forEach(function (inp) {
      inp.addEventListener('change', function () {
        var i = parseInt(inp.dataset.i, 10);
        var v = parseFloat(inp.value) || 0;
        if (inp.dataset.carb) {
          lastResult.items[i].carbsG = Math.round(v);
        } else {
          var d = parseFloat(inp.dataset.d);
          lastResult.items[i].estimatedMassG = v;
          lastResult.items[i].carbsG = Math.round(v * d / 100);
        }
        recomputeTotal();
        renderResults(lastResult);
      });
    });
    list.querySelectorAll('.item-remove').forEach(function (b) {
      b.addEventListener('click', function () {
        lastResult.items.splice(parseInt(b.dataset.rm, 10), 1);
        recomputeTotal();
        renderResults(lastResult);
      });
    });
  }

  function saveCurrentResult() {
    var entry = {
      date: Date.now(),
      // Distinguer les trois origines : l'historique et la synthèse médecin
      // n'ont pas la même valeur selon qu'une portion a été vue ou décrite.
      source: lastResult.fromText ? 'texte' : 'photo',
      totalCarbsG: lastResult.totalCarbsG,
      parts: partsFrom(lastResult.totalCarbsG),
      partSizeG: settings.partSizeG,
      glycemicSpeed: lastResult.glycemicSpeed || null,
      gi: lastResult.gi ? { gl: lastResult.gi.gl, gi: lastResult.gi.gi } : null,
      items: lastResult.items.map(function (it) { return { name: it.name, carbsG: it.carbsG }; })
    };
    /* Image de la 1ʳᵉ vue, pour revoir plus tard à quoi ressemblait la portion.
       PWA : une vignette de 320 px en base64, seule taille que le quota de
       localStorage tolère. APK : la photo entière, écrite comme un vrai fichier
       — aucune raison de la dégrader puisqu'il n'y a plus de quota. */
    var first = images[0];
    var prepare;
    if (Native.isApp && first && first.previewUrl) {
      prepare = Native.photos.save('meal-' + entry.date + '.jpg', first.previewUrl)
        .then(function (name) { if (name) entry.photo = name; });
    } else if (first && first.previewUrl && Camera.makeThumb) {
      prepare = Camera.makeThumb(first.previewUrl)
        .then(function (thumb) { if (thumb) entry.thumb = thumb; });
    } else {
      prepare = Promise.resolve();
    }

    var done = function () {
      Storage.addHistory(entry);
      toast('Enregistré dans l\'historique.');
      scheduleReminderFor(entry);
    };
    prepare.then(done, done);   // une image qui échoue ne doit pas perdre le repas
  }

  // ---------- Rappel de contrôle (APK) ----------

  /* Délais par défaut calés sur la vitesse d'absorption déjà estimée par l'IA :
     un repas gras/protéiné pique tard, inutile de contrôler à 1 h. Ce sont des
     moments de MESURE, pas des recommandations de traitement — l'app ne propose
     jamais de dose, c'est la pompe qui dose. */
  var REMIND_DEFAULT_MIN = { rapide: 90, moderee: 120, lente: 180 };

  function humanDelay(min) {
    var h = Math.floor(min / 60), m = min % 60;
    if (!h) return m + ' min';
    return h + ' h' + (m ? ' ' + (m < 10 ? '0' + m : m) : '');
  }

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
      body: 'Repas estimé à ' + entry.totalCarbsG + ' g (' + fr(partsFrom(entry.totalCarbsG)) +
            ' parts) il y a ' + humanDelay(delay) + '. Pense à contrôler.',
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
    renderChips();
    renderFoodResults('');
    renderSavedMeals();
  }

  // ---------- Recherche en ligne (OpenFoodFacts) + code-barres ----------
  var scanBusy = false, lastScanCode = null, lastScanAt = 0;

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
      var code = ($('barcode-manual').value || '').replace(/\D/g, '');
      if (code) processBarcode(code);
      else toast('Saisis un code-barres.');
    });
  }

  function runOffSearch(query) {
    query = (query || '').trim();
    if (query.length < 2) { toast('Tape au moins 2 lettres avant de chercher en ligne.'); return; }
    var status = $('off-status'), box = $('off-results');
    box.hidden = true;
    status.hidden = false;
    status.innerHTML = '<div class="spinner"></div>Recherche « ' + escapeHtml(query) + ' » dans OpenFoodFacts…';
    OFF.search(query).then(function (list) {
      status.hidden = true;
      renderOffResults(list);
    }).catch(function (e) {
      status.hidden = true;
      toast(e.message);
    });
  }

  function renderOffResults(list) {
    var box = $('off-results');
    box.hidden = false;
    if (!list.length) {
      box.innerHTML = '<p class="empty">Aucun produit trouvé en ligne. Essaie un autre mot, ou un code-barres.</p>';
      return;
    }
    box.innerHTML = '<div class="off-head">' + list.length + ' produit(s) en ligne :</div>';
    list.forEach(function (f) {
      var el = document.createElement('div');
      el.className = 'food-item off-item';
      var brand = f.brand ? ' <span class="off-brand">' + escapeHtml(f.brand) + '</span>' : '';
      el.innerHTML =
        '<span class="food-label">' + escapeHtml(f.n) + brand +
        ' <span class="item-detail">(' + fr(f.carb) + ' g/100 g)</span></span>' +
        '<span class="food-actions"><span class="food-add">＋</span></span>';
      var add = function () { addOffFood(f); };
      el.querySelector('.food-label').addEventListener('click', add);
      el.querySelector('.food-add').addEventListener('click', function (e) { e.stopPropagation(); add(); });
      box.appendChild(el);
    });
  }

  // Ajoute un produit OFF au repas (portion = taille de service si connue).
  function addOffFood(f) {
    var portions = f.serving ? [['1 portion', f.serving]] : [];
    var name = f.n + (f.brand ? ' (' + f.brand + ')' : '');
    addFoodToMeal({ n: name, carb: f.carb, portions: portions, custom: false });
  }

  function openBarcode() {
    $('barcode-manual').value = '';
    scanBusy = false; lastScanCode = null; lastScanAt = 0;
    $('barcode-status').hidden = true;
    $('barcode-modal').hidden = false;
    var video = $('barcode-video');
    if (Barcode.supported()) {
      Barcode.start(video, function (code) {
        var now = Date.now();
        if (scanBusy) return;
        if (code === lastScanCode && now - lastScanAt < 3000) return;
        lastScanCode = code; lastScanAt = now;
        processBarcode(code);
      }, function (err) {
        showBarcodeStatus('📷 ' + err.message);
      });
    } else {
      showBarcodeStatus('Scan caméra indisponible ici. Saisis le code-barres à la main ci-dessous.');
    }
  }

  function closeBarcode() {
    try { Barcode.stop(); } catch (e) {}
    scanBusy = false;
    $('barcode-modal').hidden = true;
  }

  function showBarcodeStatus(msg) {
    var s = $('barcode-status');
    s.hidden = false;
    s.innerHTML = msg;
  }

  function processBarcode(code) {
    scanBusy = true;
    showBarcodeStatus('<div class="spinner"></div>Recherche du produit ' + escapeHtml(code) + '…');
    return OFF.lookupBarcode(code).then(function (f) {
      if (!f) {
        showBarcodeStatus('Produit introuvable ou sans glucides connus pour ' + escapeHtml(code) +
          '. Vise à nouveau, ou saisis un autre code.');
        scanBusy = false;
        return;
      }
      closeBarcode();
      addOffFood(f);
      toast(f.n + ' ajouté (' + fr(f.carb) + ' g/100 g).');
    }).catch(function (e) {
      showBarcodeStatus(e.message);
      scanBusy = false;
    });
  }

  // Grammes effectifs d'un aliment du repas (portion × quantité, ou grammes directs).
  function itemGrams(it) {
    if (it.mode === 'grams') return it.grams || 0;
    var p = it.portions[it.portionIndex];
    return (p ? p[1] : 0) * (it.qty || 1);
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
      box.innerHTML = '<p class="empty">Aucun aliment. Essaie une autre recherche ou ajoute un aliment personnalisé ci-dessous.</p>';
      return;
    }
    box.innerHTML = '';
    list.forEach(function (f) {
      var el = document.createElement('div');
      el.className = 'food-item';
      var perso = f.custom ? ' <span class="tag">perso</span>' : '';
      var del = f.custom ? '<button class="food-del" aria-label="Supprimer">🗑️</button>' : '';
      el.innerHTML =
        '<span class="food-label">' + escapeHtml(f.n) + perso +
        ' <span class="item-detail">(' + f.carb + ' g/100 g)</span></span>' +
        '<span class="food-actions">' + del + '<span class="food-add">＋</span></span>';
      el.querySelector('.food-label').addEventListener('click', function () { addFoodToMeal(f); });
      el.querySelector('.food-add').addEventListener('click', function (e) { e.stopPropagation(); addFoodToMeal(f); });
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
    manualItems.push({
      name: f.n, carb: f.carb, custom: !!f.custom,
      portions: portions,
      mode: portions.length ? 'preset' : 'grams',
      portionIndex: 0,
      qty: 1,
      grams: portions.length ? 0 : 100
    });
    Storage.addRecentFood(f); // mémorise pour la catégorie « Récents »
    renderChips();            // fait apparaître/rafraîchir la puce « Récents »
    renderManualItems();
    toast(f.n + ' ajouté.');
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
      return;
    }
    wrap.innerHTML = '';
    manualItems.forEach(function (it, idx) {
      var grams = itemGrams(it);
      var carbs = Math.round(grams * it.carb / 100);

      // Sélecteur de portion : chaque mesure courante + « Grammes… »
      var opts = it.portions.map(function (p, i) {
        var sel = (it.mode === 'preset' && it.portionIndex === i) ? ' selected' : '';
        return '<option value="' + i + '"' + sel + '>' + escapeHtml(p[0]) + ' (' + p[1] + ' g)</option>';
      }).join('');
      opts += '<option value="g"' + (it.mode === 'grams' ? ' selected' : '') + '>Grammes…</option>';

      // Contrôle de quantité : stepper (mode portion) ou champ grammes (mode grammes)
      var control;
      if (it.mode === 'grams') {
        control = '<span class="grams-field"><input class="input small manual-grams" type="number" inputmode="numeric" min="0" step="5" value="' +
                  Math.round(grams) + '" data-i="' + idx + '"> g</span>';
      } else {
        control = '<span class="stepper">' +
                  '<button class="step-btn" data-dec="' + idx + '" aria-label="Moins">−</button>' +
                  '<span class="step-qty">' + (it.qty || 1) + '</span>' +
                  '<button class="step-btn" data-inc="' + idx + '" aria-label="Plus">+</button>' +
                  '</span><span class="grams-eq">= ' + Math.round(grams) + ' g</span>';
      }

      var row = document.createElement('div');
      row.className = 'item-row manual-row';
      row.innerHTML =
        '<div class="item-main">' +
        '  <div class="item-name">' + escapeHtml(it.name) + '</div>' +
        '  <div class="manual-controls">' +
        '    <select class="input small portion-select" data-i="' + idx + '">' + opts + '</select>' +
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
        manualItems[parseInt(inp.dataset.i, 10)].grams = parseFloat(inp.value) || 0;
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
    var total = manualItems.reduce(function (s, it) { return s + itemGrams(it) * it.carb / 100; }, 0);
    total = Math.round(total);
    var parts = partsFrom(total);
    // La charge glycémique du mode manuel sort entièrement de la table locale :
    // aucun appel réseau, donc elle fonctionne aussi hors ligne.
    var giInfo = GI.meal(manualItems.map(function (it) {
      return { name: it.name, carbsG: Math.round(itemGrams(it) * it.carb / 100) };
    }));
    var el = $('manual-total');
    el.innerHTML =
      '<div class="result-hero">' +
      '  <div class="hero-parts">' + fr(parts) + ' <small>parts</small></div>' +
      '  <div class="hero-grams">= ' + total + ' <small>g de glucides</small></div>' +
      '  <div class="pump-hint">💉 À saisir dans ta pompe : <strong>' + total + ' g</strong> (soit <strong>' + fr(parts) + ' parts</strong>).</div>' +
      giHtml({ gi: giInfo }) +
      '  <div class="btn-row" style="margin-top:12px">' +
      '    <button id="save-manual" class="btn btn-primary">💾 Enregistrer</button>' +
      '    <button id="save-manual-meal" class="btn btn-ghost">⭐ Repas fréquent</button>' +
      '  </div>' +
      '</div>';
    el.hidden = false;
    $('save-manual-meal').addEventListener('click', function () {
      promptSaveMeal(manualItems.map(function (it) {
        return { name: it.name, carbsG: Math.round(itemGrams(it) * it.carb / 100) };
      }));
    });
    $('save-manual').addEventListener('click', function () {
      var entry = {
        date: Date.now(), source: 'manuel', totalCarbsG: total,
        parts: parts, partSizeG: settings.partSizeG,
        gi: giInfo ? { gl: giInfo.gl, gi: giInfo.gi } : null,
        items: manualItems.map(function (it) { return { name: it.name, carbsG: Math.round(itemGrams(it) * it.carb / 100) }; })
      };
      Storage.addHistory(entry);
      toast('Enregistré dans l\'historique.');
      // Un repas saisi à la main mérite le même rappel qu'un repas photographié.
      // Faute de vitesse d'absorption estimée par l'IA, le délai reste le défaut.
      scheduleReminderFor(entry);
    });
  }

  // ---------- Historique ----------
  function renderHistory() {
    renderBiasCard();
    var list = $('history-list');
    var h = Storage.getHistory();
    if (!h.length) {
      list.innerHTML = '<p class="empty">Aucune estimation enregistrée.</p>';
      $('clear-history').hidden = true;
      return;
    }
    list.innerHTML = '';

    // Résumé : nombre de repas + moyenne des parts.
    var avgParts = h.reduce(function (s, e) { return s + partsFromStored(e); }, 0) / h.length;
    var summary = document.createElement('div');
    summary.className = 'history-summary';
    summary.innerHTML = h.length + ' repas enregistré' + (h.length > 1 ? 's' : '') +
      ' · moyenne <strong>' + fr(avgParts) + ' parts</strong>';
    list.appendChild(summary);


    h.forEach(function (e) {
      var d = new Date(e.date);
      var dateStr = d.toLocaleDateString('fr-FR') + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      // e.thumb = vignette base64 (PWA) ; e.photo = fichier sur disque (APK).
      var names = (e.items || []).map(function (it) { return it.name; }).join(', ');
      var item = document.createElement('div');
      item.className = 'history-item';

      item.innerHTML =
        '<button class="history-del" data-del="' + e.date + '" aria-label="Supprimer">🗑️</button>' +
        (historyImg(e) ? '<img class="history-thumb" src="' + historyImg(e) + '" alt="photo du repas">' : '') +
        '<div class="history-date">' + dateStr + ' · ' + HISTORY_SOURCE[e.source] || HISTORY_SOURCE.manuel + '</div>' +
        '<div class="history-total"><b>' + fr(partsFromStored(e)) + ' parts</b> · ' + e.totalCarbsG + ' g</div>' +
        (e.gi && e.gi.gl != null
          ? '<div class="history-gi">CG ' + e.gi.gl + ' · ' + GI.glBand(e.gi.gl).label + '</div>' : '') +
        '<div class="item-detail">' + escapeHtml(names || '—') + '</div>' +
        '<div class="history-real-line" data-line="' + e.date + '" hidden></div>' +
        '<div class="history-real">' +
        '  <label>Glucides réels</label>' +
        '  <input class="input small real-input" type="number" inputmode="numeric" min="0" step="1" ' +
        '         placeholder="g" value="' + (e.realCarbsG != null ? e.realCarbsG : '') + '" data-real="' + e.date + '">' +
        '  <span class="real-unit">g</span>' +
        '</div>';
      list.appendChild(item);
      updateRealLine(e.date, e.totalCarbsG, e.realCarbsG);
    });

    list.querySelectorAll('.history-del').forEach(function (b) {
      b.addEventListener('click', function () {
        Storage.deleteHistory(Number(b.dataset.del));
        renderHistory();
      });
    });
    /* Saisie du réel. On met à jour UNIQUEMENT la ligne concernée et la carte de
       biais : re-rendre toute la liste ferait perdre la saisie en cours dans un
       autre champ (le 'change' se déclenche au moment où l'on quitte le champ). */
    list.querySelectorAll('.real-input').forEach(function (inp) {
      var commit = function (announce) {
        var date = Number(inp.dataset.real);
        var v = inp.value.trim();
        var real = v === '' ? null : parseFloat(v);
        if (real != null && (!isFinite(real) || real < 0)) return;
        Storage.setHistoryReal(date, real);
        var entry = Storage.getHistory().filter(function (x) { return x.date === date; })[0];
        if (entry) updateRealLine(date, entry.totalCarbsG, entry.realCarbsG);
        refreshBiasCard();
        if (announce) toast(real == null ? 'Valeur réelle effacée.' : 'Réel enregistré — l\'app apprend ton biais.');
      };
      // Sauvegarde pendant la frappe (rien n'est perdu si l'app est fermée),
      // puis confirmation visible quand on quitte le champ.
      inp.addEventListener('input', function () {
        clearTimeout(inp._t);
        inp._t = setTimeout(function () { commit(false); }, 600);
      });
      inp.addEventListener('change', function () {
        clearTimeout(inp._t);
        commit(true);
      });
    });
    $('clear-history').hidden = false;
  }

  // Met à jour l'écart estimé/réel d'une seule ligne d'historique.
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
      verdict = 'Tes estimations sont <strong>justes</strong> (écart moyen &lt; 5 %). Continue comme ça.';
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
      var verdict = pct < 5 ? '<span class="cat-ok">juste</span>'
        : (g.pct > 0 ? 'sous-estimé de <b>' + pct + ' %</b>' : 'sur-estimé de <b>' + pct + ' %</b>');
      return '<li><span class="cat-name">' + escapeHtml(g.category) + '</span> ' + verdict +
             ' <span class="cat-count">(' + g.count + ' repas)</span></li>';
    }).join('');
    return '<ul class="bias-cats">' + rows + '</ul>';
  }
  // Recalcule les parts avec la taille de part actuelle si elle a changé.
  function partsFromStored(e) { return partsFrom(e.totalCarbsG); }

  function initHistory() {
    $('clear-history').addEventListener('click', function () {
      if (confirm('Vider tout l\'historique ?')) { Storage.clearHistory(); renderHistory(); }
    });
    // La synthèse médecin vivait dans les Réglages, où personne ne la cherchait.
    initReport();
    // Le volet Analyse est recalculé à l'ouverture : le biais bouge à chaque
    // valeur réelle saisie dans le journal.
    initPanes('tab-history', function (pane) {
      if (pane === 'analyse') renderBiasCard();
    });
    initPanes('tab-manual');
  }

  // ---------- Réglages ----------
  var PROVIDER_NAME = { claude: 'Claude', gemini: 'Gemini', openai: 'ChatGPT' };
  var KEY_FIELD = { claude: 'set-key-claude', gemini: 'set-key-gemini', openai: 'set-key-openai' };
  var CUSTOM_VALUE = '__custom__';

  function initSettings() {
    $('open-settings').addEventListener('click', openSettings);
    $('close-settings').addEventListener('click', function () { $('settings-modal').hidden = true; });
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
    });
    // Bascule vers le champ « modèle personnalisé » quand on choisit « Autre modèle… ».
    $('set-model').addEventListener('change', function () {
      $('set-model-custom-wrap').hidden = $('set-model').value !== CUSTOM_VALUE;
    });
    // 2ᵉ avis : afficher/remplir la liste de modèles selon le fournisseur choisi.
    $('set-compare').addEventListener('change', function () {
      var cp = $('set-compare').value;
      var models = settings.models || {};
      populateCompareModelSelect(cp, cp ? (models[cp] || Storage.DEFAULT_MODELS[cp] || '') : '');
    });
    $('set-compare-model').addEventListener('change', function () {
      $('set-compare-model-custom-wrap').hidden = $('set-compare-model').value !== CUSTOM_VALUE;
    });
    var purge = $('purge-photos');
    if (purge) {
      purge.addEventListener('click', function () {
        if (!confirm('Supprimer toutes les photos de l\'historique ?\n\nLes repas et leurs estimations sont conservés.')) return;
        var h = Storage.getHistory();
        h.forEach(function (e) { delete e.photo; delete e.thumb; });
        Storage.replaceHistory(h);
        Storage.prunePhotos(h).then(function () {
          refreshStorageUsage();
          renderHistory();
          toast('Photos supprimées.');
        });
      });
    }
    initBackup();
  }

  // ---------- Sauvegarde / restauration ----------
  function initBackup() {
    $('export-data').addEventListener('click', function () {
      var payload = Storage.exportAll();
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      var d = new Date();
      var stamp = d.getFullYear() + '-' +
                  ('0' + (d.getMonth() + 1)).slice(-2) + '-' +
                  ('0' + d.getDate()).slice(-2);
      // Le nom du fichier dit lui-même qu'il contient des secrets : c'est ce
      // qu'on voit dans le gestionnaire de fichiers avant de le partager.
      a.href = url;
      a.download = (payload.containsApiKeys ? 'glucovision-sauvegarde-PRIVEE-' : 'glucovision-sauvegarde-')
                   + stamp + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      toast(payload.containsApiKeys
        ? '🔑 Sauvegarde exportée AVEC tes clés API. Garde ce fichier pour toi : ne le partage pas et ne l\'envoie pas par mail.'
        : 'Sauvegarde exportée. Range-la ailleurs que sur ce téléphone.');
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
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var restored = Storage.importAll(JSON.parse(reader.result));
          settings = Storage.getSettings();
          renderSavedMeals();
          renderHistory();
          renderChips();
          renderFoodResults($('food-search').value);
          updateCompareToggle();
          $('settings-modal').hidden = true;
          toast('Sauvegarde restaurée (' + restored.length + ' éléments), clés API comprises si le fichier en contenait.');
        } catch (err) {
          toast(err.message || 'Fichier illisible.');
        }
      };
      reader.onerror = function () { toast('Impossible de lire le fichier.'); };
      reader.readAsText(file);
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

  // Menu déroulant des modèles du 2ᵉ AVIS (masqué si aucun 2ᵉ fournisseur).
  function populateCompareModelSelect(provider, current) {
    var wrap = $('set-compare-model-wrap');
    if (!provider) { wrap.hidden = true; return; }
    wrap.hidden = false;
    var matched = fillModelSelect($('set-compare-model'), provider, current);
    var cw = $('set-compare-model-custom-wrap');
    if (!matched && current) {
      $('set-compare-model').value = CUSTOM_VALUE;
      $('set-compare-model-custom').value = current;
      cw.hidden = false;
    } else {
      cw.hidden = true;
      $('set-compare-model-custom').value = '';
    }
    $('set-compare-provider-name').textContent = PROVIDER_NAME[provider] || provider;
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
    $('set-key-claude').value = keys.claude || '';
    $('set-key-gemini').value = keys.gemini || '';
    $('set-key-openai').value = keys.openai || '';
    populateModelSelect(settings.provider, models[settings.provider] || Storage.DEFAULT_MODELS[settings.provider] || '');
    var cp = settings.compareProvider || '';
    $('set-compare').value = cp;
    populateCompareModelSelect(cp, cp ? (models[cp] || Storage.DEFAULT_MODELS[cp] || '') : '');
    $('set-partsize').value = settings.partSizeG;
    $('set-round-half').checked = settings.roundHalf;
    openNativeSettings();
    $('settings-modal').hidden = false;
  }

  /* Réglages qui n'existent que dans l'APK. Les blocs sont dans le HTML commun
     mais restent masqués dans la PWA : rien ne sert de proposer un rappel
     programmé là où le navigateur ne sait pas le déclencher de façon fiable. */
  function openNativeSettings() {
    if (!Native.isApp) return;
    ['set-group-remind', 'set-group-storage', 'keystore-note'].forEach(function (id) {
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
    });
  }

  function saveSettingsFromForm() {
    var provider = $('set-provider').value;
    settings.provider = provider;
    settings.apiKeys = settings.apiKeys || {};
    settings.apiKeys.claude = $('set-key-claude').value.trim();
    settings.apiKeys.gemini = $('set-key-gemini').value.trim();
    settings.apiKeys.openai = $('set-key-openai').value.trim();
    settings.models = settings.models || {};
    settings.models[provider] = getModelFrom('set-model', 'set-model-custom', provider);
    var cmp = $('set-compare').value;
    settings.compareProvider = (cmp && cmp !== provider) ? cmp : '';
    // Modèle choisi pour le 2ᵉ avis (stocké par fournisseur, comme le principal).
    if (settings.compareProvider) {
      settings.models[settings.compareProvider] =
        getModelFrom('set-compare-model', 'set-compare-model-custom', settings.compareProvider);
    }
    var ps = parseInt($('set-partsize').value, 10);
    settings.partSizeG = (ps >= 5 && ps <= 20) ? ps : 10;
    settings.roundHalf = $('set-round-half').checked;

    if (Native.isApp) {
      var wantsRemind = $('set-remind').checked;
      settings.remindDelayMin = parseInt($('set-remind-delay').value, 10) || 0;
      // On demande l'autorisation système au moment où l'utilisateur active
      // l'option, pas au premier lancement : le motif est alors évident.
      if (wantsRemind && !settings.remindEnabled) {
        Native.notify.permission().then(function (ok) {
          settings.remindEnabled = ok;
          Storage.saveSettings(settings);
          if (!ok) toast('Notifications refusées : active-les dans les réglages Android.');
        });
      }
      settings.remindEnabled = wantsRemind;
    }

    Storage.saveSettings(settings);
    $('settings-modal').hidden = true;
    updateCompareToggle();
    toast('Réglages enregistrés.');
  }

  // Affiche la case « 2ᵉ avis » sur l'écran Photo si un 2ᵉ fournisseur est configuré.
  function updateCompareToggle() {
    var wrap = $('compare-wrap');
    if (!wrap) return;
    var cmp = settings.compareProvider;
    if (cmp && cmp !== settings.provider) {
      wrap.hidden = false;
      $('compare-label').textContent = '🔬 Demander un 2ᵉ avis (' +
        (PROVIDER_NAME[settings.provider] || settings.provider) + ' + ' +
        (PROVIDER_NAME[cmp] || cmp) + ')';
    } else {
      wrap.hidden = true;
      var cb = $('compare-toggle');
      if (cb) cb.checked = false;
    }
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

      Native.shareFile(name, r.html, title).then(function (ok) {
        // Sur le web (et si le partage natif échoue) : téléchargement classique.
        if (ok) return;
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([r.html], { type: 'text/html' }));
        a.download = name;
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 30000);
        toast('Synthèse téléchargée.');
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
      apply();
    };
  }

  /* Mises à jour du contenu web de l'APK (OTA).
     Sans ça, chaque version imposerait de retélécharger et réinstaller l'APK.
     Seul un changement de plugin NATIF impose encore un nouvel APK. */
  var OTA_MANIFEST =
    'https://github.com/rachid598/Diab-te/releases/download/ota-latest/latest.json';

  function initNativeUpdate() {
    if (!Native.isApp) return;
    var run = function () {
      Native.update.check(OTA_MANIFEST, APP_VERSION).then(function (info) {
        if (!info) return null;
        return Native.update.download(info);
      }).then(function (bundle) {
        if (bundle) showUpdate(function () { Native.update.apply(bundle); });
      }).catch(function () { /* hors ligne : on retentera */ });
    };
    run();
    setInterval(run, 6 * 60 * 60 * 1000);
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

  function showVersion() {
    var el = $('app-version');
    if (el) {
      el.textContent = 'Version ' + APP_VERSION + ' · GlucoVision' +
        (Native.isApp ? ' · application Android' : '');
    }
  }

  // ---------- Init ----------
  function init() {
    // Relu APRÈS l'hydratation : sur l'APK les clés API viennent du Keystore.
    settings = Storage.getSettings();
    showVersion();
    initInstall();
    initSafetyBanner();
    initTabs();
    initPhotos();
    initModeSwitch();
    initEstimate();
    initManual();
    initHistory();
    initSettings();
    updateCompareToggle();
    renderThumbs();
    updateEstimateBtn();
    registerSW();
    initNativeUpdate();
    initQueue();
    initShortcuts();
    // Rattrape les images orphelines laissées par un enregistrement interrompu.
    if (Native.isApp) Storage.prunePhotos();
  }

  /* On attend que le pont natif soit prêt AVANT le premier rendu : les clés API
     doivent être déchiffrées et l'URL de base des photos connue, sinon la
     première ouverture afficherait des réglages vides et un historique sans
     images. Native.ready() a son propre garde-fou de 3 s et ne peut pas bloquer
     le démarrage ; dans le navigateur il se résout immédiatement. */
  document.addEventListener('DOMContentLoaded', function () {
    Native.ready()
      .then(function () { return Storage.hydrate(); })
      .then(init, init);
  });
})();
