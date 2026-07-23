/* app.js — orchestration de l'interface. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
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
    toast._t = setTimeout(function () { t.hidden = true; }, 3200);
  }

  var CONF_LABEL = { high: 'Confiance élevée', medium: 'Confiance moyenne', low: 'Confiance faible' };

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
  }

  function updateEstimateBtn() {
    $('estimate-btn').disabled = images.length === 0;
  }

  function addFiles(files) {
    var room = Camera.MAX_ANGLES - images.length;
    if (room <= 0) { toast('Maximum ' + Camera.MAX_ANGLES + ' angles.'); return; }
    var slice = Array.prototype.slice.call(files, 0, room);
    Camera.processFiles(slice).then(function (results) {
      results.forEach(function (r) { images.push(r); });
      renderThumbs();
      updateEstimateBtn();
    }).catch(function (e) { toast(e.message); });
  }

  function initPhotos() {
    $('camera-input').addEventListener('change', function (e) {
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
    status.innerHTML = '<div class="spinner"></div>Analyse en cours… (identification, portions, glucides)';
    $('estimate-btn').disabled = true;

    var ctx = {
      referenceObject: $('reference-object').value,
      plateDiameterCm: $('plate-diameter').value ? parseFloat($('plate-diameter').value) : null,
      notes: $('user-notes').value,
      imageCount: images.length
    };

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

  function renderResults(r) {
    var el = $('results');
    var parts = partsFrom(r.totalCarbsG);
    var partsLow = partsFrom(r.rangeLowG);
    var partsHigh = partsFrom(r.rangeHighG);

    var html = '';
    html += '<div class="result-hero">';
    html += '  <div class="hero-parts">' + fr(parts) + ' <small>parts</small></div>';
    html += '  <div class="hero-grams">≈ ' + r.totalCarbsG + ' g de glucides</div>';
    html += '  <div class="hero-range">Fourchette : ' + r.rangeLowG + '–' + r.rangeHighG +
            ' g&nbsp;·&nbsp;' + fr(partsLow) + '–' + fr(partsHigh) + ' parts</div>';
    html += '  <div class="confidence conf-' + r.overallConfidence + '">' + CONF_LABEL[r.overallConfidence] + '</div>';
    html += '  <div class="pump-hint">💉 À saisir dans ta pompe : <strong>' + r.totalCarbsG +
            ' g</strong> (soit <strong>' + fr(parts) + ' parts</strong>). Ta pompe calcule le bolus.</div>';
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
             ' <span class="confidence conf-' + it.confidence + '" style="margin:0">' + it.confidence + '</span></div>' +
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
  function initManual() {
    var search = $('food-search');
    search.addEventListener('input', function () { renderFoodResults(search.value); });
    renderFoodResults('');
  }

  function renderFoodResults(q) {
    var box = $('food-results');
    var list = Foods.search(q);
    if (!list.length) { box.innerHTML = '<p class="empty">Aucun aliment trouvé. Utilise le mode photo ou ajuste ta recherche.</p>'; return; }
    box.innerHTML = '';
    list.forEach(function (f) {
      var el = document.createElement('div');
      el.className = 'food-item';
      el.innerHTML = '<span>' + escapeHtml(f.n) + ' <span class="item-detail">(' + f.carb + ' g/100 g)</span></span>' +
                     '<span class="food-add">+ ajouter</span>';
      el.addEventListener('click', function () {
        manualItems.push({ name: f.n, carb: f.carb, grams: f.portion });
        renderManualItems();
        toast(f.n + ' ajouté (' + f.portion + ' g)');
      });
      box.appendChild(el);
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
      var carbs = Math.round(it.grams * it.carb / 100);
      var row = document.createElement('div');
      row.className = 'item-row';
      row.innerHTML =
        '<div class="item-main">' +
        '  <div class="item-name">' + escapeHtml(it.name) + '</div>' +
        '  <div class="item-detail"><input class="input small manual-grams" type="number" min="0" step="5" value="' +
             it.grams + '" data-i="' + idx + '"> g × ' + it.carb + ' g/100 g</div>' +
        '</div>' +
        '<div class="item-carb">' + carbs + ' g</div>' +
        '<button class="item-remove" data-rm="' + idx + '" aria-label="Retirer">🗑️</button>';
      wrap.appendChild(row);
    });
    wrap.querySelectorAll('.manual-grams').forEach(function (inp) {
      inp.addEventListener('change', function () {
        manualItems[parseInt(inp.dataset.i, 10)].grams = parseFloat(inp.value) || 0;
        renderManualItems();
      });
    });
    wrap.querySelectorAll('.item-remove').forEach(function (b) {
      b.addEventListener('click', function () {
        manualItems.splice(parseInt(b.dataset.rm, 10), 1);
        renderManualItems();
      });
    });
    renderManualTotal();
  }

  function renderManualTotal() {
    var total = manualItems.reduce(function (s, it) { return s + it.grams * it.carb / 100; }, 0);
    total = Math.round(total);
    var parts = partsFrom(total);
    var el = $('manual-total');
    el.innerHTML =
      '<div class="result-hero">' +
      '  <div class="hero-parts">' + fr(parts) + ' <small>parts</small></div>' +
      '  <div class="hero-grams">= ' + total + ' g de glucides</div>' +
      '  <div class="pump-hint">💉 À saisir dans ta pompe : <strong>' + total + ' g</strong> (soit <strong>' + fr(parts) + ' parts</strong>).</div>' +
      '  <div class="btn-row" style="margin-top:12px"><button id="save-manual" class="btn btn-primary">💾 Enregistrer</button></div>' +
      '</div>';
    el.hidden = false;
    $('save-manual').addEventListener('click', function () {
      Storage.addHistory({
        date: Date.now(), source: 'manuel', totalCarbsG: total,
        parts: parts, partSizeG: settings.partSizeG,
        items: manualItems.map(function (it) { return { name: it.name, carbsG: Math.round(it.grams * it.carb / 100) }; })
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
    h.forEach(function (e) {
      var d = new Date(e.date);
      var dateStr = d.toLocaleDateString('fr-FR') + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      var names = (e.items || []).map(function (it) { return it.name; }).join(', ');
      var item = document.createElement('div');
      item.className = 'history-item';
      item.innerHTML =
        '<div class="history-date">' + dateStr + ' · ' + (e.source === 'photo' ? '📷 photo' : '✍️ manuel') + '</div>' +
        '<div class="history-total">' + fr(partsFromStored(e)) + ' parts · ' + e.totalCarbsG + ' g</div>' +
        '<div class="item-detail">' + escapeHtml(names) + '</div>';
      list.appendChild(item);
    });
    $('clear-history').hidden = false;
  }
  // Recalcule les parts avec la taille de part actuelle si elle a changé.
  function partsFromStored(e) { return partsFrom(e.totalCarbsG); }

  function initHistory() {
    $('clear-history').addEventListener('click', function () {
      if (confirm('Vider tout l\'historique ?')) { Storage.clearHistory(); renderHistory(); }
    });
  }

  // ---------- Réglages ----------
  function initSettings() {
    $('open-settings').addEventListener('click', openSettings);
    $('close-settings').addEventListener('click', function () { $('settings-modal').hidden = true; });
    $('save-settings').addEventListener('click', saveSettingsFromForm);
    $('clear-key').addEventListener('click', function () {
      $('set-apikey').value = '';
      settings.apiKey = '';
      Storage.saveSettings(settings);
      toast('Clé effacée.');
    });
    $('set-provider').addEventListener('change', function () {
      updateProviderHints($('set-provider').value, true);
    });
  }

  function updateProviderHints(provider, resetModel) {
    if (provider === 'openai') {
      $('apikey-hint').innerHTML = 'Crée une clé sur <strong>platform.openai.com/api-keys</strong>.';
      $('model-hint').textContent = 'Ex. gpt-4o (vision). Pas « codex » : il ne lit pas les images.';
      if (resetModel) $('set-model').value = Storage.DEFAULT_MODELS.openai;
    } else {
      $('apikey-hint').innerHTML = 'Crée une clé sur <strong>console.anthropic.com</strong>.';
      $('model-hint').textContent = 'Recommandé : claude-sonnet-5. Pour un max de précision : claude-opus-4-8.';
      if (resetModel) $('set-model').value = Storage.DEFAULT_MODELS.claude;
    }
  }

  function openSettings() {
    settings = Storage.getSettings();
    $('set-provider').value = settings.provider;
    $('set-apikey').value = settings.apiKey;
    $('set-model').value = settings.model;
    $('set-partsize').value = settings.partSizeG;
    $('set-round-half').checked = settings.roundHalf;
    updateProviderHints(settings.provider, false);
    $('settings-modal').hidden = false;
  }

  function saveSettingsFromForm() {
    settings.provider = $('set-provider').value;
    settings.apiKey = $('set-apikey').value.trim();
    settings.model = $('set-model').value.trim() || Storage.DEFAULT_MODELS[settings.provider];
    var ps = parseInt($('set-partsize').value, 10);
    settings.partSizeG = (ps >= 5 && ps <= 20) ? ps : 10;
    settings.roundHalf = $('set-round-half').checked;
    Storage.saveSettings(settings);
    $('settings-modal').hidden = true;
    toast('Réglages enregistrés.');
  }

  // ---------- Divers ----------
  function escapeHtml(s) {
    return (s || '').toString()
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function registerSW() {
    if ('serviceWorker' in navigator) {
      // Recharge une seule fois quand une nouvelle version prend le contrôle,
      // pour que les correctifs s'appliquent sans manip du côté utilisateur.
      var refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (refreshing) return;
        refreshing = true;
        window.location.reload();
      });
      navigator.serviceWorker.register('service-worker.js').then(function (reg) {
        if (reg && reg.update) { try { reg.update(); } catch (e) {} }
      }).catch(function () {});
    }
  }

  // ---------- Init ----------
  function init() {
    initSafetyBanner();
    initTabs();
    initPhotos();
    initEstimate();
    initManual();
    initHistory();
    initSettings();
    renderThumbs();
    updateEstimateBtn();
    registerSW();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
