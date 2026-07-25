/* app.js — orchestration de l'interface. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var APP_VERSION = '21'; // à garder synchro avec la version du service worker
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

  function updateEstimateBtn() {
    $('estimate-btn').disabled = images.length === 0;
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

  function initPhotos() {
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

    var ctx = {
      referenceObject: $('reference-object').value,
      plateDiameterCm: $('plate-diameter').value ? parseFloat($('plate-diameter').value) : null,
      notes: $('user-notes').value,
      imageCount: images.length
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
        return Estimator.estimateWith(p, images, ctx, settings)
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

    status.innerHTML = '<div class="spinner"></div>Analyse en cours… mesure des portions via le repère, calcul des glucides. Le raisonnement approfondi peut prendre 10 à 30 s.';
    Estimator.estimate(images, ctx, settings).then(function (result) {
      lastResult = result;
      status.hidden = true;
      renderResults(result);
    }).catch(function (e) {
      status.hidden = true;
      toast(e.message);
    }).then(function () {
      updateEstimateBtn();
    });
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
  function recomputeTotal() {
    var total = lastResult.items.reduce(function (s, it) { return s + it.carbsG; }, 0);
    lastResult.totalCarbsG = Math.round(total);
    // Fourchette proportionnelle conservée autour du nouveau total.
    var conf = lastResult.overallConfidence;
    var spread = conf === 'high' ? 0.12 : conf === 'medium' ? 0.22 : 0.35;
    lastResult.rangeLowG = Math.max(0, Math.round(total * (1 - spread)));
    lastResult.rangeHighG = Math.round(total * (1 + spread));
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
     Purement informatif : on NE corrige PAS le chiffre automatiquement — c'est à
     l'utilisateur d'ajuster s'il le juge pertinent. */
  function biasHintHtml(totalG) {
    var bias = Storage.getBias();
    if (bias.count < 3 || Math.abs(bias.pct) < 5) return '';
    var adjusted = Math.round(totalG * bias.meanRatio);
    var sens = bias.pct > 0 ? 'sous-estimes' : 'sur-estimes';
    return '<div class="bias-hint">🎯 D\'après tes ' + bias.count + ' repas corrigés, tu ' + sens +
      ' d\'environ ' + Math.abs(bias.pct) + ' % : le réel serait plutôt autour de <strong>' +
      adjusted + ' g</strong> (' + fr(partsFrom(adjusted)) + ' parts). À toi de juger.</div>';
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
    html += biasHintHtml(r.totalCarbsG);
    html += '</div>';

    // Détail par aliment (grammes éditables)
    html += '<div class="card"><h2>Détail par aliment</h2>';
    html += '<p class="hint">Corrige une portion si elle te semble fausse : le total se recalcule.</p>';
    html += '<div id="items-list"></div></div>';

    if (r.notes) {
      html += '<div class="card"><div class="notes-box">📝 ' + escapeHtml(r.notes) + '</div></div>';
    }

    html += '<div class="btn-row"><button id="save-result" class="btn btn-primary">💾 Enregistrer dans l\'historique</button></div>';
    html += '<div class="disclaimer-mini">Estimation indicative — vérifie toujours avant de doser.</div>';

    el.innerHTML = html;
    el.hidden = false;
    renderItems();
    $('save-result').addEventListener('click', saveCurrentResult);
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
      var detail = it.portionDescription || '';
      if (it.assumptions) detail += (detail ? ' · ' : '') + it.assumptions;

      var editControl = editableGrams
        ? '<input class="input small item-grams-edit" type="number" min="0" step="5" value="' +
          Math.round(it.estimatedMassG) + '" data-i="' + idx + '" data-d="' + density + '"> g'
        : '<input class="input small item-grams-edit" type="number" min="0" step="1" value="' +
          it.carbsG + '" data-i="' + idx + '" data-carb="1"> g gluc.';

      row.innerHTML =
        '<div class="item-main">' +
        '  <div class="item-name">' + escapeHtml(it.name) +
             ' <span class="mini-conf conf-' + it.confidence + '">' + it.confidence + '</span></div>' +
        '  <div class="item-detail">' + escapeHtml(detail) + '</div>' +
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
    Storage.addHistory({
      date: Date.now(),
      source: 'photo',
      totalCarbsG: lastResult.totalCarbsG,
      parts: partsFrom(lastResult.totalCarbsG),
      partSizeG: settings.partSizeG,
      items: lastResult.items.map(function (it) { return { name: it.name, carbsG: it.carbsG }; })
    });
    toast('Enregistré dans l\'historique.');
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
  }

  // ---------- Recherche en ligne (OpenFoodFacts) + code-barres ----------
  var scanBusy = false, lastScanCode = null, lastScanAt = 0;

  function initOnlineTools() {
    $('off-search-btn').addEventListener('click', function () { runOffSearch($('food-search').value); });
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
    var el = $('manual-total');
    el.innerHTML =
      '<div class="result-hero">' +
      '  <div class="hero-parts">' + fr(parts) + ' <small>parts</small></div>' +
      '  <div class="hero-grams">= ' + total + ' <small>g de glucides</small></div>' +
      '  <div class="pump-hint">💉 À saisir dans ta pompe : <strong>' + total + ' g</strong> (soit <strong>' + fr(parts) + ' parts</strong>).</div>' +
      '  <div class="btn-row" style="margin-top:12px"><button id="save-manual" class="btn btn-primary">💾 Enregistrer</button></div>' +
      '</div>';
    el.hidden = false;
    $('save-manual').addEventListener('click', function () {
      Storage.addHistory({
        date: Date.now(), source: 'manuel', totalCarbsG: total,
        parts: parts, partSizeG: settings.partSizeG,
        items: manualItems.map(function (it) { return { name: it.name, carbsG: Math.round(itemGrams(it) * it.carb / 100) }; })
      });
      toast('Enregistré dans l\'historique.');
    });
  }

  // ---------- Historique ----------
  function renderHistory() {
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

    // Apprentissage : biais personnel calculé sur les repas où le réel est saisi.
    list.appendChild(buildBiasCard());

    h.forEach(function (e) {
      var d = new Date(e.date);
      var dateStr = d.toLocaleDateString('fr-FR') + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      var names = (e.items || []).map(function (it) { return it.name; }).join(', ');
      var item = document.createElement('div');
      item.className = 'history-item';

      item.innerHTML =
        '<button class="history-del" data-del="' + e.date + '" aria-label="Supprimer">🗑️</button>' +
        '<div class="history-date">' + dateStr + ' · ' + (e.source === 'photo' ? '📷 photo' : '✍️ manuel') + '</div>' +
        '<div class="history-total"><b>' + fr(partsFromStored(e)) + ' parts</b> · ' + e.totalCarbsG + ' g</div>' +
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
  function refreshBiasCard() {
    var old = document.querySelector('.bias-card');
    if (old && old.parentNode) old.parentNode.replaceChild(buildBiasCard(), old);
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
      '<div class="bias-meta">Calculé sur ' + bias.count + ' repas avec valeur réelle. ' +
      'Indicatif — ne remplace pas ton jugement.</div>';
    return card;
  }
  // Recalcule les parts avec la taille de part actuelle si elle a changé.
  function partsFromStored(e) { return partsFrom(e.totalCarbsG); }

  function initHistory() {
    $('clear-history').addEventListener('click', function () {
      if (confirm('Vider tout l\'historique ?')) { Storage.clearHistory(); renderHistory(); }
    });
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
    $('settings-modal').hidden = false;
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

  // ---------- Divers ----------
  function escapeHtml(s) {
    return (s || '').toString()
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Affiche le bandeau « Actualiser » et câble le bouton sur le worker en attente.
  function showUpdate(worker) {
    var banner = $('update-banner');
    if (!banner || !worker) return;
    banner.hidden = false;
    var btn = $('update-btn');
    btn.onclick = function () {
      btn.disabled = true;
      btn.textContent = 'Mise à jour…';
      worker.postMessage('SKIP_WAITING'); // le nouveau worker prend le relais → reload
    };
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;

    // Quand la nouvelle version prend le contrôle, on recharge une seule fois.
    var refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });

    navigator.serviceWorker.register('service-worker.js').then(function (reg) {
      // Une version est déjà en attente au chargement.
      if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);

      // Une nouvelle version vient d'être trouvée et installée.
      reg.addEventListener('updatefound', function () {
        var nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', function () {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdate(nw);
          }
        });
      });

      // Vérifie périodiquement s'il y a une mise à jour (sessions longues).
      setInterval(function () { try { reg.update(); } catch (e) {} }, 60 * 60 * 1000);
    }).catch(function () {});
  }

  function showVersion() {
    var el = $('app-version');
    if (el) el.textContent = 'Version ' + APP_VERSION + ' · GlucoVision';
  }

  // ---------- Init ----------
  function init() {
    showVersion();
    initInstall();
    initSafetyBanner();
    initTabs();
    initPhotos();
    initEstimate();
    initManual();
    initHistory();
    initSettings();
    updateCompareToggle();
    renderThumbs();
    updateEstimateBtn();
    registerSW();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
