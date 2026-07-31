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
    "   Si un objet-repère de dimension CONNUE est fourni (pompe à insuline, carte 85 mm,",
    "   pièce, diamètre d'assiette) : repère-le dans l'image et déduis l'échelle réelle",
    "   (cm par pixel). Puis MESURE chaque aliment en cm (longueur, largeur, et",
    "   diamètre/épaisseur visibles). Indique ces mesures dans 'assumptions'.",
    "   Procède DANS CET ORDRE, sans sauter d'étape :",
    "     1. localise le repère et estime la longueur en PIXELS de sa plus grande arête ;",
    "     2. échelle = dimension réelle connue ÷ cette longueur en pixels ;",
    "     3. reporte les deux nombres dans 'referenceUsed' (ex. « pompe 96,8 mm sur",
    "        ~310 px → 0,031 cm/px »). Un 'referenceUsed' sans ces deux nombres signifie",
    "        que la calibration n'a pas eu lieu : mets alors 'referenceFound': false.",
    "   ⚠️ PLAN DE MESURE. Le repère et les aliments doivent être à la MÊME distance de",
    "   l'objectif. Si le repère est posé sur la table et la nourriture dans une assiette",
    "   creuse ou surélevée, les aliments sont plus PRÈS de l'objectif : appliquer l'échelle",
    "   du repère les fait paraître plus gros qu'ils ne sont, et SURESTIME les glucides.",
    "   Quand tu vois cette configuration, dis-le dans 'notes' et corrige à la baisse.",
    "",
    "B. TROISIÈME DIMENSION (hauteur/épaisseur).",
    "   Avec plusieurs angles : croise-les pour juger le volume précisément (confiance haute).",
    "   Avec une seule vue de dessus : tu ne vois pas directement la hauteur — estime-la à",
    "   partir d'indices (ombres, empilement, type d'aliment) et considère-la comme la",
    "   principale inconnue géométrique de cet aliment (une vue de côté la lèverait).",
    "   ⇒ SAUF si le repère a lui-même une épaisseur connue et repose à plat à côté de",
    "   l'assiette : c'est alors la seule RÈGLE VERTICALE de l'image. Compare la hauteur",
    "   des aliments à celle du repère (« le tas de riz monte à environ deux fois",
    "   l'épaisseur de la pompe ≈ 5 cm ») et dis-le dans 'assumptions'. Une hauteur",
    "   ainsi rapportée à un objet vaut bien mieux qu'une hauteur devinée.",
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
    "   - Dans 'seen' : UNE phrase en français décrivant l'assiette telle que tu",
    "     la vois, comme si tu la décrivais à quelqu'un au téléphone. Mentionne",
    "     le contenant (assiette plate/creuse, bol, barquette) et ce qui est",
    "     partiellement caché. C'est le texte que l'utilisateur relira pour",
    "     confirmer que tu as bien lu SON repas.",
    "",
    "J. AS-TU VRAIMENT TROUVÉ LE REPÈRE ? — champ 'referenceFound'.",
    "   Mets true UNIQUEMENT si tu as effectivement localisé l'objet-repère dans",
    "   l'image et t'en es servi pour mesurer. Mets false s'il est hors cadre,",
    "   masqué, flou, ou si tu n'en es pas sûr.",
    "   Ne dis pas true « pour faire plaisir » : l'application resserre sa marge",
    "   d'erreur quand tu réponds true. Annoncer une mesure qui n'a pas eu lieu",
    "   produit une fausse précision sur une dose d'insuline.",
    "",
    "SORTIE : réponds UNIQUEMENT avec un objet JSON valide, sans texte ni balises markdown.",
    "Schéma exact :",
    "{",
    '  "seen": "une phrase décrivant l\'assiette telle que tu la vois",',
    '  "items": [',
    '    {',
    '      "name": "nom précis de ce que tu vois, en français",',
    '      "portionDescription": "portion + dimensions mesurées (ex: baguette ~55 cm ≈ 220 g)",',
    '      "estimatedMassG": nombre,',
    '      "carbDensityPer100g": nombre,',
    '      "carbsG": nombre,',
    '      "proteinG": nombre,',
    '      "fatG": nombre,',
    '      "kcal": nombre,',
    '      "gi": nombre | null,',
    '      "fromPhoto": true | false,',
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
    '  "referenceFound": true | false,',
    '  "referenceUsed": "objet-repère utilisé et échelle déduite (ex: pompe 96 mm → 0,3 cm/px)"',
    "}"
  ].join('\n');

  function buildUserPrompt(ctx) {
    // Mode description : rien à mesurer, tout repose sur le texte.
    if (!ctx.imageCount) return buildTextPrompt(ctx);

    var lines = ['Analyse ce repas et estime les glucides selon la méthode.'];
    /* Une mesure au capteur rend le bloc « objet-repère » caduc : garder les
       deux ferait cohabiter une échelle mesurée et une consigne de l'estimer,
       et surtout laisserait la consigne « baisse la confiance » contredire une
       mesure physique. */
    var measured = !!(ctx.depth && ctx.depth.ok);
    if (measured) {
      // rien ici : le bloc de mesure ci-dessous porte l'échelle et la hauteur
    } else if (ctx.referenceObject && ctx.referenceObject !== 'none') {
      var ref = ctx.referenceObject;
      if (ctx.plateDiameterCm) {
        ref = 'assiette de ' + ctx.plateDiameterCm + ' cm de diamètre';
      }
      lines.push('OBJET-REPÈRE présent, de dimension connue : ' + ref + '.');
      lines.push('Calibre l\'échelle à partir de ce repère, MESURE chaque aliment en cm, et');
      lines.push('reporte les mesures dans "assumptions". Comme la taille est mesurée, la');
      lines.push('fourchette ne doit couvrir que la densité/hauteur/sucre caché, pas la taille.');
      lines.push('Donne dans "referenceUsed" la longueur en pixels de l\'arête que tu as');
      lines.push('mesurée ET l\'échelle qui en découle, sinon mets "referenceFound": false.');
      if (!ctx.plateDiameterCm) {
        lines.push('Si ce repère a une épaisseur connue et repose à plat, sers-t\'en aussi');
        lines.push('comme règle VERTICALE pour juger la hauteur de ce qu\'il y a dans l\'assiette.');
      }
    } else {
      lines.push('Aucun objet-repère : estime l\'échelle via l\'assiette/les couverts et baisse la confiance.');
    }
    /* Mesure ARCore : de la géométrie, pas une estimation. On la place APRÈS le
       bloc repère parce qu'elle le remplace quand elle existe — et on dit
       explicitement ce qu'elle ne couvre pas, sinon le modèle prendrait le
       volume total pour celui des seuls aliments et gonflerait les portions. */
    var d = ctx.depth;
    if (d && d.ok) {
      lines.push('');
      lines.push('MESURE PHYSIQUE PAR CAPTEUR DE PROFONDEUR (fiable, ce ne sont pas des estimations) :');
      lines.push('- échelle réelle : ' + d.cmPerPixel.toFixed(4) + ' cm par pixel de cette image ;');
      lines.push('- volume total au-dessus du plan de la table : ' + Math.round(d.volumeCm3) + ' cm³ ;');
      lines.push('- surface occupée : ' + Math.round(d.areaCm2) + ' cm² ;');
      lines.push('- hauteur maximale : ' + d.heightMaxCm.toFixed(1) + ' cm, hauteur moyenne : ' +
                 d.heightMeanCm.toFixed(1) + ' cm.');
      lines.push('Sers-t\'en ainsi :');
      lines.push('- l\'échelle REMPLACE toute estimation de taille : mesure les aliments dessus ;');
      lines.push('- la hauteur est MESURÉE, donc la 3ᵉ dimension n\'est plus une inconnue :');
      lines.push('  ne gonfle pas la fourchette pour elle (voir B et E).');
      lines.push('⚠️ Ce volume est un MAJORANT du volume des aliments : le capteur mesure tout');
      lines.push('le relief au-dessus de la table, donc l\'assiette et son rebord y sont inclus.');
      lines.push('Déduis-en l\'épaisseur du contenant avant de répartir le volume entre les');
      lines.push('aliments, et dis dans "assumptions" ce que tu as retiré pour l\'assiette.');
      lines.push('⚠️ Le capteur ne voit que les surfaces visibles : ce qui est noyé sous une');
      lines.push('sauce ou caché sous un autre aliment n\'est PAS dans ce volume.');
    } else if (d && d.note) {
      lines.push('Une mesure de profondeur a été tentée sans succès (' + d.note + ') :');
      lines.push('rien à en tirer, procède normalement.');
    }
    if (ctx.imageCount > 1) {
      lines.push('Il y a ' + ctx.imageCount + ' angles du MÊME repas : croise-les pour le volume (hauteur incluse).');
    } else if (!measured) {
      lines.push('Une seule vue : tu ne vois pas directement la hauteur/épaisseur — estime-la et');
      lines.push('signale-la comme seule inconnue géométrique (une photo de côté la lèverait).');
    }
    if (ctx.notes && ctx.notes.trim()) {
      lines.push('Précisions de l\'utilisateur (fiables, à intégrer) : ' + ctx.notes.trim());
    }
    if (ctx.extras && ctx.extras.trim()) {
      lines.push('À COMPTER EN PLUS, mais ABSENTS DE LA PHOTO (l\'utilisateur les');
      lines.push('prévoit après le plat) : ' + ctx.extras.trim());
      lines.push('Ne les cherche pas dans l\'image. Ajoute-les comme aliments à part');
      lines.push('entière avec "fromPhoto": false, en te basant sur les portions usuelles.');
    }
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
    var cal = calibrationBlock();
    if (cal) lines.push(cal);
    lines.push('Réponds uniquement avec le JSON.');
    return lines.join('\n');
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
    '  "notes": "LA question qui resserrerait le plus l\'estimation",',
    '  "referenceUsed": ""',
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
        system_instruction: { parts: [{ text: systemFor(images) }] },
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

    return send(modern)
      .catch(function (err) {
        if (isTokenParamError(err)) return send(!modern);
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
    var fromText = !(ctx && ctx.imageCount);
    var refAsked = !fromText && !!(ctx && ctx.referenceObject && ctx.referenceObject !== 'none');

    /* Le repère ne compte que si le modèle l'a RÉELLEMENT trouvé.
       Auparavant on se fiait au réglage de l'utilisateur : dès qu'un repère
       était sélectionné, la marge d'erreur était resserrée de 6 points — même
       si la pompe était hors cadre, masquée ou floue, et que le modèle avait
       donc estimé à vue. C'était une fausse précision affichée au moment
       exact où une dose d'insuline est calculée.
       Faute de réponse explicite, on retombe sur « non trouvé » : mieux vaut
       une marge trop large qu'une marge trop serrée. */
    var refFound = refAsked && result.referenceFound === true;
    var hasReference = refFound;
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
        gi: nonNeg(it.gi),          // secours seulement : la table locale prime
        // Dessert / boisson annoncés mais absents de l'image : l'interface les
        // présente à part, pour ne pas les faire passer pour « vus ».
        added: !fromText && it.fromPhoto === false,
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
      // Une description ne permet pas de voir la portion : l'incertitude est
      // structurellement plus large, sauf si l'utilisateur a donné des poids
      // (auquel cas le modèle répond 'high' et on ne l'élargit qu'un peu).
      if (fromText) spread = Math.max(spread, conf === 'high' ? 0.14 : 0.28);
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

    // Index et charge glycémiques, calculés depuis la table locale (js/gi.js).
    var gi = (window.GI && window.GI.meal) ? window.GI.meal(items) : null;
    var alerts = plausibility(items, total);

    return {
      items: items,
      totalCarbsG: total,
      totalProteinG: totalProtein,
      totalFatG: totalFat,
      totalKcal: totalKcal,
      rangeLowG: Math.max(0, Math.round(low)),
      rangeHighG: Math.round(high),
      overallConfidence: conf,
      fromText: fromText,
      refAsked: refAsked,
      refFound: refFound,
      alerts: alerts,
      seen: (result.seen || '').toString().trim(),
      gi: gi,
      glycemicSpeed: glycemicSpeed(result.glycemicSpeed, total, totalFat, totalProtein, gi),
      glycemicNote: result.glycemicNote || '',
      notes: result.notes || '',
      referenceUsed: result.referenceUsed || ''
    };
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
    if (!images.length && !(ctx.notes && ctx.notes.trim())) {
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

    /* images: [{base64, mediaType}], ctx: {referenceObject, plateDiameterCm, notes, imageCount},
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
    refresh: function (result) {
      var items = (result && result.items) || [];
      var total = items.reduce(function (s, it) { return s + (it.carbsG || 0); }, 0);
      result.totalCarbsG = Math.round(total);

      var conf = result.overallConfidence;
      var spread = conf === 'high' ? 0.12 : conf === 'medium' ? 0.22 : 0.35;
      if (result.fromText) spread = Math.max(spread, conf === 'high' ? 0.14 : 0.28);
      result.rangeLowG = Math.max(0, Math.round(total * (1 - spread)));
      result.rangeHighG = Math.round(total * (1 + spread));

      result.totalProteinG = sumOf(items, 'proteinG');
      result.totalFatG = sumOf(items, 'fatG');
      result.totalKcal = sumOf(items, 'kcal');
      if (result.totalKcal == null && (result.totalProteinG != null || result.totalFatG != null)) {
        result.totalKcal = Math.round(4 * total + 4 * (result.totalProteinG || 0) +
                                      9 * (result.totalFatG || 0));
      }

      result.gi = (window.GI && window.GI.meal) ? window.GI.meal(items) : null;
      result.glycemicSpeed = glycemicSpeed(result.glycemicSpeed, total,
                                           result.totalFatG, result.totalProteinG, result.gi);
      return result;
    }
  };

  window.Estimator = Estimator;
})();
