/* estimator.js — moteur d'estimation des glucides.
   Appelle directement l'API de vision (Claude ou OpenAI) depuis le navigateur.
   La clé et les photos ne partent que vers le fournisseur choisi. */
(function () {
  'use strict';

  // -------- Prompt système : cadre le raisonnement pour minimiser l'erreur --------
  var SYSTEM_PROMPT = [
    "Tu es un assistant de nutrition clinique expert du COMPTAGE DES GLUCIDES pour",
    "l'insulinothérapie fonctionnelle (diabète de type 1). Un patient dose son insuline",
    "d'après ton estimation : sois RIGOUREUX et DÉCISIF, pas vaguement prudent.",
    "Ta mission : estimer la quantité TOTALE de glucides (g), aliment par aliment.",
    "",
    "MÉTHODE OBLIGATOIRE (raisonne étape par étape) :",
    "",
    "A. CALIBRATION DE L'ÉCHELLE (déterminante).",
    "   Si un objet-repère de dimension CONNUE est fourni (ex. pompe à insuline 96×55 mm,",
    "   carte 85 mm, pièce, diamètre d'assiette) : repère-le dans l'image et déduis l'échelle",
    "   réelle (cm par pixel). Puis MESURE chaque aliment en cm (longueur, largeur, et",
    "   diamètre/épaisseur visibles). Indique ces mesures dans 'assumptions'.",
    "   ⇒ Quand le repère est présent et exploitable, l'erreur sur la TAILLE (longueur/largeur/",
    "   surface au sol) devient FAIBLE. NE GONFLE PAS l'incertitude pour ce que le repère",
    "   permet de mesurer. La fourchette ne doit refléter QUE les facteurs réellement non",
    "   résolubles (voir E).",
    "",
    "B. TROISIÈME DIMENSION (hauteur/épaisseur).",
    "   Avec plusieurs angles : croise-les pour juger le volume précisément (confiance haute).",
    "   Avec une seule vue de dessus : tu ne vois pas directement la hauteur — estime-la à",
    "   partir d'indices (ombres, empilement, type d'aliment) et considère-la comme la",
    "   principale inconnue géométrique de cet aliment (une vue de côté la lèverait).",
    "",
    "C. VOLUME → MASSE via la densité et la consistance (riz aéré vs compact, mie de pain",
    "   aérée vs dense, aliment frit gorgé d'huile, sauce). Recoupe avec des portions types",
    "   plausibles (ex. une baguette entière ≈ 250 g de pain ≈ 130–150 g de glucides ; une",
    "   ½ baguette ≈ 65–75 g de glucides ; un bol de riz cuit ≈ 40 g).",
    "",
    "D. glucides_aliment = masse_g × densité_glucidique(g/100g de l'aliment TEL QUE consommé)",
    "   /100. N'oublie pas les glucides CACHÉS : sauces sucrées, panure, chapelure,",
    "   vinaigrette sucrée, sucre, boisson sucrée. Protéines pures et huile ≈ 0 g.",
    "",
    "E. INCERTITUDE — resserre-la au maximum honnête :",
    "   - Donne UN meilleur point d'estimation (pas un chiffre gonflé « par sécurité »).",
    "   - rangeLowG/rangeHighG ne couvrent QUE les facteurs non résolus : densité interne",
    "     (mie du pain), hauteur non vue en photo unique, présence/quantité de sucre caché.",
    "   - Repère fiable + repas simple + un seul aliment glucidique dominant bien mesuré",
    "     ⇒ fourchette serrée (typiquement ±10–15 %) et overallConfidence 'high'.",
    "   - Ne baisse la confiance d'un aliment que si un vrai facteur non résolu le domine.",
    "   - Dans 'notes' : nomme LE facteur qui pèse le plus et l'action concrète pour l'affiner",
    "     (ex. « confirme si baguette entière ou demie »), pas des généralités.",
    "",
    "F. VITESSE D'ABSORPTION DU REPAS (caractérise le REPAS, ne prédis JAMAIS une glycémie).",
    "   Juge à quelle vitesse les glucides de CE repas passent typiquement dans le sang :",
    "   - 'rapide' : glucides à index glycémique élevé, peu de gras/fibres/protéines",
    "     (boisson sucrée, pain blanc seul, bonbons, purée, fruit très mûr).",
    "   - 'moderee' : repas mixte équilibré, féculents avec un peu de gras/protéines/légumes.",
    "   - 'lente' : beaucoup de gras et/ou de protéines, ou glucides à IG bas et riches en",
    "     fibres (pizza, friture, plat en sauce, légumineuses, pâtes al dente + huile).",
    "     Le gras ralentit la vidange gastrique : la montée est RETARDÉE et ÉTALÉE.",
    "   Dans 'glycemicNote' : une phrase en français expliquant CE QUI, dans ce repas,",
    "   détermine cette vitesse (l'aliment ou le facteur responsable). Pas de conseil de dose.",
    "",
    "G. MACRONUTRIMENTS : estime aussi protéines, lipides et calories par aliment.",
    "   Ils servent à expliquer la vitesse d'absorption (F). Reste cohérent :",
    "   kcal ≈ 4×glucides + 4×protéines + 9×lipides.",
    "",
    "SORTIE : réponds UNIQUEMENT avec un objet JSON valide, sans texte ni balises markdown.",
    "Schéma exact :",
    "{",
    '  "items": [',
    '    {',
    '      "name": "nom court en français",',
    '      "portionDescription": "portion + dimensions mesurées (ex: baguette ~55 cm ≈ 220 g)",',
    '      "estimatedMassG": nombre,',
    '      "carbDensityPer100g": nombre,',
    '      "carbsG": nombre,',
    '      "proteinG": nombre,',
    '      "fatG": nombre,',
    '      "kcal": nombre,',
    '      "confidence": "low" | "medium" | "high",',
    '      "assumptions": "mesures via le repère + hypothèses clés, en français"',
    '    }',
    '  ],',
    '  "totalCarbsG": nombre,',
    '  "rangeLowG": nombre,',
    '  "rangeHighG": nombre,',
    '  "overallConfidence": "low" | "medium" | "high",',
    '  "glycemicSpeed": "rapide" | "moderee" | "lente",',
    '  "glycemicNote": "ce qui, dans ce repas, détermine la vitesse d\'absorption",',
    '  "notes": "LE facteur d\'incertitude dominant + action concrète pour l\'affiner",',
    '  "referenceUsed": "objet-repère utilisé et échelle déduite (ex: pompe 96 mm → 0,3 cm/px)"',
    "}"
  ].join('\n');

  function buildUserPrompt(ctx) {
    var lines = ['Analyse ce repas et estime les glucides selon la méthode.'];
    if (ctx.referenceObject && ctx.referenceObject !== 'none') {
      var ref = ctx.referenceObject;
      if (ctx.plateDiameterCm) {
        ref = 'assiette de ' + ctx.plateDiameterCm + ' cm de diamètre';
      }
      lines.push('OBJET-REPÈRE présent, de dimension connue : ' + ref + '.');
      lines.push('Calibre l\'échelle à partir de ce repère, MESURE chaque aliment en cm, et');
      lines.push('reporte les mesures dans "assumptions". Comme la taille est mesurée, la');
      lines.push('fourchette ne doit couvrir que la densité/hauteur/sucre caché, pas la taille.');
    } else {
      lines.push('Aucun objet-repère : estime l\'échelle via l\'assiette/les couverts et baisse la confiance.');
    }
    if (ctx.imageCount > 1) {
      lines.push('Il y a ' + ctx.imageCount + ' angles du MÊME repas : croise-les pour le volume (hauteur incluse).');
    } else {
      lines.push('Une seule vue : tu ne vois pas directement la hauteur/épaisseur — estime-la et');
      lines.push('signale-la comme seule inconnue géométrique (une photo de côté la lèverait).');
    }
    if (ctx.notes && ctx.notes.trim()) {
      lines.push('Précisions de l\'utilisateur (fiables, à intégrer) : ' + ctx.notes.trim());
    }
    lines.push('Réponds uniquement avec le JSON.');
    return lines.join('\n');
  }

  // -------- Extraction robuste du JSON dans la réponse --------
  function parseJson(text) {
    if (!text) throw new Error('Réponse vide du modèle.');
    var t = text.trim();
    // Retire d'éventuelles balises ```json ... ```
    t = t.replace(/^```(?:json)?/i, '').replace(/```$/,'').trim();
    try { return JSON.parse(t); } catch (e) {}
    // Sinon, isole le premier objet { ... }
    var start = t.indexOf('{');
    var end = t.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(t.slice(start, end + 1));
    }
    throw new Error('Impossible de lire la réponse du modèle.');
  }

  // -------- Appels API --------
  // fetch avec délai maximal : évite un spinner qui tourne à l'infini si le
  // réseau traîne ou si le modèle reste bloqué. 120 s laisse le temps au
  // raisonnement approfondi (Opus) tout en garantissant une sortie d'erreur.
  var REQUEST_TIMEOUT_MS = 120000;
  function fetchWithTimeout(url, options, ms) {
    ms = ms || REQUEST_TIMEOUT_MS;
    if (typeof AbortController === 'undefined') return fetch(url, options);
    var ctrl = new AbortController();
    var id = setTimeout(function () { ctrl.abort(); }, ms);
    var opts = Object.assign({}, options, { signal: ctrl.signal });
    return fetch(url, opts).then(function (r) {
      clearTimeout(id);
      return r;
    }, function (err) {
      clearTimeout(id);
      if (err && err.name === 'AbortError') {
        throw new Error('Délai dépassé (' + Math.round(ms / 1000) +
          ' s) : réseau lent ou modèle occupé. Réessaie, réduis le nombre de photos, ou choisis un modèle plus rapide.');
      }
      throw new Error('Réseau indisponible. Vérifie ta connexion puis réessaie.');
    });
  }

  /* Le raisonnement adaptatif ("thinking") améliore l'estimation géométrique, mais
     n'est supporté que par les modèles récents. On l'active seulement pour ceux-là.
     ⚠️ Sur ces modèles, la réflexion et la réponse se partagent le même max_tokens :
     un plafond trop bas tronque le JSON en plein milieu et fait échouer l'estimation.
     On laisse donc une marge large — on ne paie que les tokens réellement produits. */
  function supportsAdaptiveThinking(model) {
    return /(opus-5)|(opus-4-[678])|(sonnet-5)|(sonnet-4-6)|(fable-5)/.test(model || '');
  }
  var THINKING_MAX_TOKENS = 8000;

  function callClaude(images, prompt, settings) {
    var content = images.map(function (img) {
      return {
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.base64 }
      };
    });
    content.push({ type: 'text', text: prompt });

    var model = settings.model || 'claude-sonnet-5';
    var body = {
      model: model,
      max_tokens: 2400,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: content }]
    };
    // Raisonnement approfondi pour une estimation de volume plus fiable (modèles compatibles).
    if (supportsAdaptiveThinking(model)) {
      body.thinking = { type: 'adaptive' };
      body.max_tokens = THINKING_MAX_TOKENS;
    }

    return fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(body)
    }).then(handleResponse).then(function (data) {
      if (data.error) throw new Error(data.error.message || 'Erreur API Claude.');
      // On ne garde que les blocs texte (les blocs "thinking" sont ignorés).
      var text = (data.content || []).map(function (b) {
        return (b && b.type === 'text' && b.text) ? b.text : '';
      }).join('');
      return parseJson(text);
    });
  }

  function callGemini(images, prompt, settings) {
    var parts = images.map(function (img) {
      return { inline_data: { mime_type: img.mediaType, data: img.base64 } };
    });
    parts.push({ text: prompt });
    var model = settings.model || 'gemini-2.0-flash';
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(settings.apiKey);

    return fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: parts }],
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 4000 }
      })
    }).then(handleResponse).then(function (data) {
      if (data.error) throw new Error(data.error.message || 'Erreur API Gemini.');
      var cand = data.candidates && data.candidates[0];
      var text = (cand && cand.content && cand.content.parts)
        ? cand.content.parts.map(function (p) { return p.text || ''; }).join('')
        : '';
      return parseJson(text);
    });
  }

  /* Les GPT-5 et suivants raisonnent avant de répondre : comme sur Claude Opus 5,
     les tokens de réflexion sont décomptés du plafond de sortie, donc un plafond
     serré renvoie une réponse vide ou tronquée. Ces modèles attendent par ailleurs
     'max_completion_tokens' là où les gpt-4* utilisaient 'max_tokens'. */
  function isReasoningGpt(model) {
    var m = /^gpt-(\d+)/.exec(model || '');
    return m ? parseInt(m[1], 10) >= 5 : false;
  }

  function callOpenAI(images, prompt, settings) {
    var userContent = [{ type: 'text', text: prompt }];
    images.forEach(function (img) {
      userContent.push({
        type: 'image_url',
        image_url: { url: 'data:' + img.mediaType + ';base64,' + img.base64 }
      });
    });

    var model = settings.model || 'gpt-5.6-terra';
    var modern = isReasoningGpt(model);

    function send(useCompletionTokens) {
      var body = {
        model: model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent }
        ]
      };
      if (useCompletionTokens) body.max_completion_tokens = THINKING_MAX_TOKENS;
      else body.max_tokens = 1600;

      return fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Authorization': 'Bearer ' + settings.apiKey
        },
        body: JSON.stringify(body)
      }).then(handleResponse);
    }

    /* Filet de sécurité : le nom du paramètre de plafond varie selon la génération
       du modèle. Si l'API refuse celui qu'on a choisi, on rejoue une fois avec
       l'autre plutôt que de renvoyer une erreur à l'utilisateur. */
    function isTokenParamError(err) {
      var m = (err && err.apiMessage || '').toLowerCase();
      return err && err.status === 400 &&
             (m.indexOf('max_tokens') !== -1 || m.indexOf('max_completion_tokens') !== -1);
    }

    return send(modern)
      .catch(function (err) {
        if (isTokenParamError(err)) return send(!modern);
        throw err;
      })
      .then(function (data) {
        if (data.error) throw new Error(data.error.message || 'Erreur API OpenAI.');
        var choice = data.choices && data.choices[0];
        var text = choice && choice.message && choice.message.content;
        if (!text && choice && choice.finish_reason === 'length') {
          throw new Error('Réponse tronquée : le modèle a épuisé son budget en réflexion. ' +
            'Réessaie, ou choisis un modèle plus léger (GPT-5.6 Luna).');
        }
        return parseJson(text);
      });
  }

  function handleResponse(res) {
    return res.text().then(function (body) {
      var data;
      try { data = JSON.parse(body); } catch (e) { data = { raw: body }; }
      if (!res.ok) {
        var apiMessage = (data.error && (data.error.message || data.error.type)) || '';
        var msg = apiMessage || ('Erreur ' + res.status);
        if (res.status === 401 || res.status === 403) msg = 'Clé API invalide, expirée ou sans accès (' + res.status + ').';
        if (res.status === 429) msg = 'Quota / débit atteint (429). Patiente ~1 min puis réessaie, ou limite le nombre de photos.';
        var err = new Error(msg);
        err.status = res.status;
        err.apiMessage = apiMessage; // brut : sert à détecter un paramètre refusé
        throw err;
      }
      return data;
    });
  }

  // -------- Normalisation / garde-fous sur le résultat --------
  function sanitize(result, ctx) {
    var hasReference = !!(ctx && ctx.referenceObject && ctx.referenceObject !== 'none');
    var items = Array.isArray(result.items) ? result.items : [];
    items = items.map(function (it) {
      var carbs = num(it.carbsG);
      if (carbs == null) {
        var mass = num(it.estimatedMassG), dens = num(it.carbDensityPer100g);
        carbs = (mass != null && dens != null) ? mass * dens / 100 : 0;
      }
      return {
        name: it.name || 'Aliment',
        portionDescription: it.portionDescription || '',
        estimatedMassG: num(it.estimatedMassG),
        carbDensityPer100g: num(it.carbDensityPer100g),
        carbsG: Math.max(0, Math.round(carbs)),
        proteinG: nonNeg(it.proteinG),
        fatG: nonNeg(it.fatG),
        kcal: nonNeg(it.kcal),
        confidence: normConf(it.confidence),
        assumptions: it.assumptions || ''
      };
    });

    // Total = somme des items (source de vérité, cohérent avec l'édition manuelle).
    var total = items.reduce(function (s, it) { return s + it.carbsG; }, 0);

    var low = num(result.rangeLowG);
    var high = num(result.rangeHighG);
    var conf = normConf(result.overallConfidence);
    // Si le modèle n'a pas donné de fourchette, on en dérive une selon la confiance.
    // Un objet-repère mesure la taille : on resserre la fourchette dans ce cas.
    if (low == null || high == null) {
      var spread = conf === 'high' ? 0.12 : conf === 'medium' ? 0.22 : 0.35;
      if (hasReference) spread = Math.max(0.08, spread - 0.06);
      low = Math.round(total * (1 - spread));
      high = Math.round(total * (1 + spread));
    }

    var totalProtein = sumOf(items, 'proteinG');
    var totalFat = sumOf(items, 'fatG');
    var totalKcal = sumOf(items, 'kcal');
    // Si le modèle n'a pas donné les calories, on les dérive des macros.
    if (totalKcal == null && (totalProtein != null || totalFat != null)) {
      totalKcal = Math.round(4 * total + 4 * (totalProtein || 0) + 9 * (totalFat || 0));
    }

    return {
      items: items,
      totalCarbsG: total,
      totalProteinG: totalProtein,
      totalFatG: totalFat,
      totalKcal: totalKcal,
      rangeLowG: Math.max(0, Math.round(low)),
      rangeHighG: Math.round(high),
      overallConfidence: conf,
      glycemicSpeed: glycemicSpeed(result.glycemicSpeed, total, totalFat, totalProtein),
      glycemicNote: result.glycemicNote || '',
      notes: result.notes || '',
      referenceUsed: result.referenceUsed || ''
    };
  }

  /* Vitesse d'absorption. On part de l'avis du modèle, mais on le corrige si les
     macros le contredisent franchement : un repas très gras est retardé même si le
     modèle a répondu « rapide ». Le gras ralentit la vidange gastrique — c'est un
     fait nutritionnel stable, pas une prédiction de glycémie. */
  function glycemicSpeed(raw, carbsG, fatG, proteinG) {
    var v = (raw || '').toString().toLowerCase()
      .replace(/[éè]/g, 'e').replace(/\s+/g, '');
    if (v.indexOf('rapide') !== -1) v = 'rapide';
    else if (v.indexOf('lente') !== -1 || v.indexOf('retard') !== -1) v = 'lente';
    else if (v.indexOf('moder') !== -1) v = 'moderee';
    else v = null;

    // Garde-fous sur les macros (appliqués seulement si on les connaît).
    if (fatG != null) {
      if (fatG >= 25 || (fatG >= 15 && (proteinG || 0) >= 25)) return 'lente';
      if (v === null && fatG < 5 && carbsG >= 20) return 'rapide';
    }
    return v || 'moderee';
  }

  function sumOf(items, key) {
    var seen = false;
    var total = items.reduce(function (s, it) {
      if (it[key] != null) { seen = true; return s + it[key]; }
      return s;
    }, 0);
    return seen ? Math.round(total) : null;
  }

  function num(v) {
    var n = typeof v === 'string' ? parseFloat(v.replace(',', '.')) : v;
    return (typeof n === 'number' && isFinite(n)) ? n : null;
  }
  function nonNeg(v) {
    var n = num(v);
    return (n != null && n >= 0) ? n : null;
  }
  function normConf(c) {
    c = (c || '').toString().toLowerCase();
    return (c === 'high' || c === 'medium' || c === 'low') ? c : 'medium';
  }

  var PROVIDER_LABEL = { claude: 'Anthropic (Claude)', gemini: 'Google (Gemini)', openai: 'OpenAI (ChatGPT)' };

  // Lance l'estimation pour UN fournisseur donné (utilisé aussi pour le 2ᵉ avis).
  function estimateProvider(provider, images, ctx, settings) {
    var keys = settings.apiKeys || {};
    var models = settings.models || {};
    var DEF = (window.Storage && window.Storage.DEFAULT_MODELS) ||
              { claude: 'claude-sonnet-5', gemini: 'gemini-2.0-flash', openai: 'gpt-4o' };
    // Compat : ancien format (clé/modèle uniques) si présent.
    var apiKey = keys[provider] || settings.apiKey || '';
    var model = models[provider] || settings.model || DEF[provider];

    if (!apiKey) {
      return Promise.reject(new Error('Aucune clé API ' + (PROVIDER_LABEL[provider] || provider) +
        '. Ajoute-la dans les Réglages, ou utilise le mode Manuel.'));
    }
    if (!images || !images.length) {
      return Promise.reject(new Error('Ajoute au moins une photo.'));
    }
    var prompt = buildUserPrompt(ctx);
    var callSettings = { provider: provider, apiKey: apiKey, model: model };
    var call = provider === 'openai' ? callOpenAI
             : provider === 'gemini' ? callGemini
             : callClaude;
    return call(images, prompt, callSettings).then(function (result) {
      var out = sanitize(result, ctx);
      out.provider = provider;
      out.model = model;
      return out;
    });
  }

  var Estimator = {
    PROVIDER_LABEL: PROVIDER_LABEL,

    /* images: [{base64, mediaType}], ctx: {referenceObject, plateDiameterCm, notes, imageCount},
       settings: {provider, apiKeys, models}. Retourne une Promise du résultat normalisé. */
    estimate: function (images, ctx, settings) {
      return estimateProvider(settings.provider || 'claude', images, ctx, settings);
    },

    // Estimation forcée sur un fournisseur précis (pour le mode « 2ᵉ avis »).
    estimateWith: function (provider, images, ctx, settings) {
      return estimateProvider(provider, images, ctx, settings);
    }
  };

  window.Estimator = Estimator;
})();
