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
    "A. ÉCHELLE MÉTRIQUE (déterminante).",
    "   N'invente JAMAIS une échelle à partir d'un objet que tu crois reconnaître dans",
    "   l'image, même si sa taille habituelle te semble connue. Une carte, une pompe, une",
    "   pièce, une assiette ou des couverts visibles ne constituent PAS une mesure.",
    "   La seule échelle métrique autorisée est un bloc intitulé exactement",
    "   « MESURE NATIVE VÉRIFIÉE POUR IMAGE N/M UNIQUEMENT » dans le message utilisateur.",
    "   Ce bloc vient d'ARCore et est déjà associé à une image précise. Utilise ses",
    "   dimensions uniquement pour cette image ; ne les transpose jamais à un autre angle.",
    "   S'il n'y a aucun bloc natif vérifié, estime visuellement la portion et décris",
    "   honnêtement les dimensions comme estimées, jamais comme mesurées.",
    "",
    "B. TROISIÈME DIMENSION (hauteur/épaisseur).",
    "   Avec plusieurs angles : croise-les pour juger le volume précisément (confiance haute).",
    "   Avec une seule vue de dessus : tu ne vois pas directement la hauteur — estime-la à",
    "   partir d'indices (ombres, empilement, type d'aliment) et considère-la comme la",
    "   principale inconnue géométrique de cet aliment (une vue de côté la lèverait).",
    "",
    "C. VOLUME → MASSE via la densité et la consistance (riz aéré vs compact, mie de pain",
    "   aérée vs dense, aliment frit gorgé d'huile, sauce).",
    "   ANCRAGE OBLIGATOIRE — pour tout aliment apportant plus de 10 g de glucides, pars",
    "   de ce que tu peux LIRE sur l'image : dimensions en cm (longueur × largeur ×",
    "   épaisseur, ou diamètre × hauteur), ou un décompte d'unités avec leur calibre",
    "   (« 3 pommes de terre d'environ 6 cm »). Déduis-en le volume, puis la masse, et",
    "   reporte cet ancrage dans 'portionDescription'.",
    "   Une portion type (« portion restaurant standard », « part moyenne », « bien",
    "   remplie ») est un CONTRÔLE final de vraisemblance — jamais le point de départ,",
    "   jamais la seule justification d'une masse. Deux modèles qui partent tous les deux",
    "   d'une moyenne mémorisée se trompent ENSEMBLE sans que rien ne le signale, et",
    "   l'utilisateur n'a alors aucun moyen de vérifier la portion sur sa propre photo.",
    "   Une fois la masse obtenue, recoupe-la avec des portions types plausibles (ex. une",
    "   baguette entière ≈ 250 g de pain ≈ 130–150 g de glucides ; une ½ baguette ≈ 65–75 g",
    "   de glucides ; un bol de riz cuit ≈ 40 g) : si l'écart est grand, c'est ta lecture",
    "   des dimensions qu'il faut revoir, pas le chiffre qu'il faut remplacer par la moyenne.",
    "",
    "D. glucides_aliment = masse_g × densité_glucidique(g/100g de l'aliment TEL QUE consommé)",
    "   /100. N'oublie pas les glucides CACHÉS : sauces sucrées, panure, chapelure,",
    "   vinaigrette sucrée, sucre, boisson sucrée. Protéines pures et huile ≈ 0 g.",
    "",
    "E. INCERTITUDE — resserre-la au maximum honnête :",
    "   - Donne UN meilleur point d'estimation (pas un chiffre gonflé « par sécurité »).",
    "   - rangeLowG/rangeHighG ne couvrent QUE les facteurs non résolus : densité interne",
    "     (mie du pain), hauteur non vue en photo unique, présence/quantité de sucre caché.",
    "   - overallConfidence 'high' UNIQUEMENT pour un repas simple, un seul aliment",
    "     glucidique dominant, nettement visible et de densité connue. Mesuré sur",
    "     368 estimations, l'écart réel/estimé va de 0,62 à 1,66 dans 80 % des cas :",
    "     une confiance 'high' n'est donc justifiée que rarement, et l'application",
    "     calcule elle-même la fourchette à partir de ces écarts observés.",
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
    "H. INDEX GLYCÉMIQUE — champ 'gi' (0-100, glucose = 100), par aliment.",
    "   L'application possède sa propre table de référence et l'utilisera en",
    "   priorité : ta valeur ne sert QUE pour un plat qu'elle ne connaît pas",
    "   (plat composé, recette maison, spécialité régionale).",
    "   - Donne l'IG du plat tel que consommé, pas d'un ingrédient isolé.",
    "   - Aliment sans glucides (viande, poisson, œuf, légume vert, fromage) :",
    "     mets 'gi': null. Ne l'invente pas, l'IG n'y a pas de sens.",
    "   - Dans le doute sur un plat composé, reste proche de 55-65 plutôt que",
    "     de trancher : une valeur fausse est pire qu'une valeur prudente.",
    "",
    "I. INVENTAIRE DE CE QUE TU VOIS — c'est ce qui permet à l'utilisateur de",
    "   VÉRIFIER ton estimation avant de doser son insuline.",
    "   - Liste dans 'items' TOUS les aliments visibles, y compris ceux qui",
    "     n'apportent aucun glucide (viande, poisson, œuf, fromage, légumes",
    "     verts, huile) : mets alors carbsG à 0. Un aliment absent de la liste",
    "     laisse croire que tu ne l'as pas vu.",
    "   - 'name' doit décrire ce que tu vois précisément (« pavé de saumon",
    "     grillé », pas « poisson » ; « riz blanc long grain », pas « féculent »).",
    "   - Si tu hésites entre deux aliments, choisis le plus probable et dis",
    "     l'hésitation dans 'assumptions' (« pourrait être du cabillaud »).",
    "   - 'clarification' : la SEULE question dont la réponse changerait vraiment",
    "     le total. Une personne est devant son assiette et peut te répondre : elle",
    "     sait si c'est du yaourt ou du porridge, si le riz est cuit ou cru, si la",
    "     sauce est à la crème. Toi non. C'est l'information la moins chère qui",
    "     existe, et personne d'autre ne l'a.",
    "     impactCarbsG = de combien de grammes de glucides le total peut bouger",
    "     selon la réponse. Sois honnête : c'est ce nombre qui décide si on",
    "     dérange l'utilisateur.",
    "     Mets null si aucune incertitude ne dépasse ~10 g, ou si la photo est",
    "     claire. Une question posée pour rien fait fermer l'application, et la",
    "     suivante ne sera plus lue.",
    "     UNE seule question, jamais deux. Pas de question sur ce que tu peux",
    "     mesurer toi-même (taille, volume) : uniquement sur ce qui est",
    "     INVISIBLE — nature de l'aliment, mode de cuisson, ingrédient caché.",
    "   - Dans 'seen' : UNE phrase en français décrivant l'assiette telle que tu",
    "     la vois, comme si tu la décrivais à quelqu'un au téléphone. Mentionne",
    "     le contenant (assiette plate/creuse, bol, barquette) et ce qui est",
    "     partiellement caché. C'est le texte que l'utilisateur relira pour",
    "     confirmer que tu as bien lu SON repas.",
    "",
    "SORTIE : réponds UNIQUEMENT avec un objet JSON valide, sans texte ni balises markdown.",
    "Schéma exact :",
    "{",
    '  "seen": "une phrase décrivant l\'assiette telle que tu la vois",',
    '  "items": [',
    '    {',
    '      "name": "nom précis de ce que tu vois, en français",',
    '      "portionDescription": "l\'ancrage lu sur l\'image — dimensions en cm ou décompte d\'unités avec calibre — puis la portion. Dimensions natives si fournies, sinon estimées.",',
    '      "estimatedMassG": nombre,',
    '      "carbDensityPer100g": nombre,',
    '      "carbsG": nombre,',
    '      "proteinG": nombre,',
    '      "fatG": nombre,',
    '      "kcal": nombre,',
    '      "gi": nombre | null,',
    '      "fromPhoto": true | false,',
    '      "confidence": "low" | "medium" | "high",',
    '      "assumptions": "mesure native fournie pour cette image, s\'il y en a une, + hypothèses clés"',
    '    }',
    '  ],',
    '  "totalCarbsG": nombre,',
    '  "rangeLowG": nombre,',
    '  "rangeHighG": nombre,',
    '  "overallConfidence": "low" | "medium" | "high",',
    '  "glycemicSpeed": "rapide" | "moderee" | "lente",',
    '  "glycemicNote": "ce qui, dans ce repas, détermine la vitesse d\'absorption",',
    '  "notes": "LE facteur d\'incertitude dominant + action concrète pour l\'affiner",',
    '  "clarification": null | {',
    '    "question": "UNE question courte, en français, à la personne qui mange",',
    '    "options": ["2 à 4 réponses possibles, courtes"],',
    '    "impactCarbsG": nombre',
    '  }',
    "}"
  ].join('\n');

  function buildUserPrompt(ctx) {
    ctx = ctx && typeof ctx === 'object' ? ctx : {};
    // Mode description : rien à mesurer, tout repose sur le texte.
    if (!ctx.imageCount) return buildTextPrompt(ctx);

    var lines = ['Analyse ce repas et estime les glucides selon la méthode.'];
    var referenceMode = ctx.referenceMode === 'glucovision-card-v2'
      ? 'glucovision-card-v2' : 'none';
    var measurements = validViewMeasurements(ctx.viewMeasurements, ctx.imageCount, referenceMode);
    if (referenceMode === 'glucovision-card-v2') {
      lines.push('MODE CARTE GLUCOVISION demandé. La carte visuelle n\'est jamais une preuve');
      lines.push('et tu ne dois ni la détecter, ni la mesurer en pixels, ni déduire sa taille.');
      if (measurements.length) {
        lines.push(measurements.length + ' vue(s) possèdent une vérification native ARCore ci-dessous.');
      } else {
        lines.push('AUCUNE VUE N\'A DE VÉRIFICATION NATIVE : ignore totalement la carte visible');
        lines.push('et ne prétends pas avoir calibré l\'échelle. Estime les portions à vue.');
      }
    } else {
      lines.push('MODE RAPIDE SANS CARTE : aucune échelle métrique native n\'est fournie.');
      lines.push('Estime les portions visuellement sans déclarer de mesure réelle.');
    }
    if (ctx.imageCount > 1) {
      lines.push('Il y a ' + ctx.imageCount + ' angles du MÊME repas : croise-les pour le volume (hauteur incluse).');
    } else {
      lines.push('Une seule vue : tu ne vois pas directement la hauteur/épaisseur — estime-la et');
      lines.push('signale-la comme seule inconnue géométrique (une photo de côté la lèverait).');
    }
    measurements.forEach(function (measurement) {
      var depth = measurement.depth;
      lines.push('MESURE NATIVE VÉRIFIÉE POUR IMAGE ' + measurement.viewIndex + '/' +
        ctx.imageCount + ' UNIQUEMENT : à ' + depth.distanceCm +
        ' cm de l\'objectif, le champ de cette image mesure environ ' + depth.fieldWidthCm +
        ' × ' + depth.fieldHeightCm + ' cm.');
      lines.push('Utilise cette mesure uniquement comme échelle géométrique horizontale pour');
      lines.push('le plan de la table dans cette image : elle prime sur une échelle devinée.');
      lines.push('Elle ne mesure pas directement le dessus d’un aliment surélevé : conserve');
      lines.push('l’incertitude de hauteur et croise les angles au lieu d’inventer une correction.');
      lines.push('Ne l\'applique à aucun autre angle : leur perspective et leur distance diffèrent.');
      lines.push('Ne déduis JAMAIS une masse ni des glucides');
      lines.push('d\'un éventuel volumeCm3 : cette donnée expérimentale n\'est pas étalonnée.');
    });
    if (ctx.notes && ctx.notes.trim()) {
      lines.push('Précisions de l\'utilisateur (fiables, à intégrer) : ' + ctx.notes.trim());
    }
    if (ctx.extras && ctx.extras.trim()) {
      lines.push('À COMPTER EN PLUS, mais ABSENTS DE LA PHOTO (l\'utilisateur les');
      lines.push('prévoit après le plat) : ' + ctx.extras.trim());
      lines.push('Ne les cherche pas dans l\'image. Ajoute-les comme aliments à part');
      lines.push('entière avec "fromPhoto": false, en te basant sur les portions usuelles.');
    }
    var ctxBlock = contextBlock(ctx);
    if (ctxBlock) lines.push(ctxBlock);
    var cal = calibrationBlock();
    if (cal) lines.push(cal);
    lines.push('Réponds uniquement avec le JSON.');
    return lines.join('\n');
  }

  function buildTextPrompt(ctx) {
    var lines = [
      'Voici la description écrite du repas, par l\'utilisateur lui-même :',
      '',
      (ctx.notes || '').trim(),
      '',
      'Estime les glucides de CE repas, uniquement à partir de cette description.',
      'Ne compte aucun aliment qui n\'y figure pas.'
    ];
    if (ctx.extras && ctx.extras.trim()) {
      lines.push('À compter également : ' + ctx.extras.trim());
    }
    var ctxBlock = contextBlock(ctx);
    if (ctxBlock) lines.push(ctxBlock);
    var cal = calibrationBlock();
    if (cal) lines.push(cal);
    lines.push('Réponds uniquement avec le JSON.');
    return lines.join('\n');
  }

  /* Frontière de confiance indépendante de l'interface : un historique, une
     file ou un appel direct peut être forgé. Les trois validations positives
     (carte, fraîcheur, échelle) doivent être présentes sur CHAQUE vue. */
  function hasVerifiedCardContract(raw) {
    if (!raw || typeof raw !== 'object' || raw.cardRequested !== true ||
        raw.cardVerified !== true || raw.cardFresh !== true ||
        raw.cardSchema !== 'glucovision-card-v2' || raw.cardName !== 'glucovision-card-v2' ||
        raw.cardTrackingMethod !== 'FULL_TRACKING' ||
        !/^(card|card\+depth)$/.test(raw.scaleSource || '')) return false;
    var observations = strictNum(raw.cardObservations);
    var width = strictNum(raw.cardWidthCm), height = strictNum(raw.cardHeightCm);
    if (observations == null || observations !== Math.round(observations) ||
        observations < 4 || observations > 1000 || width == null || height == null ||
        Math.abs(width - 8.56) > 0.05 || Math.abs(height - 5.398) > 0.05) return false;
    return raw.scaleSource !== 'card+depth' ||
      (raw.cardDepthCompared === true && raw.cardDepthAgrees === true);
  }

  function validViewMeasurements(raw, imageCount, referenceMode) {
    if (referenceMode !== 'glucovision-card-v2' || !Array.isArray(raw)) return [];
    var count = strictNum(imageCount);
    if (count == null || count !== Math.round(count) || count < 1 || count > 6) return [];
    var seen = {};
    return raw.map(function (measurement) {
      if (!measurement || typeof measurement !== 'object') return null;
      var depth = measurement.depth;
      var reference = measurement.reference;
      var view = strictNum(measurement.viewIndex);
      if (!depth || typeof depth !== 'object' || !reference || typeof reference !== 'object' ||
          depth.scaleOk !== true || depth.fresh !== true || depth.cardMode !== true ||
          !hasVerifiedCardContract(depth) ||
          reference.mode !== 'glucovision-card-v2' || !hasVerifiedCardContract(reference) ||
          reference.scaleSource !== depth.scaleSource ||
          view == null || view !== Math.round(view) || view < 1 || view > count || seen[view]) {
        return null;
      }
      var width = strictNum(depth.fieldWidthCm);
      var height = strictNum(depth.fieldHeightCm);
      var distance = strictNum(depth.distanceCm);
      var scale = strictNum(depth.cmPerPixel);
      if (!(width > 1 && width <= 250 && height > 1 && height <= 250 &&
            distance >= 5 && distance <= 500 && scale > 0 && scale <= 5)) return null;
      seen[view] = true;
      var cardObservations = strictNum(depth.cardObservations);
      var tracking = typeof depth.cardTrackingMethod === 'string' &&
        depth.cardTrackingMethod.length <= 120 ? depth.cardTrackingMethod : '';
      var cleanReference = {
        mode: 'glucovision-card-v2', cardVerified: true, cardFresh: true,
        cardSchema: 'glucovision-card-v2', scaleSource: depth.scaleSource
      };
      var cleanDepth = {
        scaleOk: true,
        fresh: true,
        cardMode: true,
        cardVerified: true,
        cardFresh: true,
        cardSchema: 'glucovision-card-v2',
        scaleSource: depth.scaleSource,
        fieldWidthCm: Math.round(width * 10) / 10,
        fieldHeightCm: Math.round(height * 10) / 10,
        distanceCm: Math.round(distance * 10) / 10,
        cmPerPixel: Math.round(scale * 10000) / 10000
      };
      if (cardObservations != null && cardObservations >= 0 && cardObservations <= 1000000) {
        cleanReference.cardObservations = cardObservations;
        cleanDepth.cardObservations = cardObservations;
      }
      if (tracking) {
        cleanReference.cardTrackingMethod = tracking;
        cleanDepth.cardTrackingMethod = tracking;
      }
      return {
        viewIndex: view,
        reference: cleanReference,
        depth: cleanDepth
      };
    }).filter(Boolean).sort(function (a, b) { return a.viewIndex - b.viewIndex; });
  }

  /* Calibration personnelle : ce que les repas déjà mesurés par l'utilisateur
     disent des erreurs passées, transmis au modèle.

     Pourquoi le donner au modèle plutôt que multiplier le résultat par un
     coefficient : un facteur appliqué après coup corrige aveuglément tout le
     repas, y compris les aliments jamais concernés par l'erreur. Le modèle, lui,
     peut cibler — s'il sait que les féculents ont été sous-estimés, il révise sa
     densité sur le riz sans toucher au yaourt.

     Le biais PAR CATÉGORIE passe avant le biais global : « je me trompe sur les
     féculents » est exploitable, « je me trompe de 12 % » ne l'est pas. */
  /* ---------- Contexte du repas ----------
     Le modèle voit l'assiette et rien d'autre. Il ignore qu'il est 20 h, et
     surtout il ignore si tu es chez toi ou au restaurant — alors que c'est un
     des écarts les plus systématiques qui soient : à plat identique, la portion
     servie au restaurant est plus grosse et la préparation plus riche en matière
     grasse et en sucre ajouté.

     Le benchmark ACETADA (arXiv 2507.07048) mesure ce gain : ajouter des
     métadonnées de contexte — horodatage, type de lieu — réduit l'erreur des
     modèles multimodaux sur l'analyse nutritionnelle. C'est le levier le moins
     cher qui existe ici, puisqu'il ne demande aucune donnée nouvelle.

     Deux précautions. On ne donne AUCUN pourcentage de correction : inventer
     « ajoute 20 % au restaurant » serait fabriquer une calibration qu'on n'a pas
     mesurée, exactement ce qu'on reproche au champ serving_size d'OpenFoodFacts.
     Et le contexte ne tranche que les cas douteux — ce que montre la photo prime
     toujours, sinon on apprend au modèle à contredire l'image. */
  var LIEUX = {
    maison: {
      nom: 'à la maison',
      note: 'Portions de repas fait maison ; les quantités de matière grasse et ' +
            'de sucre ajouté sont généralement modérées.'
    },
    restaurant: {
      nom: 'au restaurant',
      note: 'Les portions servies au restaurant sont typiquement plus grandes ' +
            'qu\'à la maison, et les préparations plus riches en matière grasse ' +
            'et en sucre ajouté (sauces, cuisson, assaisonnement).'
    },
    cantine: {
      nom: 'à la cantine ou au self',
      note: 'Portions standardisées de collectivité, servies à la louche ou ' +
            'préportionnées ; féculents souvent généreux.'
    }
  };

  /* Bornes larges et volontairement trouées : entre 15 h et 18 h, ce n'est ni un
     déjeuner ni un dîner, et « collation » est alors l'information juste. Mieux
     vaut un créneau honnête qu'un repas nommé au hasard. */
  function mealMoment(date) {
    var d = (date instanceof Date) ? date : new Date(date == null ? Date.now() : date);
    var h = d.getHours();
    if (!isFinite(h)) return '';
    if (h >= 5 && h < 11) return 'petit-déjeuner';
    if (h >= 11 && h < 15) return 'déjeuner';
    if (h >= 18 && h < 23) return 'dîner';
    return 'collation';
  }

  function contextBlock(ctx) {
    var moment = mealMoment(ctx && ctx.mealAt);
    var lieu = LIEUX[(ctx && ctx.venue) || ''] || null;
    if (!moment && !lieu) return '';

    var quoi = [moment, lieu ? lieu.nom : ''].filter(Boolean).join(', ');
    var lignes = ['CONTEXTE DU REPAS : ' + quoi + '.'];
    if (lieu) lignes.push(lieu.note);
    lignes.push('Sers-t\'en pour trancher les portions et les préparations ' +
      'DOUTEUSES. Ce contexte ne remplace jamais ce que montre la photo : si ' +
      'l\'image contredit l\'habitude, c\'est l\'image qui a raison.');
    return lignes.join('\n');
  }

  function calibrationBlock() {
    if (!window.Storage || !Storage.getBiasByCategory) return '';
    var lines = [];

    var byCat = [];
    try { byCat = Storage.getBiasByCategory(3) || []; } catch (e) { byCat = []; }
    byCat.slice(0, 3).forEach(function (g) {
      if (Math.abs(g.pct) < 8) return;   // sous ce seuil, c'est du bruit de mesure
      lines.push('  - ' + g.category + ' : ' + (g.pct > 0 ? 'sous-estimés' : 'sur-estimés') +
        ' d\'environ ' + Math.abs(g.pct) + ' % sur ' + g.count + ' repas mesurés.');
    });

    if (!lines.length) {
      var b = null;
      try { b = Storage.getBias(); } catch (e) { b = null; }
      if (!b || b.count < 5 || Math.abs(b.pct) < 8) return '';
      lines.push('  - Ensemble des repas : ' + (b.pct > 0 ? 'sous-estimés' : 'sur-estimés') +
        ' d\'environ ' + Math.abs(b.pct) + ' % sur ' + b.count + ' repas mesurés.');
    }

    return [
      'CALIBRATION PERSONNELLE — écarts constatés entre estimations passées et',
      'valeurs réelles mesurées par cet utilisateur :',
      lines.join('\n'),
      'Utilise-la pour corriger tes densités et tes volumes SUR LES ALIMENTS',
      'CONCERNÉS uniquement. N\'applique pas un pourcentage global au total : si',
      'ce repas ne contient pas la catégorie concernée, ignore la correction.',
      'Ces écarts portent sur des repas passés, pas forcément sur celui-ci : ce',
      'qui est visible sur la photo prime toujours.'
    ].join('\n');
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
  /* Erreur réseau maison, reconnaissable sans deviner le libellé du moteur.
     Le drapeau reseau:true est ce sur quoi s'appuient la relance automatique et
     la mise en file d'attente — pas une expression régulière appliquée à un
     message d'erreur, qui change d'un navigateur à l'autre et d'une version à
     l'autre. C'est exactement ce qui faisait qu'un « fetch failed » n'était pas
     reconnu comme une panne réseau et coûtait le repas. */
  function reseauCoupe(quoi) {
    var e = new Error((quoi || 'Réseau indisponible') +
      '. Vérifie ta connexion puis réessaie.');
    e.reseau = true;
    return e;
  }

  /* Une seule relance, et uniquement sur panne réseau.

     Pourquoi : envoyer six photos fait plusieurs mégaoctets, et l'analyse dure
     souvent une minute. Sur un téléphone qui change de cellule ou passe du Wi-Fi
     à la 4G, une coupure passagère suffisait à perdre le repas — au moment
     précis où l'assiette est entamée et où la photo n'est plus refaisable.

     Pourquoi UNE seule : au-delà, on empile des minutes d'attente sans rien
     dire, et l'appel a de bonnes chances d'avoir déjà été facturé côté modèle.
     Et jamais sur une erreur d'API : une clé invalide ou un quota atteint
     échouera exactement pareil la seconde fois. */
  var RETRY_DELAY_MS = 1500;

  function withRetry(faire) {
    return faire().catch(function (err) {
      if (!err || err.reseau !== true) throw err;
      return new Promise(function (res) { setTimeout(res, RETRY_DELAY_MS); })
        .then(faire)
        .catch(function (err2) {
          /* Le second échec dit qu'il y a EU une relance : sans ça, on croit à
             une panne instantanée alors qu'on a attendu deux fois le délai. */
          if (err2 && err2.reseau) {
            err2.message = err2.message.replace(/\.$/, '') + ' (déjà réessayé une fois).';
          }
          throw err2;
        });
    });
  }

  function fetchWithTimeout(url, options, ms) {
    ms = ms || REQUEST_TIMEOUT_MS;
    /* Sans AbortController on renonce au DÉLAI, jamais à la traduction de
       l'erreur. La version précédente faisait « return fetch(...) » tout court
       dans ce cas : sur un moteur ancien, l'échec réseau remontait donc brut,
       sans le drapeau reseau, et le repas n'était même pas proposé à la file
       d'attente. Le correctif ne devait pas reproduire le défaut qu'il corrige. */
    var minute = null;
    var demande;
    if (typeof AbortController === 'undefined') {
      demande = fetch(url, options);
    } else {
      var ctrl = new AbortController();
      minute = setTimeout(function () { ctrl.abort(); }, ms);
      demande = fetch(url, Object.assign({}, options, { signal: ctrl.signal }));
    }
    var fini = function () { if (minute !== null) clearTimeout(minute); };

    return demande.then(function (r) {
      fini();
      return r;
    }, function (err) {
      fini();
      if (err && err.name === 'AbortError') {
        var t = new Error('Délai dépassé (' + Math.round(ms / 1000) +
          ' s) : réseau lent ou modèle occupé. Réessaie, réduis le nombre de photos, ou choisis un modèle plus rapide.');
        t.reseau = true;
        throw t;
      }
      throw reseauCoupe('Réseau indisponible');
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

  /* Prompt du mode DESCRIPTION (aucune photo).
     Reprendre le prompt photo serait une faute : il est bâti sur la calibration
     d'échelle, la 3ᵉ dimension et la conversion volume→masse, qui n'ont aucun
     sens sans image. Le modèle chercherait à « mesurer » un texte et
     produirait une fausse précision.

     Ici la seule information est ce que l'utilisateur a écrit. Le travail
     consiste donc à interpréter des portions en langage courant, et surtout à
     être honnête sur ce qui n'a pas été dit : une « assiette de pâtes » couvre
     un rapport de 1 à 3 selon l'assiette et l'appétit. */
  var SYSTEM_PROMPT_TEXT = [
    "Tu es un diététicien spécialisé dans le comptage des glucides pour un",
    "diabétique de type 1 sous pompe à insuline. Tu reçois une DESCRIPTION ÉCRITE",
    "d'un repas, sans photo. Ta réponse sert à saisir une quantité de glucides",
    "dans une pompe : elle doit être juste, et honnête sur son incertitude.",
    "",
    "A. INTERPRÉTATION DES PORTIONS",
    "   - Quantité explicite (« 150 g de riz cuit », « 2 tranches de pain »,",
    "     « un yaourt de 125 g ») : prends-la telle quelle, c'est une donnée sûre.",
    "   - Portion en langage courant (« une assiette de pâtes », « un bol de riz »,",
    "     « une part de gâteau ») : utilise les portions usuelles françaises pour",
    "     un adulte, et dis dans 'assumptions' quelle taille tu as retenue en",
    "     grammes. C'est cette hypothèse qui porte l'essentiel de l'erreur.",
    "   - Quantificateur vague (« un peu de », « pas mal de », « une grosse part ») :",
    "     ajuste de 30 % environ vers le bas ou le haut de la portion usuelle.",
    "   - Aliment cité sans quantité : suppose UNE portion usuelle et signale-le.",
    "",
    "B. DENSITÉ GLUCIDIQUE — utilise les valeurs de référence (type Ciqual), pour",
    "   l'aliment TEL QUE CONSOMMÉ. Attention aux pièges classiques : pâtes et riz",
    "   CUITS contiennent environ 2,5 fois moins de glucides pour 100 g que crus ;",
    "   si l'utilisateur donne un poids, détermine d'après sa formulation s'il",
    "   parle du cru ou du cuit, et dis lequel tu as retenu.",
    "",
    "C. NE COMPTE QUE CE QUI EST DIT. N'ajoute pas d'accompagnement, de sauce, de",
    "   pain ou de boisson qui ne figure pas dans la description : l'utilisateur",
    "   dose d'après ton total, un aliment inventé le ferait sur-doser.",
    "   Ne retire pas non plus un aliment cité parce qu'il te semble improbable.",
    "",
    "D. INCERTITUDE — elle est structurellement plus large qu'avec une photo :",
    "   tu ne vois ni la taille réelle de l'assiette, ni la hauteur, ni ce qui",
    "   est caché dessous.",
    "   - Quantités toutes données en grammes ⇒ fourchette serrée (±10 %),",
    "     overallConfidence 'high'.",
    "   - Portions courantes nommées mais non pesées ⇒ ±25 à 35 %, confiance",
    "     'medium' au mieux.",
    "   - Description vague ou incomplète ⇒ ±40 % et confiance 'low'.",
    "   - Dans 'notes' : nomme LA question dont la réponse resserrerait le plus",
    "     l'estimation (ex. « quel poids de riz cuit ? »), formulée pour que",
    "     l'utilisateur puisse y répondre en une ligne. Pas de généralités.",
    "",
    "E. VITESSE D'ABSORPTION DU REPAS (caractérise le REPAS, ne prédis JAMAIS une",
    "   glycémie) : 'rapide', 'moderee' ou 'lente', selon la même logique",
    "   nutritionnelle (glucides à IG élevé et peu de gras ⇒ rapide ; beaucoup de",
    "   gras et/ou de protéines ⇒ retardée et étalée). Explique en une phrase",
    "   dans 'glycemicNote' ce qui, dans ce repas, détermine cette vitesse.",
    "   Aucun conseil de dose, jamais.",
    "",
    "F. MACRONUTRIMENTS : estime protéines, lipides et calories par aliment.",
    "   Reste cohérent : kcal ≈ 4×glucides + 4×protéines + 9×lipides.",
    "",
    "G. INDEX GLYCÉMIQUE — champ 'gi' (0-100, glucose = 100), par aliment.",
    "   L'application possède sa propre table et l'utilisera en priorité : ta",
    "   valeur ne sert que pour un plat qu'elle ne connaît pas. Aliment sans",
    "   glucides (viande, poisson, œuf, légume vert, fromage) : 'gi': null.",
    "",
    "H. CE QUE TU AS COMPRIS — dans 'seen', UNE phrase reformulant le repas tel",
    "   que tu l'as interprété, avec les portions retenues. L'utilisateur y",
    "   vérifie que tu n'as rien ajouté ni oublié avant de doser son insuline.",
    "   Liste aussi dans 'items' les aliments sans glucides qu'il a cités",
    "   (carbsG à 0) : leur absence laisserait croire que tu les as ignorés.",
    "",
    "SORTIE : réponds UNIQUEMENT avec un objet JSON valide, sans texte ni balises",
    "markdown. Schéma exact :",
    "{",
    '  "seen": "une phrase résumant ce que tu as compris de la description",',
    '  "items": [',
    '    {',
    '      "name": "nom court en français",',
    '      "portionDescription": "portion retenue (ex: assiette de pâtes ≈ 220 g cuit)",',
    '      "estimatedMassG": nombre,',
    '      "carbDensityPer100g": nombre,',
    '      "carbsG": nombre,',
    '      "proteinG": nombre,',
    '      "fatG": nombre,',
    '      "kcal": nombre,',
    '      "gi": nombre | null,',
    '      "confidence": "low" | "medium" | "high",',
    '      "assumptions": "taille de portion supposée et cru/cuit, en français"',
    '    }',
    '  ],',
    '  "totalCarbsG": nombre,',
    '  "rangeLowG": nombre,',
    '  "rangeHighG": nombre,',
    '  "overallConfidence": "low" | "medium" | "high",',
    '  "glycemicSpeed": "rapide" | "moderee" | "lente",',
    '  "glycemicNote": "ce qui, dans ce repas, détermine la vitesse d\'absorption",',
    '  "notes": "LA question qui resserrerait le plus l\'estimation"',
    "}"
  ].join('\n');

  // Le mode est déterminé par la présence d'images, pas par un réglage.
  function systemFor(images) {
    return (images && images.length) ? SYSTEM_PROMPT : SYSTEM_PROMPT_TEXT;
  }

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
      system: systemFor(images),
      messages: [{ role: 'user', content: content }]
    };
    // Raisonnement approfondi pour une estimation de volume plus fiable (modèles compatibles).
    if (supportsAdaptiveThinking(model)) {
      body.thinking = { type: 'adaptive' };
      body.max_tokens = THINKING_MAX_TOKENS;
    }

    return withRetry(function () {
      return fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
        body: JSON.stringify(body)
      }).then(handleResponse);
    }).then(function (data) {
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

    return withRetry(function () {
      return fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemFor(images) }] },
          contents: [{ role: 'user', parts: parts }],
          generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 4000 }
        })
      }).then(handleResponse);
    }).then(function (data) {
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

  /* OpenRouter expose une API compatible OpenAI : même corps de requête, même
     forme de réponse. On réutilise donc le même appel, en changeant l'URL et en
     ajoutant les deux en-têtes qu'OpenRouter recommande pour identifier l'app. */
  var OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

  function callOpenRouter(images, prompt, settings) {
    return callOpenAI(images, prompt, settings, OPENROUTER_URL);
  }

  function callOpenAI(images, prompt, settings, url) {
    var userContent = [{ type: 'text', text: prompt }];
    images.forEach(function (img) {
      userContent.push({
        type: 'image_url',
        image_url: { url: 'data:' + img.mediaType + ';base64,' + img.base64 }
      });
    });

    var model = settings.model || 'gpt-5.6-terra';
    // OpenRouter normalise tous les modèles sur max_tokens.
    var modern = (url === OPENROUTER_URL) ? false : isReasoningGpt(model);

    function send(useCompletionTokens) {
      var body = {
        model: model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemFor(images) },
          { role: 'user', content: userContent }
        ]
      };
      if (useCompletionTokens) body.max_completion_tokens = THINKING_MAX_TOKENS;
      /* Les modèles « Thinking » d'OpenRouter dépensent leur raisonnement DANS
         le budget de sortie. Avec 8000 jetons, le raisonnement peut tout
         consommer et la réponse JSON arriver tronquée. On double le plafond
         pour eux ; ce n'est pas facturé s'il n'est pas utilisé. */
      else if (url === OPENROUTER_URL) {
        body.max_tokens = /thinking|plus|max/.test(model) ? 16000 : THINKING_MAX_TOKENS;
      } else body.max_tokens = 1600;

      var headers = {
        'content-type': 'application/json',
        'Authorization': 'Bearer ' + settings.apiKey
      };
      if (url === OPENROUTER_URL) {
        headers['HTTP-Referer'] = 'https://rachid598.github.io/Diab-te/';
        headers['X-Title'] = 'GlucoVision';
      }
      return fetchWithTimeout(url || 'https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: headers,
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

    return withRetry(function () { return send(modern); })
      .catch(function (err) {
        if (isTokenParamError(err)) return withRetry(function () { return send(!modern); });
        throw err;
      })
      .then(function (data) {
        if (data.error) throw new Error(data.error.message || 'Erreur de l\'API.');
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
    /* res.text() est un SECOND aller-retour réseau : fetch() résout dès que les
       en-têtes arrivent, le corps continue de descendre après. Sur une réponse
       de modèle qui met 30 à 90 s, un basculement Wi-Fi/4G ou un écran qui
       s'éteint coupe la lecture ICI — et l'erreur brute du navigateur
       (« Failed to fetch », « fetch failed », « Load failed » selon le moteur)
       remontait telle quelle jusqu'au toast. C'est le message incompréhensible
       qu'on voyait, et il échappait au filet de fetchWithTimeout, qui ne couvre
       que l'établissement de la requête. */
    return res.text().catch(function () {
      throw reseauCoupe('Réponse interrompue en cours de lecture');
    }).then(function (body) {
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

  /* -------- Question de clarification --------
     Le modèle mesure ce qu'il voit. Il ne peut pas savoir si la préparation
     blanche sous les fruits rouges est du yaourt (≈ 5 g/100 g) ou du porridge
     (≈ 12 g/100 g) : la photo est identique, l'écart sur le total dépasse
     largement 20 g. Toi, tu le sais en un coup d'œil. C'est l'information la
     moins chère du système, et aucun second modèle ne peut la fournir.

     Le seuil de 10 g n'est pas décoratif. L'étude 2026 qui montre l'apport des
     informations complémentaires porte sur des repas décrits en détail ; ici on
     n'en demande qu'UNE, et seulement quand elle compte. Une question posée pour
     rien fait fermer l'application — et la suivante, celle qui aurait servi, ne
     sera plus lue. Le champ impactCarbsG est donc un filtre, pas une décoration.

     Tout est revalidé côté app : le modèle annonce l'impact lui-même, et il a
     tout intérêt à le gonfler pour justifier sa question. */
  var CLARIF_SEUIL_G = 10;
  var CLARIF_MAX_OPTIONS = 4;

  function sanitizeClarification(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var q = typeof raw.question === 'string' ? raw.question.trim() : '';
    var impact = strictNum(raw.impactCarbsG);
    if (!q || q.length > 200) return null;
    if (impact == null || impact < CLARIF_SEUIL_G) return null;

    var options = Array.isArray(raw.options) ? raw.options : [];
    options = options
      .map(function (o) { return typeof o === 'string' ? o.trim() : ''; })
      .filter(function (o) { return o && o.length <= 60; })
      .slice(0, CLARIF_MAX_OPTIONS);
    /* Moins de deux options n'est pas une question, c'est une affirmation
       déguisée. On préfère ne rien demander. */
    if (options.length < 2) return null;

    return {
      question: q,
      options: options,
      // Borné : un modèle qui annonce 900 g d'impact se trompe ou exagère.
      impactCarbsG: Math.round(Math.min(impact, 300))
    };
  }

  // -------- Normalisation / garde-fous sur le résultat --------
  function sanitize(result, ctx) {
    result = result && typeof result === 'object' ? result : {};
    var fromText = !(ctx && ctx.imageCount);
    var referenceMode = !fromText && ctx && ctx.referenceMode === 'glucovision-card-v2'
      ? 'glucovision-card-v2' : 'none';
    var verifiedViews = validViewMeasurements(ctx && ctx.viewMeasurements,
      ctx && ctx.imageCount, referenceMode);
    var refAsked = referenceMode === 'glucovision-card-v2';

    /* Les champs referenceFound/referenceUsed éventuellement inventés par le
       modèle sont intentionnellement ignorés. La seule preuve est le contrat
       natif strict, revalidé ici même si l'appel vient d'une reprise ou file. */
    var refFound = refAsked && verifiedViews.length > 0;
    var referenceUsed = refFound
      ? 'Carte GlucoVision vérifiée nativement — vue' +
        (verifiedViews.length > 1 ? 's ' : ' ') +
        verifiedViews.map(function (view) { return view.viewIndex; }).join(', ')
      : '';
    var clarification = sanitizeClarification(result.clarification);
    var rawBlocking = [];
    var rawTotal = strictNum(result.totalCarbsG);
    var rawLow = strictNum(result.rangeLowG);
    var rawHigh = strictNum(result.rangeHighG);

    if (rawTotal == null || rawTotal < 0) {
      rawBlocking.push('Le total brut renvoyé par le modèle est absent ou invalide.');
    }
    if (rawLow == null || rawHigh == null || rawLow < 0 || rawHigh < 0) {
      rawBlocking.push('La fourchette brute renvoyée par le modèle est absente ou invalide.');
    } else if (rawLow > rawHigh) {
      rawBlocking.push('La fourchette brute renvoyée par le modèle est inversée (' +
        Math.round(rawLow) + ' g à ' + Math.round(rawHigh) + ' g).');
    } else if (rawTotal != null && (rawTotal < rawLow || rawTotal > rawHigh)) {
      rawBlocking.push('Le total brut du modèle (' + Math.round(rawTotal) +
        ' g) est hors de sa propre fourchette (' + Math.round(rawLow) + '–' +
        Math.round(rawHigh) + ' g).');
    }

    var items = Array.isArray(result.items) ? result.items : [];
    items = items.map(function (it, index) {
      it = it && typeof it === 'object' ? it : {};
      var carbs = num(it.carbsG);
      if (carbs == null) {
        var mass = num(it.estimatedMassG), dens = num(it.carbDensityPer100g);
        carbs = (mass != null && dens != null) ? mass * dens / 100 : 0;
      }
      if (num(it.carbsG) == null && !(num(it.estimatedMassG) != null &&
          num(it.carbDensityPer100g) != null)) {
        rawBlocking.push('« ' + (it.name || ('Aliment ' + (index + 1))) +
          ' » : glucides absents ou invalides.');
      }
      if (carbs < 0) {
        rawBlocking.push('« ' + (it.name || ('Aliment ' + (index + 1))) +
          ' » : quantité de glucides négative.');
      }
      if (num(it.estimatedMassG) != null && num(it.estimatedMassG) < 0) {
        rawBlocking.push('« ' + (it.name || ('Aliment ' + (index + 1))) +
          ' » : masse négative.');
      }
      if (num(it.carbDensityPer100g) != null && num(it.carbDensityPer100g) < 0) {
        rawBlocking.push('« ' + (it.name || ('Aliment ' + (index + 1))) +
          ' » : densité glucidique négative.');
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
        gi: nonNeg(it.gi),          // secours seulement : la table locale prime
        // Dessert / boisson annoncés mais absents de l'image : l'interface les
        // présente à part, pour ne pas les faire passer pour « vus ».
        added: it.added === true || (!fromText && it.fromPhoto === false),
        confidence: normConf(it.confidence),
        assumptions: it.assumptions || ''
      };
    });

    var derivedTotal = items.reduce(function (s, it) { return s + it.carbsG; }, 0);
    if (rawTotal != null && rawTotal >= 0 && derivedTotal > 0 &&
        Math.abs(rawTotal - derivedTotal) > Math.max(5, derivedTotal * 0.2)) {
      rawBlocking.push('Le total brut annoncé (' + Math.round(rawTotal) +
        ' g) ne correspond pas à la somme des aliments (' + Math.round(derivedTotal) + ' g).');
    }
    if (rawLow != null && rawHigh != null && rawLow >= 0 && rawLow <= rawHigh &&
        derivedTotal > 0 && (derivedTotal < rawLow || derivedTotal > rawHigh)) {
      rawBlocking.push('La somme des aliments (' + Math.round(derivedTotal) +
        ' g) est hors de la fourchette brute du modèle (' + Math.round(rawLow) +
        '–' + Math.round(rawHigh) + ' g).');
    }

    var out = {
      items: items,
      overallConfidence: normConf(result.overallConfidence),
      fromText: fromText,
      refAsked: refAsked,
      refFound: refFound,
      referenceVerifiedViews: verifiedViews.map(function (view) { return view.viewIndex; }),
      referenceExpectedViews: fromText ? 0 : Math.max(0, Math.round(strictNum(ctx.imageCount) || 0)),
      clarification: clarification,
      seen: (result.seen || '').toString().trim(),
      glycemicSpeed: result.glycemicSpeed,
      _modelGlycemicSpeed: result.glycemicSpeed,
      glycemicNote: result.glycemicNote || '',
      notes: result.notes || '',
      referenceUsed: referenceUsed,
      /* Les contradictions de la réponse BRUTE ne doivent pas disparaître à la
         première édition. Elles restent séparées des garde-fous recalculables
         afin qu'une reprise manuelle puisse les lever explicitement, jamais
         silencieusement. */
      sourceBlocking: uniqueMessages(rawBlocking)
    };
    return recompute(out, rawBlocking);
  }

  /* Source de vérité unique après réception de l'IA comme après une correction
     humaine. Le point est toujours la somme des aliments et la fourchette vient
     des quantiles réellement observés au banc ; ni la confiance déclarée par
     l'IA ni un repère qu'elle dit avoir trouvé ne peuvent la resserrer. */
  function recompute(result, rawBlocking) {
    result = result || {};
    var sourceBlocking = rawBlocking === undefined
      ? (Array.isArray(result.sourceBlocking) ? result.sourceBlocking : [])
      : (Array.isArray(rawBlocking) ? rawBlocking : []);
    result.sourceBlocking = uniqueMessages(sourceBlocking);
    var items = Array.isArray(result.items) ? result.items : [];
    var currentBlocking = [];

    items = items.map(function (it, index) {
      it = it && typeof it === 'object' ? it : {};
      var carbs = strictNum(it.carbsG);
      if (carbs == null || carbs < 0) {
        currentBlocking.push('« ' + (it.name || ('Aliment ' + (index + 1))) +
          ' » : quantité de glucides invalide.');
        carbs = 0;
      }
      return Object.assign({}, it, {
        name: (it.name || 'Aliment').toString(),
        carbsG: Math.max(0, Math.round(carbs)),
        estimatedMassG: nonNeg(it.estimatedMassG),
        carbDensityPer100g: nonNeg(it.carbDensityPer100g),
        proteinG: nonNeg(it.proteinG),
        fatG: nonNeg(it.fatG),
        kcal: nonNeg(it.kcal),
        gi: nonNeg(it.gi),
        confidence: normConf(it.confidence)
      });
    });
    result.items = items;

    var total = items.reduce(function (s, it) { return s + it.carbsG; }, 0);
    result.totalCarbsG = Math.round(total);

    // Quantiles empiriques q10/q90 sur le banc (368 estimations).
    var band = result.fromText ? [0.62 * 0.9, 1.66 * 1.15] : [0.62, 1.66];
    result.rangeLowG = Math.max(0, Math.round(total * band[0]));
    result.rangeHighG = Math.round(total * band[1]);

    result.totalProteinG = sumOf(items, 'proteinG');
    result.totalFatG = sumOf(items, 'fatG');
    result.totalKcal = sumOf(items, 'kcal');
    if (result.totalKcal == null && (result.totalProteinG != null || result.totalFatG != null)) {
      result.totalKcal = Math.round(4 * total + 4 * (result.totalProteinG || 0) +
                                    9 * (result.totalFatG || 0));
    }

    result.gi = (window.GI && window.GI.meal) ? window.GI.meal(items) : null;
    result.glycemicSpeed = glycemicSpeed(result._modelGlycemicSpeed || result.glycemicSpeed, total,
                                         result.totalFatG, result.totalProteinG, result.gi);
    result.alerts = plausibility(items, total);
    result.outOfDomain = outOfDomain(items, total);
    result.blocking = uniqueMessages(result.sourceBlocking.concat(currentBlocking,
      blocking(items, total, result.rangeLowG, result.rangeHighG)));
    return result;
  }

  /* Vitesse d'absorption. On part de l'avis du modèle, mais on le corrige si les
     macros le contredisent franchement : un repas très gras est retardé même si le
     modèle a répondu « rapide ». Le gras ralentit la vidange gastrique — c'est un
     fait nutritionnel stable, pas une prédiction de glycémie. */
  function glycemicSpeed(raw, carbsG, fatG, proteinG, gi) {
    var v = (raw || '').toString().toLowerCase()
      .replace(/[éè]/g, 'e').replace(/\s+/g, '');
    if (v.indexOf('rapide') !== -1) v = 'rapide';
    else if (v.indexOf('lente') !== -1 || v.indexOf('retard') !== -1) v = 'lente';
    else if (v.indexOf('moder') !== -1) v = 'moderee';
    else v = null;

    /* Le gras l'emporte sur tout : il ralentit la vidange gastrique, donc même un
       repas à IG élevé est retardé s'il est très gras (la pizza en est l'exemple
       type). C'est un fait nutritionnel stable, pas une prédiction de glycémie. */
    if (fatG != null && (fatG >= 25 || (fatG >= 15 && (proteinG || 0) >= 25))) {
      return 'lente';
    }

    /* L'IG mesuré prime ensuite sur l'appréciation libre du modèle, mais seulement
       si la table couvre l'essentiel du repas : sur une couverture partielle, l'IG
       calculé ne décrit qu'une partie de l'assiette. */
    if (gi && gi.coverage >= 0.7 && !gi.estimated) {
      if (gi.gi >= 70 && (fatG == null || fatG < 15)) return 'rapide';
      if (gi.gi < 55 && v !== 'rapide') return 'lente';
    }

    if (fatG != null && v === null && fatG < 5 && carbsG >= 20) return 'rapide';
    return v || 'moderee';
  }

  /* Contrôle de vraisemblance — dernier filet avant l'affichage.
     Un modèle peut se tromper d'un facteur 10 (virgule décimale perdue,
     portion multipliée, densité confondue entre cru et cuit) et renvoyer un
     JSON parfaitement valide. Rien ne l'attrapait : le chiffre s'affichait
     tel quel, prêt à être saisi dans une pompe.
     Ces contrôles sont arithmétiques et locaux — aucun appel réseau, aucun
     coût, et ils ne modifient jamais le résultat : ils le signalent. */
  /* Le banc (BENCHMARK.md) ne mesure QUE des assiettes filtrées : 20–130 g de
     glucides, 2 à 7 aliments, photographiées seules à la verticale. Le MAE des
     Réglages et la bande [0,62 ; 1,66] des fourchettes en sont tous deux tirés.
     Un plateau de restaurant à 190 g de glucides répartis sur dix plats sort de
     cette population : les chiffres de fiabilité affichés ailleurs n'y ont
     jamais été vérifiés, et le taire reviendrait à les faire passer pour acquis.

     Seules les bornes HAUTES sont signalées. Un en-cas sous 20 g sort lui aussi
     du filtre, mais l'erreur absolue y reste petite par construction : l'annoncer
     à chaque yaourt noierait l'avertissement qui compte. */
  var BENCH_MAX_CARBS_G = 130;
  var BENCH_MAX_ITEMS = 7;

  function outOfDomain(items, total) {
    var raisons = [];
    if (total > BENCH_MAX_CARBS_G) {
      raisons.push(Math.round(total) + ' g de glucides (banc mesuré jusqu\'à ' +
        BENCH_MAX_CARBS_G + ' g)');
    }
    var comptes = items.filter(function (it) { return (it.carbsG || 0) > 0; }).length;
    if (comptes > BENCH_MAX_ITEMS) {
      raisons.push(comptes + ' aliments glucidiques (banc mesuré jusqu\'à ' +
        BENCH_MAX_ITEMS + ')');
    }
    return raisons;
  }

  function plausibility(items, total) {
    var out = [];

    items.forEach(function (it) {
      var d = it.carbDensityPer100g;
      // Aucun aliment ne dépasse 100 g de glucides pour 100 g.
      if (d != null && (d < 0 || d > 100)) {
        out.push('« ' + it.name + ' » : densité annoncée de ' + Math.round(d) +
          ' g pour 100 g, ce qui est impossible.');
      }
      // Les glucides doivent découler de la masse et de la densité.
      if (it.estimatedMassG > 0 && d != null && d >= 0) {
        var attendu = it.estimatedMassG * d / 100;
        if (attendu > 2 && Math.abs(it.carbsG - attendu) > Math.max(8, attendu * 0.35)) {
          out.push('« ' + it.name + ' » : ' + it.carbsG + ' g de glucides annoncés, mais ' +
            Math.round(it.estimatedMassG) + ' g à ' + Math.round(d) + ' g/100 g donnent ' +
            Math.round(attendu) + ' g.');
        }
      }
      // Plus de glucides que le poids de l'aliment lui-même.
      if (it.estimatedMassG > 0 && it.carbsG > it.estimatedMassG) {
        out.push('« ' + it.name + ' » : ' + it.carbsG + ' g de glucides pour ' +
          Math.round(it.estimatedMassG) + ' g d\'aliment.');
      }
    });

    // Total hors de toute portion réaliste pour un seul repas.
    if (total > 400) {
      out.push('Total de ' + total + ' g pour un repas : c\'est très au-delà d\'une ' +
        'portion habituelle, vérifie les quantités.');
    }
    return out;
  }

  /* Incohérences BLOQUANTES, par opposition aux alertes qui se contentent
     d'avertir. Ce sont celles qui rendent le résultat inutilisable : pas
     « surveille ce chiffre », mais « ce chiffre ne veut rien dire ».

     La distinction compte parce que l'écran affiche ensuite un nombre de
     grammes destiné à être saisi dans une pompe. Un avertissement se lit ou ne
     se lit pas ; un blocage retire le nombre. */
  function blocking(items, total, low, high) {
    var out = [];

    if (!items.length) {
      out.push('Le modèle n\'a identifié aucun aliment.');
    }
    /* Renommer un aliment ne recalcule rien : les glucides et la densité restent
       ceux de l'aliment précédent. Le bouton invitait pourtant à « corriger le
       nom », et le résultat restait confirmable — « fromage blanc » devenu
       « flocons d'avoine » gardait ses glucides d'origine, avec l'apparence
       d'une correction faite. On bloque donc jusqu'à ce que les glucides de
       cette ligne soient repris à la main. */
    items.forEach(function (it) {
      if (!it.needsNutrition) return;
      out.push('« ' + it.name + ' » vient d\'être renommé : ses ' +
        Math.round(it.carbsG || 0) + ' g de glucides sont encore ceux de « ' +
        (it.renamedFrom || 'l\'aliment précédent') +
        ' ». Corrige les glucides de cette ligne, ou relance l\'analyse.');
    });
    if (!(total > 0)) {
      out.push('Total de glucides nul ou absent.');
    }
    /* Contradiction masse x densité assez forte pour rendre le chiffre
       inutilisable, et non plus seulement suspect. La version « alerte » se
       déclenche tôt ; ici on exige plus de 15 g ET plus de 50 % du calcul.
       Cela bloque 50 g attendus contre 80 g annoncés, tout en laissant 28/40
       comme alerte à relire plutôt que comme impasse. */
    items.forEach(function (it) {
      var d = it.carbDensityPer100g;
      if (!(it.estimatedMassG > 0) || d == null || !(d >= 0)) return;
      var attendu = it.estimatedMassG * d / 100;
      var ecart = Math.abs((it.carbsG || 0) - attendu);
      if (attendu > 2 && ecart > Math.max(15, attendu * 0.5)) {
        out.push('« ' + it.name + ' » : ' + Math.round(it.carbsG || 0) +
          ' g de glucides annoncés, mais ' + Math.round(it.estimatedMassG) + ' g à ' +
          Math.round(d) + ' g/100 g en donnent ' + Math.round(attendu) +
          '. Corrige la masse, la densité ou les glucides.');
      }
    });
    if (total > 400) {
      out.push('Total supérieur à 400 g : résultat bloqué jusqu\'à correction des quantités.');
    }
    if (low > high) {
      out.push('Fourchette inversée : ' + Math.round(low) + ' g à ' + Math.round(high) + ' g.');
    }

    /* Le modèle se contredit lui-même : le total annoncé ne correspond pas à la
       somme de ses propres aliments. On ne peut pas trancher lequel est faux. */
    var somme = items.reduce(function (s, it) { return s + (it.carbsG || 0); }, 0);
    if (total > 0 && somme > 0 && Math.abs(somme - total) > Math.max(5, total * 0.2)) {
      out.push('Le total annoncé (' + total + ' g) ne correspond pas à la somme des ' +
               'aliments listés (' + Math.round(somme) + ' g).');
    }

    items.forEach(function (it) {
      if (it.estimatedMassG > 0 && it.carbsG > it.estimatedMassG * 1.02) {
        out.push('« ' + it.name + ' » contient plus de glucides que son poids total.');
      }
      var d = it.carbDensityPer100g;
      if (d != null && d > 100) {
        out.push('« ' + it.name + ' » : densité de ' + Math.round(d) + ' g pour 100 g.');
      }
    });
    return out;
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
  // Les champs structurants ne tolèrent pas « 30 g », « environ 20 » ou une
  // chaîne partiellement numérique : parseFloat les accepterait en silence.
  function strictNum(v) {
    if (typeof v === 'string') {
      var s = v.trim().replace(',', '.');
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)) return null;
      v = Number(s);
    }
    return (typeof v === 'number' && isFinite(v)) ? v : null;
  }
  function uniqueMessages(list) {
    var seen = {};
    return (list || []).filter(function (message) {
      if (!message || seen[message]) return false;
      seen[message] = true;
      return true;
    });
  }
  function nonNeg(v) {
    var n = num(v);
    return (n != null && n >= 0) ? n : null;
  }
  function normConf(c) {
    c = (c || '').toString().toLowerCase();
    return (c === 'high' || c === 'medium' || c === 'low') ? c : 'medium';
  }

  var PROVIDER_LABEL = {
    claude: 'Anthropic (Claude)', gemini: 'Google (Gemini)',
    openai: 'OpenAI (ChatGPT)', openrouter: 'OpenRouter'
  };

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
    images = images || [];
    // Sans photo, la description devient la seule source : elle est obligatoire.
    ctx = ctx || {};
    if (!images.length && !((ctx.notes && ctx.notes.trim()) ||
                            (ctx.extras && ctx.extras.trim()))) {
      return Promise.reject(new Error('Ajoute une photo, ou décris ton repas.'));
    }
    var prompt = buildUserPrompt(ctx);
    var callSettings = { provider: provider, apiKey: apiKey, model: model };
    var call = provider === 'openrouter' ? callOpenRouter
             : provider === 'openai' ? callOpenAI
             : provider === 'gemini' ? callGemini
             : callClaude;
    // Compté ici et pas dans l'interface : tous les appels passent par cette
    // fonction, y compris la vérification croisée et le banc d'essai.
    if (window.Storage && Storage.noteUsage) {
      try { Storage.noteUsage(provider, model); } catch (e) {}
    }
    return call(images, prompt, callSettings).then(function (result) {
      var out = sanitize(result, ctx);
      out.provider = provider;
      out.model = model;
      return out;
    });
  }

  var Estimator = {
    PROVIDER_LABEL: PROVIDER_LABEL,
    VENUES: LIEUX,

    // Exposés pour être testés sans réseau : ils décident du texte envoyé.
    mealMoment: mealMoment,
    contextBlock: contextBlock,
    sanitizeClarification: sanitizeClarification,
    CLARIF_SEUIL_G: CLARIF_SEUIL_G,
    buildPhotoPrompt: buildUserPrompt,

    /* images: [{base64, mediaType}], ctx: {referenceMode, viewMeasurements, notes, imageCount},
       settings: {provider, apiKeys, models}. Retourne une Promise du résultat normalisé. */
    estimate: function (images, ctx, settings) {
      return estimateProvider(settings.provider || 'claude', images, ctx, settings);
    },

    // Estimation forcée sur un fournisseur précis (pour le mode « 2ᵉ avis »).
    estimateWith: function (provider, images, ctx, settings) {
      return estimateProvider(provider, images, ctx, settings);
    },

    /* Recalcule tous les agrégats après une modification de la liste d'aliments :
       correction d'une portion, ou ajout d'un dessert / d'une boisson.
       Centralisé ici parce que le total n'est pas seul concerné — la charge
       glycémique et la vitesse d'absorption dépendent aussi des aliments, et
       les laisser figés afficherait des chiffres qui ne correspondent plus. */
    refresh: function (result) { return recompute(result); },

    /* Après une correction, la réponse brute reste signalée jusqu'à une action
       distincte où l'utilisateur confirme avoir repris le calcul aliment par
       aliment. Cette action ne masque pas les incohérences encore présentes :
       recompute() les recrée immédiatement depuis les valeurs courantes. */
    acceptManualRecalculation: function (result) {
      if (!result || result.humanEdited !== true) return recompute(result);
      result.sourceBlocking = [];
      result.sourceReviewed = true;
      return recompute(result, []);
    },

    /* Deux décisions extraites de l'interface pour être testables sans écran.
       Elles portent sur des nombres et des chaînes, pas sur du DOM : les
       laisser dans app.js, c'était les rendre invérifiables — et ce sont
       précisément elles qui décident du chiffre affiché. */

    /* Moyenner deux avis n'a de sens que s'ils parlent du même repas. Deux
       bornes, parce qu'aucune ne suffit seule : le pourcentage laisse passer
       200 contre 260 g, l'absolu laisse passer 4 contre 8 g. */
    mergeAllowed: function (totalA, totalB, thresholdPct, maxAbsG) {
      var a = strictNum(totalA), b = strictNum(totalB);
      if (a == null || b == null || a <= 0 || b <= 0) return false;
      var pct = strictNum(thresholdPct);
      pct = (pct == null || pct <= 0) ? 20 : pct;
      var maxAbs = strictNum(maxAbsG);
      maxAbs = (maxAbs == null || maxAbs <= 0) ? 25 : maxAbs;
      var ecart = Math.abs(a - b), moyenne = (a + b) / 2;
      return ecart <= moyenne * (pct / 100) && ecart <= maxAbs;
    },

    /* Le même modèle appelé par deux fournisseurs ne fait pas deux avis :
       « gemini-3.1-flash-lite » et « google/gemini-3.1-flash-lite » sont un
       seul modèle affiché deux fois, et leur accord ne confirme rien. */
    sameUnderlyingModel: function (models) {
      var vus = {};
      var list = Array.isArray(models) ? models : [];
      for (var i = 0; i < list.length; i++) {
        var noyau = String(list[i] || '').toLowerCase().trim().split('/').pop();
        if (!noyau) continue;
        if (vus[noyau]) return true;
        vus[noyau] = true;
      }
      return false;
    },


    // Exposés pour les tests et pour que tous les futurs appelants passent par
    // exactement les mêmes garde-fous, sans recopier la logique dans l'UI.
    sanitize: sanitize,
    recompute: recompute,
    hasInput: function (images, ctx) {
      ctx = ctx || {};
      return !!((images && images.length) || (ctx.notes && ctx.notes.trim()) ||
                (ctx.extras && ctx.extras.trim()));
    },
    buildPrompt: buildUserPrompt
  };

  window.Estimator = Estimator;
})();
