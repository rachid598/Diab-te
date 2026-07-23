/* estimator.js — moteur d'estimation des glucides.
   Appelle directement l'API de vision (Claude ou OpenAI) depuis le navigateur.
   La clé et les photos ne partent que vers le fournisseur choisi. */
(function () {
  'use strict';

  // -------- Prompt système : cadre le raisonnement pour minimiser l'erreur --------
  var SYSTEM_PROMPT = [
    "Tu es un assistant de nutrition clinique spécialisé dans le COMPTAGE DES GLUCIDES",
    "pour l'insulinothérapie fonctionnelle (diabète de type 1).",
    "Ta mission : estimer, à partir d'une ou plusieurs photos d'un repas, la quantité TOTALE",
    "de glucides (en grammes), aliment par aliment, de la façon la plus fiable possible.",
    "",
    "MÉTHODE OBLIGATOIRE (raisonne étape par étape, en interne) :",
    "1. Identifie chaque composant alimentaire distinct visible.",
    "2. Estime le VOLUME de chaque composant. Sers-toi de l'objet-repère de taille connue",
    "   fourni (carte, fourchette, pièce, diamètre d'assiette) pour calibrer l'échelle.",
    "   S'il y a plusieurs angles, croise-les pour mieux juger l'épaisseur/hauteur.",
    "3. Convertis le volume en MASSE (g) via la densité typique de l'aliment et sa consistance",
    "   (ex. riz aéré vs compact, sauce, aliment frit gorgé d'huile).",
    "4. Applique la DENSITÉ GLUCIDIQUE (g de glucides pour 100 g) propre à l'aliment TEL QUE",
    "   consommé (cuit, avec sauce, panure, sucre ajouté, etc.).",
    "5. glucides_aliment = masse_g * densité_glucidique / 100.",
    "6. N'oublie pas les glucides CACHÉS : sauces sucrées, panure, chapelure, vinaigrette,",
    "   sucre, boisson sucrée visible, garniture. Les protéines pures et l'huile ≈ 0 g.",
    "",
    "GESTION DE L'INCERTITUDE :",
    "- Donne une fourchette basse et haute réaliste (rangeLowG, rangeHighG).",
    "- Sois prudent : mieux vaut signaler une incertitude qu'un faux chiffre précis.",
    "- Indique une confiance globale honnête (low si photo ambiguë, pas de repère, portion difficile).",
    "",
    "SORTIE : réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, sans balises",
    "markdown. Schéma exact :",
    "{",
    '  "items": [',
    '    {',
    '      "name": "nom court en français",',
    '      "portionDescription": "portion estimée en langage clair (ex: ~1 bol, ~150 g)",',
    '      "estimatedMassG": nombre,',
    '      "carbDensityPer100g": nombre,',
    '      "carbsG": nombre,',
    '      "confidence": "low" | "medium" | "high",',
    '      "assumptions": "hypothèses clés en français"',
    '    }',
    '  ],',
    '  "totalCarbsG": nombre,',
    '  "rangeLowG": nombre,',
    '  "rangeHighG": nombre,',
    '  "overallConfidence": "low" | "medium" | "high",',
    '  "notes": "conseils/avertissements en français (glucides cachés, vérifier avant de doser)",',
    '  "referenceUsed": "comment l\'échelle a été estimée"',
    "}"
  ].join('\n');

  function buildUserPrompt(ctx) {
    var lines = ['Analyse ce repas et estime les glucides selon la méthode.'];
    if (ctx.referenceObject && ctx.referenceObject !== 'none') {
      var ref = ctx.referenceObject;
      if (ctx.plateDiameterCm) {
        ref = 'assiette de ' + ctx.plateDiameterCm + ' cm de diamètre';
      }
      lines.push('Objet-repère présent dans la photo pour l\'échelle : ' + ref + '.');
    } else {
      lines.push('Aucun objet-repère fourni : estime l\'échelle à partir d\'indices habituels (assiette, couverts) et baisse la confiance en conséquence.');
    }
    if (ctx.imageCount > 1) {
      lines.push('Il y a ' + ctx.imageCount + ' angles de vue du MÊME repas : croise-les.');
    }
    if (ctx.notes && ctx.notes.trim()) {
      lines.push('Précisions fournies par l\'utilisateur (fiables, à intégrer) : ' + ctx.notes.trim());
    }
    lines.push('Rappelle-toi : réponds uniquement avec le JSON.');
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
  function callClaude(images, prompt, settings) {
    var content = images.map(function (img) {
      return {
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.base64 }
      };
    });
    content.push({ type: 'text', text: prompt });

    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: settings.model || 'claude-sonnet-5',
        max_tokens: 1600,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: content }]
      })
    }).then(handleResponse).then(function (data) {
      if (data.error) throw new Error(data.error.message || 'Erreur API Claude.');
      var text = (data.content || []).map(function (b) { return b.text || ''; }).join('');
      return parseJson(text);
    });
  }

  function callOpenAI(images, prompt, settings) {
    var userContent = [{ type: 'text', text: prompt }];
    images.forEach(function (img) {
      userContent.push({
        type: 'image_url',
        image_url: { url: 'data:' + img.mediaType + ';base64,' + img.base64 }
      });
    });

    return fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Authorization': 'Bearer ' + settings.apiKey
      },
      body: JSON.stringify({
        model: settings.model || 'gpt-4o',
        max_tokens: 1600,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent }
        ]
      })
    }).then(handleResponse).then(function (data) {
      if (data.error) throw new Error(data.error.message || 'Erreur API OpenAI.');
      var text = data.choices && data.choices[0] && data.choices[0].message.content;
      return parseJson(text);
    });
  }

  function handleResponse(res) {
    return res.text().then(function (body) {
      var data;
      try { data = JSON.parse(body); } catch (e) { data = { raw: body }; }
      if (!res.ok) {
        var msg = (data.error && (data.error.message || data.error.type)) ||
                  ('Erreur ' + res.status);
        if (res.status === 401) msg = 'Clé API invalide ou expirée (401).';
        if (res.status === 429) msg = 'Trop de requêtes ou quota dépassé (429).';
        throw new Error(msg);
      }
      return data;
    });
  }

  // -------- Normalisation / garde-fous sur le résultat --------
  function sanitize(result) {
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
    if (low == null || high == null) {
      var spread = conf === 'high' ? 0.12 : conf === 'medium' ? 0.22 : 0.35;
      low = Math.round(total * (1 - spread));
      high = Math.round(total * (1 + spread));
    }

    return {
      items: items,
      totalCarbsG: total,
      rangeLowG: Math.max(0, Math.round(low)),
      rangeHighG: Math.round(high),
      overallConfidence: conf,
      notes: result.notes || '',
      referenceUsed: result.referenceUsed || ''
    };
  }

  function num(v) {
    var n = typeof v === 'string' ? parseFloat(v.replace(',', '.')) : v;
    return (typeof n === 'number' && isFinite(n)) ? n : null;
  }
  function normConf(c) {
    c = (c || '').toString().toLowerCase();
    return (c === 'high' || c === 'medium' || c === 'low') ? c : 'medium';
  }

  var Estimator = {
    /* images: [{base64, mediaType}], ctx: {referenceObject, plateDiameterCm, notes, imageCount},
       settings: {provider, apiKey, model}. Retourne une Promise du résultat normalisé. */
    estimate: function (images, ctx, settings) {
      if (!settings.apiKey) {
        return Promise.reject(new Error('Aucune clé API. Ajoute-la dans les Réglages, ou utilise le mode Manuel.'));
      }
      if (!images || !images.length) {
        return Promise.reject(new Error('Ajoute au moins une photo.'));
      }
      var prompt = buildUserPrompt(ctx);
      var call = settings.provider === 'openai' ? callOpenAI : callClaude;
      return call(images, prompt, settings).then(sanitize);
    }
  };

  window.Estimator = Estimator;
})();
