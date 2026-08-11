/* storage.js — persistance locale des réglages et de l'historique.
   Tout reste sur l'appareil. Rien n'est envoyé à un serveur.

   Deux supports selon la plateforme, choisis par js/native.js :
   - PWA : localStorage pour tout (limité à ~5 Mo, d'où le rognage des vignettes) ;
   - APK : localStorage pour les données, système de fichiers pour les photos et
     Keystore Android pour les clés API. Plus de quota, donc plus de rognage. */
(function () {
  'use strict';

  var native = window.Native && window.Native.isApp;

  var KEYS = {
    usage: 'diabete.usage.v1',
    settings: 'diabete.settings.v1',
    history: 'diabete.history.v1',
    disclaimer: 'diabete.disclaimer.v1',
    customFoods: 'diabete.customfoods.v1',
    recentFoods: 'diabete.recentfoods.v1',
    savedMeals: 'diabete.savedmeals.v1',
    packaging: 'diabete.emballages.v1',
    products: 'diabete.produits.v1'
  };

  /* Catalogue de modèles par fournisseur.

     Les notes portent l'ERREUR MESURÉE, pas une réputation. Elle vient d'un banc
     d'essai maison : 44 plats du jeu de données Nutrition5k (Google Research),
     pesés ingrédient par ingrédient, passés au prompt exact de l'application.
     « MAE » = écart absolu moyen en grammes de glucides entre l'estimation et la
     pesée. Voir BENCHMARK.md pour le protocole et les réserves.

     Deux avertissements qui comptent pour lire ces chiffres :
     - Les photos du jeu de données n'ont AUCUN objet-repère. Avec la pompe dans
       le cadre, l'erreur réelle est plus basse — mais elle l'est pour tous, donc
       le classement RELATIF tient.
     - À 44 plats, aucun écart entre deux modèles voisins n'est statistiquement
       significatif. Ces notes servent à écarter les mauvais choix, pas à
       départager 10,0 de 10,5. D'où la règle appliquée ici : à précision
       indistinguable, on prend le moins cher et le plus rapide. */
  var MODEL_CATALOG = {
    claude: [
      { id: 'claude-opus-5', label: 'Opus 5', note: 'raisonnement · MAE 12,0 g · le plus cher', stars: 2 },
      { id: 'claude-opus-4-8', label: 'Opus 4.8', note: 'raisonnement · non mesuré', stars: 2 },
      { id: 'claude-sonnet-5', label: 'Sonnet 5', note: 'MAE 14,5 g · surestime (+13 %)', stars: 1 },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5', note: 'rapide · MAE 12,7 g', stars: 2 }
    ],
    gemini: [
      { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite',
        note: 'RECOMMANDÉ · MAE 10,0 g · le plus rapide (4 s) · ~0,002 $', stars: 3 },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', note: 'non mesuré · payant uniquement', stars: 2 },
      { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash',
        note: 'MAE 14,6 g · sous-estime beaucoup (−30 %)', stars: 1 },
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', note: 'non mesuré', stars: 2 },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', note: 'rapide', stars: 2 },
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', note: 'très rapide', stars: 1 }
    ],
    openai: [
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', note: 'raisonnement · non mesuré', stars: 2 },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', note: 'MAE 12,5 g · équilibré', stars: 2 },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', note: 'MAE 17,8 g · surestime (+32 %) · à éviter', stars: 1 }
    ],
    /* OpenRouter : un seul compte pour tous les modèles. Les notes de prix sont
       ramenées au coût d'UNE estimation (photo + prompt + réponse), seule unité
       parlante ici — les tarifs au million de jetons ne disent rien. */
    openrouter: [
      { id: 'google/gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite',
        note: 'RECOMMANDÉ · MAE 10,0 g · 4 s · ~500 repas pour 1 $', stars: 3 },
      { id: 'x-ai/grok-4.5', label: 'Grok 4.5',
        note: 'MAE 9,9 g · le plus régulier · ~47 repas pour 1 $', stars: 3 },
      { id: 'qwen/qwen3-vl-235b-a22b-thinking', label: 'Qwen3-VL 235B Thinking',
        note: 'MAE 11,8 g · se trompe autrement que Gemini · 2ᵉ avis', stars: 3 },
      { id: 'qwen/qwen3-vl-235b-a22b-instruct', label: 'Qwen3-VL 235B',
        note: 'MAE 12,3 g · ~400 repas pour 1 $', stars: 2 },
      { id: 'openai/gpt-5.6-terra', label: 'GPT-5.6 Terra',
        note: 'MAE 12,5 g · ~63 repas pour 1 $', stars: 2 },
      { id: 'qwen/qwen3.7-flash', label: 'Qwen 3.7 Flash',
        note: 'MAE 12,6 g · imbattable en prix · ~2500 repas pour 1 $', stars: 2 },
      { id: 'qwen/qwen3.7-plus', label: 'Qwen 3.7 Plus',
        note: 'raisonnement · MAE 12,7 g · ~330 repas pour 1 $', stars: 2 },
      { id: 'anthropic/claude-opus-5', label: 'Claude Opus 5',
        note: 'MAE 12,0 g pour 35× le prix de Gemini · ~14 repas pour 1 $', stars: 2 },
      { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5',
        note: 'MAE 14,5 g · ~32 repas pour 1 $', stars: 1 },
      { id: 'google/gemini-3.6-flash', label: 'Gemini 3.6 Flash',
        note: 'MAE 14,6 g · sous-estime (−30 %) · ~43 repas pour 1 $', stars: 1 }
    ]
  };

  /* Anciens identifiants → modèle actuel équivalent. Sans cette table, un réglage
     enregistré il y a plusieurs versions continuerait d'appeler un modèle périmé
     (nettement moins bon en estimation visuelle) sans que rien ne le signale. */
  var MODEL_MIGRATIONS = {
    'gemini-2.0-flash': 'gemini-3.6-flash',
    'gemini-1.5-flash': 'gemini-3.5-flash',
    'gemini-1.5-pro': 'gemini-2.5-pro',
    'gemini-pro-vision': 'gemini-2.5-pro',
    'gpt-4o': 'gpt-5.6-terra',
    'gpt-4o-mini': 'gpt-5.6-luna',
    'gpt-4-turbo': 'gpt-5.6-terra',
    'gpt-4-vision-preview': 'gpt-5.6-terra',
    /* Vérification croisée : on passe à la variante « Thinking », qui raisonne
       avant de répondre. Sur une tâche d'estimation de volume, un modèle rapide
       tranche trop vite ; un désaccord signalé par un modèle qui a réellement
       raisonné vaut beaucoup plus qu'un désaccord dû à sa propre précipitation.
       Coût : ~0,014 $ par repas au lieu de 0,0005 $. */
    'qwen/qwen3.7-flash': 'qwen/qwen3-vl-235b-a22b-thinking'
  };

  /* Modèles par défaut suggérés par fournisseur — issus du banc d'essai (44
     plats pesés). Gemini 3.1 Flash-Lite est le meilleur rapport qualité/prix
     mesuré : à égalité de précision avec des modèles 35× plus chers, et le plus
     rapide. Gemini 3.6 Flash, l'ancien défaut, sous-estimait de 30 % en moyenne.

     Aucune migration automatique n'est déclarée pour autant : un modèle qui
     fonctionne ne doit pas être remplacé dans le dos de l'utilisateur, parce que
     c'est ce modèle qui produit le nombre saisi dans la pompe. Le changement se
     fait dans les Réglages, sciemment. */
  var DEFAULT_MODELS = {
    claude: 'claude-opus-5',
    gemini: 'gemini-3.1-flash-lite',
    openai: 'gpt-5.6-terra',
    /* Grok 4.5 : à égalité stricte avec Gemini 3.1 Flash-Lite sur les 44 plats
       de la manche 3 (9,8 g d'écart absolu moyen l'un et l'autre), avec le
       meilleur 9ᵉ décile de tout le tableau et le plus fort taux de réponses à
       moins de 15 g. Il coûte dix fois plus cher et met dix fois plus de temps :
       c'est exactement ce qu'on veut d'un SECOURS — appelé seulement quand le
       modèle principal a échoué, où la question n'est plus le prix. */
    openrouter: 'x-ai/grok-4.5'
  };

  var PROVIDERS = ['claude', 'gemini', 'openai', 'openrouter'];

  var DEFAULT_SETTINGS = {
    /* Fournisseur par défaut : Gemini, pour son modèle 3.1 Flash-Lite — meilleur
       rapport précision/prix mesuré au banc d'essai (BENCHMARK.md), à environ
       0,002 $ l'analyse. Ce défaut ne concerne QUE les installations neuves :
       un réglage déjà enregistré n'est jamais écrasé. */
    provider: 'gemini',                                   // fournisseur actif
    /* Secours : rejoué automatiquement si le fournisseur principal échoue.
       Sans lui, une panne côté Google faisait perdre l'estimation — au moment
       précis où l'assiette est déjà entamée et où la photo ne peut plus être
       refaite. Le second appel n'a lieu QUE sur échec du premier : il ne coûte
       rien tant que tout va bien.

       Choisi chez un autre fournisseur à dessein. Un secours servi par la même
       API que le principal tomberait avec elle, et ne serait pas un secours. */
    fallbackProvider: 'openrouter',
    compareProvider: '',                                  // compatibilité avant v37
    apiKeys: { claude: '', gemini: '', openai: '', openrouter: '' },
    models: {                                             // un modèle par fournisseur
      claude: DEFAULT_MODELS.claude,
      gemini: DEFAULT_MODELS.gemini,
      openai: DEFAULT_MODELS.openai,
      openrouter: DEFAULT_MODELS.openrouter
    },
    partSizeG: 10,       // 1 part = 10 g (standard France)
    roundHalf: true,     // arrondir les parts au 0,5
    remindEnabled: false, // rappel de contrôle après repas (APK uniquement)
    remindDelayMin: 0,    // 0 = délai calé sur la vitesse d'absorption estimée
    experimentalDepth: false, // échelle ARCore expérimentale, opt-in explicite
    /* Où tu manges habituellement. Passé au modèle avec le repas : une part de
       restaurant est plus grosse et plus riche qu'une part faite maison, et il
       n'a aucun moyen de le deviner depuis la photo. Vide = on ne dit rien
       plutôt que d'affirmer un lieu au hasard. */
    venue: '',
    /* Vérification croisée automatique. Un 2ᵉ modèle bon marché tourne en
       parallèle à chaque estimation ; on n'alerte que si l'écart dépasse le
       seuil. C'est le seul garde-fou capable de rattraper une erreur grossière
       du modèle principal, et à ce prix il n'y a pas de raison de l'éteindre. */
    verificationMode: 'ask', // off | ask | auto
    verifyEnabled: false,    // compatibilité avant v37
    /* Deuxième avis affiché EN MÊME TEMPS que le premier : Grok 4.5, via
       OpenRouter. C'est le deuxième du banc — à égalité stricte avec Gemini
       (9,8 g l'un et l'autre sur 44 plats) tout en se trompant autrement : il
       surestime de 5 % là où Gemini sous-estime de 8 %. Deux avis qui penchent
       du même côté ne servent à rien ; ceux-là encadrent.

       Mode « ask » par défaut, et la case est cochée d'avance : les deux
       estimations arrivent côte à côte à chaque repas, et c'est l'utilisateur
       qui tranche. Ça double le coût d'une analyse — environ 0,024 $ au lieu de
       0,002 $ — et c'est un choix assumé : le nombre sert à doser de l'insuline,
       et le banc n'a jamais pu départager les modèles à un seul avis. */
    verifyProvider: 'openrouter',
    verifyThresholdPct: 20,
    /* Troisième avis, à la demande, en bas du résultat. Il ne part JAMAIS tout
       seul : c'est le recours quand les deux premiers laissent un doute, et le
       doute est quelque chose que seul l'utilisateur constate.

       Claude Opus 5 pour ce rôle précis. Il n'est pas le plus précis du banc
       (12,0 g, milieu de tableau) et coûte trente fois Gemini, mais il vient
       d'une troisième famille et d'un troisième fournisseur : après un
       désaccord entre Gemini et Grok, c'est l'avis le plus indépendant qu'on
       puisse aller chercher. Le prix ne compte pas ici — il est payé une fois,
       sur décision explicite, pour lever une hésitation. */
    doubtProvider: 'claude',
    doubtModel: 'claude-opus-5',
    rolesV66: true,   // voir la migration unique dans getSettings
    /* Fusionner les deux avis en une moyenne, au lieu de n'afficher que
       l'alerte d'écart. Mesuré sur le banc (44 plats) : la moyenne de Gemini
       3.1 Flash-Lite et de Qwen3-VL 235B Thinking fait mieux que CHACUN des
       deux, sur les deux manches indépendantes (10,4 g contre 12,1 / 11,6 puis
       6,8 g contre 8,7 / 11,9). Le mécanisme est banal : leurs erreurs sont
       faiblement corrélées (r = +0,30), donc la moyenne annule une partie de
       la dispersion.

       Désactivé par défaut malgré ce résultat. À 38 plats comparables,
       l'intervalle de confiance à 95 % du gain contient encore zéro, et ce
       réglage déplace le nombre que l'utilisateur tape dans sa pompe : c'est
       à lui de l'activer, pas à une mise à jour de le décider. */
    mergeVerification: false
  };

  /* Clés API relues du Keystore au démarrage (APK). On les garde en mémoire
     pour que getSettings() reste SYNCHRONE : il est appelé partout, y compris
     dans des chemins de rendu, et le rendre asynchrone contaminerait tout
     l'appel. La lecture chiffrée, elle, n'a lieu qu'une fois, avant le premier
     rendu (voir Storage.hydrate). */
  var secureKeys = null;
  /* Sur l'APK, aucun enregistrement de réglages ne doit être possible avant
     une lecture réussie du Keystore. Sinon une erreur biométrique/système au
     démarrage pourrait être confondue avec quatre clés absentes et les effacer. */
  var secureReady = !native;

  // Limite d'historique. Sur l'APK les photos sont des fichiers, pas du base64
  // dans localStorage : on peut garder beaucoup plus de repas.
  var MAX_HISTORY = native ? 500 : 100;

  /* Classement d'un aliment par mots-clés. L'IA renvoie des noms libres
     (« purée maison », « demi-baguette »), donc on ne peut pas s'appuyer sur la
     base d'aliments : on reconnaît des racines de mots. L'ordre compte — les
     entrées les plus spécifiques d'abord (« pomme de terre » avant « pomme »). */
  var CATEGORY_RULES = [
    ['Féculents', /pomme de terre|patate|puree|purée|riz|pate|pâte|semoule|couscous|quinoa|boulgour|ble|blé|frite|gnocchi|polenta|maïs|mais/],
    ['Pain', /pain|baguette|biscotte|toast|tartine|brioche|viennois|croissant|wrap|tortilla|pita|bagel|burger|bun/],
    ['Légumineuses', /lentille|pois chiche|haricot|feve|fève|flageolet|soja/],
    ['Sucré', /gateau|gâteau|dessert|glace|chocolat|bonbon|biscuit|tarte|creme|crème|confiture|miel|sucre|patisserie|pâtisserie|cookie|crepe|crêpe|gaufre|compote/],
    ['Boissons', /jus|soda|coca|limonade|boisson|sirop|smoothie|biere|bière|vin/],
    ['Fruits', /pomme|banane|orange|fraise|raisin|poire|peche|pêche|abricot|mangue|ananas|kiwi|melon|cerise|prune|fruit/],
    ['Laitier', /lait|yaourt|yogourt|fromage|petit-suisse|skyr|feta|mozzarella/],
    ['Protéines', /poulet|boeuf|bœuf|porc|veau|agneau|dinde|jambon|steak|poisson|saumon|thon|cabillaud|crevette|oeuf|œuf|tofu|viande|saucisse|lardon/],
    ['Légumes', /salade|tomate|carotte|courgette|haricot vert|brocoli|epinard|épinard|poivron|concombre|chou|legume|légume|oignon|champignon/]
  ];

  function categoryOf(name) {
    var n = (name || '').toString().toLowerCase();
    for (var i = 0; i < CATEGORY_RULES.length; i++) {
      if (CATEGORY_RULES[i][1].test(n)) return CATEGORY_RULES[i][0];
    }
    return null;
  }

  // Catégorie qui apporte le plus de glucides au repas.
  function dominantCategory(items) {
    if (!items || !items.length) return null;
    var byCat = {};
    items.forEach(function (it) {
      var cat = categoryOf(it.name);
      if (!cat) return;
      byCat[cat] = (byCat[cat] || 0) + (it.carbsG || 0);
    });
    var best = null;
    Object.keys(byCat).forEach(function (c) {
      if (best === null || byCat[c] > byCat[best]) best = c;
    });
    return (best && byCat[best] > 0) ? best : null;
  }

  function isConfirmedMeal(e) {
    return !!e && e.draft !== true && e.confirmed !== false && e.blocked !== true &&
      !(e.blocking && e.blocking.length) && finite(e.totalCarbsG) > 0 &&
      finite(e.totalCarbsG) <= 400 &&
      !(e.dominantRequired === true && e.dominantConfirmed !== true);
  }

  var BIAS_MIN_RATIO = 0.5;
  var BIAS_MAX_RATIO = 1.5;
  function robustRatio(raw) {
    if (!raw.length) return { count: 0, meanRatio: 1, medianRatio: 1, pct: 0 };
    var ratios = raw.map(function (r) {
      return Math.max(BIAS_MIN_RATIO, Math.min(BIAS_MAX_RATIO, r));
    }).sort(function (a, b) { return a - b; });
    var mid = Math.floor(ratios.length / 2);
    var median = ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
    return {
      count: ratios.length,
      // Nom historique conservé pour les appelants existants ; la statistique
      // est désormais la médiane bornée, robuste aux corrections aberrantes.
      meanRatio: median,
      medianRatio: median,
      pct: Math.round((median - 1) * 100)
    };
  }

  var FOOD_STOP = {
    de: 1, du: 1, des: 1, la: 1, le: 1, les: 1, un: 1, une: 1, au: 1, aux: 1,
    et: 1, avec: 1, sans: 1, dans: 1, portion: 1, part: 1, tranche: 1, morceaux: 1,
    morceau: 1, demi: 1, demie: 1, entier: 1, entiere: 1, petit: 1, petite: 1,
    grand: 1, grande: 1, maison: 1, frais: 1, fraiche: 1, cuit: 1, cuite: 1,
    grille: 1, grillee: 1, roti: 1, rotie: 1, vapeur: 1,
    long: 1, grain: 1, nature: 1, sauce: 1,
    assiette: 1, bol: 1, verre: 1, tasse: 1, environ: 1, filet: 1, pave: 1
  };
  var FOOD_ALIASES = {
    patate: 'pomme_de_terre', patates: 'pomme_de_terre',
    potato: 'pomme_de_terre', potatoes: 'pomme_de_terre',
    frites: 'frite',
    pommes: 'pomme', apples: 'pomme', apple: 'pomme',
    pates: 'pate', pasta: 'pate', spaghettis: 'pate', spaghetti: 'pate',
    riz: 'riz', rice: 'riz', baguettes: 'baguette', pains: 'pain',
    blanche: 'blanc', blanches: 'blanc', blancs: 'blanc',
    complete: 'complet', completes: 'complet', complets: 'complet',
    bananes: 'banane', oranges: 'orange', tomates: 'tomate',
    poulets: 'poulet', chicken: 'poulet', saumons: 'saumon', salmon: 'saumon',
    yaourts: 'yaourt', yogourt: 'yaourt', yogourts: 'yaourt',
    oeufs: 'oeuf', eggs: 'oeuf', lentilles: 'lentille'
  };

  function normalizeFoodText(value) {
    var s = (value || '').toString().toLowerCase()
      .replace(/œ/g, 'oe').replace(/æ/g, 'ae');
    if (s.normalize) s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return s.replace(/\bpommes?\s+de\s+terre\b/g, ' pomme_de_terre ')
      .replace(/\bpois\s+chiches?\b/g, ' pois_chiche ')
      .replace(/\bharicots?\s+verts?\b/g, ' haricot_vert ')
      .replace(/[^a-z0-9_]+/g, ' ').trim();
  }

  function foodKey(value) {
    var tokens = normalizeFoodText(value).split(/\s+/).filter(Boolean).map(function (token) {
      if (FOOD_STOP[token]) return '';
      if (FOOD_ALIASES[token]) return FOOD_ALIASES[token];
      if (token.length > 5 && /s$/.test(token) && !/pois|mais/.test(token)) token = token.slice(0, -1);
      if (FOOD_STOP[token]) return '';
      if (FOOD_ALIASES[token]) return FOOD_ALIASES[token];
      return token.length >= 3 ? token : '';
    }).filter(Boolean);
    var unique = {};
    tokens.forEach(function (token) { unique[token] = true; });
    return Object.keys(unique).sort().join('|');
  }

  function sameFood(a, b) {
    var ka = foodKey(typeof a === 'string' ? a : a && a.name);
    var kb = foodKey(typeof b === 'string' ? b : b && b.name);
    return !!ka && ka === kb;
  }

  /* Appariement un-à-un : un même « riz » ne peut pas valider deux lignes et
     les non-appariés restent visibles pour la comparaison des avis. */
  function matchFoods(a, b) {
    var left = (Array.isArray(a) ? a : []).map(function (it, index) {
      return { item: it, index: index };
    }).filter(function (x) { return x.item && x.item.carbsG > 0; });
    var right = (Array.isArray(b) ? b : []).map(function (it, index) {
      return { item: it, index: index };
    }).filter(function (x) { return x.item && x.item.carbsG > 0; });
    var used = {};
    var pairs = [];
    var onlyA = [];
    left.forEach(function (leftEntry) {
      var found = -1;
      for (var j = 0; j < right.length; j++) {
        if (!used[j] && sameFood(leftEntry.item, right[j].item)) { found = j; break; }
      }
      if (found < 0) onlyA.push(leftEntry.item);
      else {
        used[found] = true;
        pairs.push({ aIndex: leftEntry.index, bIndex: right[found].index,
          a: leftEntry.item, b: right[found].item });
      }
    });
    var onlyB = right.filter(function (_, index) { return !used[index]; })
      .map(function (entry) { return entry.item; });
    return {
      pairs: pairs,
      onlyA: onlyA,
      onlyB: onlyB,
      coverageA: left.length ? pairs.length / left.length : 0,
      coverageB: right.length ? pairs.length / right.length : 0
    };
  }

  function read(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { return false; }
  }

  function isObject(v) {
    return !!v && Object.prototype.toString.call(v) === '[object Object]';
  }
  /* Sans ça, « pâtes » ne trouve pas « pates » et l'utilisateur conclut à tort
     que son produit n'est pas là. \u0300-\u036f est le bloc des accents
     combinants isolés par la décomposition NFD.

     Volontairement distinct de normalizeFoodText, qui sert à RECONNAÎTRE un
     aliment : celui-là mappe des synonymes et efface la ponctuation, ce qui
     déformerait un nom de marque. Ici on cherche une sous-chaîne dans un nom
     commercial. */
  function sansAccents(t) {
    var s = String(t == null ? '' : t).trim().toLowerCase();
    return s.normalize ? s.normalize('NFD').replace(/[\u0300-\u036f]/g, '') : s;
  }
  function finite(v) {
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  /* Open Food Facts normalise les différentes représentations d'un même GTIN :
     un UPC-A de 12 chiffres devient notamment un EAN-13 avec un zéro devant.
     Le stockage local doit faire exactement de même, sinon un produit trouvé en
     ligne disparaît au prochain scan hors connexion.

     On ne retire volontairement QUE les séparateurs visuels d'un code saisi à
     la main. `https://exemple/3017620422003` est un QR, pas un code-barres : en
     extraire tous les chiffres créerait une fausse clé de produit. */
  function barcodeDigits(value) {
    if (typeof value === 'number') {
      if (!isFinite(value) || value < 0 || Math.floor(value) !== value ||
          value > 9007199254740991) return null;
      value = String(value);
    }
    if (typeof value !== 'string') return null;
    var raw = value.trim();
    if (!raw || !/^\d[\d\s\-\u00a0]*$/.test(raw)) return null;
    var digits = raw.replace(/[\s\-\u00a0]/g, '');
    return /^\d{1,14}$/.test(digits) ? digits : null;
  }

  function leftPad(value, length) {
    while (value.length < length) value = '0' + value;
    return value;
  }

  function canonicalBarcode(value) {
    var digits = barcodeDigits(value);
    if (!digits) return null;
    var significant = digits.replace(/^0+/, '');
    if (!significant) return null;
    if (significant.length <= 7) return leftPad(significant, 8);
    if (significant.length === 8) return significant;
    if (significant.length <= 12) return leftPad(significant, 13);
    return significant.length <= 14 ? significant : null;
  }

  /* Indication seulement : Open Food Facts accepte aussi quelques codes fabriqués
     par des producteurs dont la clé GTIN est fausse. L'appelant peut donc
     avertir, mais ne doit pas refuser un scan uniquement à cause de ce résultat.
     null signifie que la saisie n'est pas un GTIN vérifiable. */
  function barcodeChecksumValid(value) {
    var code = canonicalBarcode(value);
    if (!code || [8, 12, 13, 14].indexOf(code.length) === -1) return null;
    var sum = 0, weight = 3;
    for (var i = code.length - 2; i >= 0; i--) {
      sum += parseInt(code.charAt(i), 10) * weight;
      weight = weight === 3 ? 1 : 3;
    }
    return ((10 - (sum % 10)) % 10) === parseInt(code.charAt(code.length - 1), 10);
  }
  function bounded(v, min, max, fallback) {
    v = finite(v);
    return v == null ? fallback : Math.max(min, Math.min(max, v));
  }
  function cleanProvider(v, fallback, allowEmpty) {
    if (allowEmpty && v === '') return '';
    return PROVIDERS.indexOf(v) !== -1 ? v : fallback;
  }
  function cleanModel(v, fallback) {
    return typeof v === 'string' && /^[a-zA-Z0-9._:/-]{1,120}$/.test(v) ? v : fallback;
  }
  function cleanKey(v) {
    return typeof v === 'string' ? v.trim().slice(0, 2048) : '';
  }

  /* Ne conserve que les réglages connus. En plus d'éviter les types impossibles
     dans l'UI, cette copie explicite empêche qu'un import contenant __proto__ ou
     des objets arbitraires ne contamine les objets utilisés par l'application. */
  function sanitizeSettings(raw) {
    raw = isObject(raw) ? raw : {};
    var out = Object.assign({}, DEFAULT_SETTINGS);
    out.provider = cleanProvider(raw.provider, DEFAULT_SETTINGS.provider, false);
    out.fallbackProvider = cleanProvider(raw.fallbackProvider,
      DEFAULT_SETTINGS.fallbackProvider, true);
    out.compareProvider = cleanProvider(raw.compareProvider, '', true);
    out.verifyProvider = cleanProvider(raw.verifyProvider,
      DEFAULT_SETTINGS.verifyProvider, true);
    out.doubtProvider = cleanProvider(raw.doubtProvider,
      DEFAULT_SETTINGS.doubtProvider, true);

    var rawModels = isObject(raw.models) ? raw.models : {};
    out.models = {};
    PROVIDERS.forEach(function (p) {
      out.models[p] = cleanModel(rawModels[p], DEFAULT_MODELS[p]);
    });
    out.doubtModel = cleanModel(raw.doubtModel, DEFAULT_SETTINGS.doubtModel);

    var rawKeys = isObject(raw.apiKeys) ? raw.apiKeys : {};
    out.apiKeys = {};
    PROVIDERS.forEach(function (p) { out.apiKeys[p] = cleanKey(rawKeys[p]); });

    out.partSizeG = bounded(raw.partSizeG, 5, 20, DEFAULT_SETTINGS.partSizeG);
    out.roundHalf = raw.roundHalf == null ? DEFAULT_SETTINGS.roundHalf : raw.roundHalf === true;
    out.remindEnabled = raw.remindEnabled === true;
    out.remindDelayMin = bounded(raw.remindDelayMin, 0, 1440, DEFAULT_SETTINGS.remindDelayMin);
    out.experimentalDepth = raw.experimentalDepth === true;
    out.venue = /^(maison|restaurant|cantine)$/.test(raw.venue || '') ? raw.venue : '';
    out.verificationMode = /^(off|ask|auto)$/.test(raw.verificationMode || '')
      ? raw.verificationMode : DEFAULT_SETTINGS.verificationMode;
    out.verifyEnabled = raw.verifyEnabled === true;
    out.verifyThresholdPct = bounded(raw.verifyThresholdPct, 1, 100,
      DEFAULT_SETTINGS.verifyThresholdPct);
    out.mergeVerification = raw.mergeVerification === true && out.verificationMode === 'auto';
    out.rolesV66 = raw.rolesV66 === true;
    return out;
  }

  function safeClone(value, depth) {
    depth = depth || 0;
    if (depth > 10) return null;
    if (value == null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return isFinite(value) ? value : null;
    if (typeof value === 'string') return value.slice(0, 5 * 1024 * 1024);
    if (Array.isArray(value)) {
      return value.slice(0, 2000).map(function (v) { return safeClone(v, depth + 1); });
    }
    if (!isObject(value)) return null;
    var out = {};
    Object.keys(value).slice(0, 250).forEach(function (key) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') return;
      out[key] = safeClone(value[key], depth + 1);
    });
    return out;
  }

  function shortText(value, max) {
    return typeof value === 'string' ? value.trim().slice(0, max || 200) : '';
  }

  function baseUnit(value) {
    return value === 'ml' ? 'ml' : value === 'g' ? 'g' : null;
  }

  function positiveNumber(value, max) {
    value = finite(value);
    return value != null && value > 0 && value <= (max || 1000000000) ? value : null;
  }

  /* Les poids/comptages restent fortement bornés par `positiveNumber`, mais un
     horodatage JavaScript vaut déjà ~1,8 × 10^12. Le plafond générique de 10^9
     le transformait donc en zéro et cassait récence, migration et purge. */
  function timestampNumber(value) {
    return positiveNumber(value, Number.MAX_SAFE_INTEGER);
  }

  function packageFingerprint(value, unit) {
    var raw = isObject(value) ? (isObject(value.package) ? value.package : value) : null;
    var total = raw
      ? positiveNumber(raw.total != null ? raw.total : raw.totalBaseQuantity)
      : positiveNumber(value);
    var unite = baseUnit(unit || (raw && (raw.unite || raw.baseUnit || raw.unit)));
    if (total == null || !unite) return null;
    // Six décimales évitent les variations de sérialisation sans confondre deux
    // poids réalistes différents. OFF fournit en pratique au plus deux décimales.
    return unite + ':' + String(Math.round(total * 1000000) / 1000000);
  }

  function normalizePackageFacts(value, fallbackSource) {
    var raw = isObject(value) ? (isObject(value.package) ? value.package : value) : null;
    if (!raw) return null;
    var total = positiveNumber(raw.total != null ? raw.total : raw.totalBaseQuantity);
    var unite = baseUnit(raw.unite || raw.baseUnit || raw.unit);
    var fingerprint = packageFingerprint(total, unite);
    if (!fingerprint) return null;
    var source = raw.source;
    if (source !== 'off' && source !== 'user' && source !== 'legacy') {
      source = fallbackSource === 'off' ? 'off' : fallbackSource === 'legacy' ? 'legacy' : 'user';
    }
    var out = {
      total: total,
      unite: unite,
      source: source,
      fingerprint: fingerprint
    };
    var rawQuantity = shortText(raw.rawQuantity, 120);
    if (rawQuantity) out.rawQuantity = rawQuantity;
    return out;
  }

  function directUnitFingerprint(value, unit) {
    var weight = positiveNumber(value, 100000);
    var unite = baseUnit(unit);
    if (weight == null || !unite) return null;
    return 'unit:' + unite + ':' + String(Math.round(weight * 1000000) / 1000000);
  }

  function normalizeUnitDefinition(value, pack, legacy, confirmedBySetter) {
    var raw = isObject(value) ? (isObject(value.unit) ? value.unit : value) : null;
    if (!raw) return null;
    var methode = legacy ? 'paquet' : (raw.methode === 'unite' ? 'unite' : 'paquet');
    var unite = baseUnit(raw.unite || raw.baseUnit || (pack && pack.unite));
    var count = null, perUnit = null, fingerprint = null;
    if (methode === 'unite') {
      perUnit = positiveNumber(raw.parUnite != null ? raw.parUnite : raw.unitWeight, 100000);
      fingerprint = directUnitFingerprint(perUnit, unite);
      if (!fingerprint) return null;
    } else {
      if (!pack) return null;
      count = positiveNumber(raw.unites != null ? raw.unites
        : (raw.unitsPerPackage != null ? raw.unitsPerPackage : raw.count), 1000000);
      if (count == null || Math.floor(count) !== count) return null;
      fingerprint = pack.fingerprint;
      unite = pack.unite;
    }
    var ownFingerprint = typeof raw.fingerprint === 'string' ? raw.fingerprint : fingerprint;
    if (ownFingerprint !== fingerprint) return null;
    var confirmed = legacy || confirmedBySetter || raw.confirmed === true;
    if (!confirmed) return null;
    var source = raw.source || raw.method;
    if (legacy) source = 'legacy';
    if (source !== 'user' && source !== 'legacy' && source !== 'off-confirmed') source = 'user';
    return {
      methode: methode,
      unites: count,
      parUnite: perUnit,
      unite: unite,
      label: shortText(raw.label || raw.unitLabel, 24),
      confirmed: true,
      source: source,
      fingerprint: fingerprint,
      confirmedAt: timestampNumber(raw.confirmedAt || raw.ts) || Date.now()
    };
  }

  /* v2 sépare la vérité du paquet de la définition d'une unité consommable.
     Une ancienne entrée venait nécessairement du formulaire utilisateur : elle
     peut donc être migrée comme confirmation, liée à l'empreinte du paquet. */
  function normalizePackagingRecord(value) {
    if (!isObject(value)) return null;
    var structured = value.v === 2 || isObject(value.package);
    var pack = normalizePackageFacts(structured ? value.package : value,
      structured ? 'user' : 'legacy');
    var unit = normalizeUnitDefinition(structured ? value.unit : value,
      pack, !structured, false);
    if (!pack && !unit) return null;
    return {
      v: 2,
      package: pack,
      unit: unit,
      ts: timestampNumber(value.ts) || Date.now()
    };
  }

  function publicPackageFacts(value) {
    if (!value) return null;
    var out = {
      total: value.total,
      unite: value.unite,
      source: value.source,
      fingerprint: value.fingerprint
    };
    if (value.rawQuantity) out.rawQuantity = value.rawQuantity;
    return out;
  }

  function publicUnitDefinition(value) {
    if (!value) return null;
    return {
      methode: value.methode,
      unites: value.unites,
      parUnite: value.parUnite,
      unite: value.unite,
      label: value.label,
      confirmed: true,
      // Provenance séparée de la méthode de calcul paquet/unité.
      source: value.source,
      method: value.source,
      fingerprint: value.fingerprint,
      confirmedAt: value.confirmedAt
    };
  }

  function barcodeRecordPriority(entry, kind, canonical) {
    var value = entry.value || {};
    var priority = 0;
    if (kind === 'products' && value.source === 'perso') priority = 3;
    if (kind === 'packaging') {
      var normalized = normalizePackagingRecord(value);
      if (normalized && normalized.unit && normalized.unit.confirmed) {
        priority = normalized.unit.source === 'legacy' ? 2 : 3;
      } else if (normalized) priority = 1;
    }
    return {
      priority: priority,
      ts: timestampNumber(value.ts) || 0,
      canonical: entry.key === canonical ? 1 : 0
    };
  }

  function betterBarcodeRecord(candidate, current, kind, canonical) {
    if (!current) return candidate;
    var a = barcodeRecordPriority(candidate, kind, canonical);
    var b = barcodeRecordPriority(current, kind, canonical);
    if (a.priority !== b.priority) return a.priority > b.priority ? candidate : current;
    if (a.ts !== b.ts) return a.ts > b.ts ? candidate : current;
    return a.canonical > b.canonical ? candidate : current;
  }

  /* Consolide les anciennes clés (UPC-A brut, zéros variables) sans toucher aux
     clés non reconnues. Ces dernières ne sont jamais retournées, mais les garder
     évite qu'une simple lecture ne devienne une suppression destructive. */
  function readBarcodeMap(storageKey, kind) {
    var raw = read(storageKey, {});
    if (!isObject(raw)) return {};
    var groups = {}, out = {}, dirty = false;
    Object.keys(raw).forEach(function (key) {
      var canonical = canonicalBarcode(key);
      if (!canonical || !isObject(raw[key])) {
        out[key] = raw[key];
        return;
      }
      var entry = { key: key, value: raw[key] };
      groups[canonical] = betterBarcodeRecord(entry, groups[canonical], kind, canonical);
      if (canonical !== key || groups[canonical].key !== key) dirty = true;
    });
    Object.keys(groups).forEach(function (canonical) {
      out[canonical] = groups[canonical].value;
      var aliases = Object.keys(raw).filter(function (key) {
        return key !== canonical && canonicalBarcode(key) === canonical;
      });
      if (aliases.length) dirty = true;
    });
    if (dirty) write(storageKey, out); // migration opportuniste ; la lecture reste valable si quota plein
    return out;
  }

  function getBarcodeRecord(storageKey, kind, code) {
    var canonical = canonicalBarcode(code);
    if (!canonical) return null;
    var map = readBarcodeMap(storageKey, kind);
    return isObject(map[canonical]) ? { code: canonical, map: map, value: map[canonical] } : null;
  }

  function getNormalizedPackagingEntry(code) {
    var found = getBarcodeRecord(KEYS.packaging, 'packaging', code);
    if (!found) return null;
    var normalized = normalizePackagingRecord(found.value);
    if (!normalized) return null;
    /* `package:null` est volontairement valide pour une définition directe
       (par exemple « 1 biscuit pèse 18,5 g »). Ne la réécrivons pas à chaque
       lecture sous prétexte qu'elle n'a pas de paquet de référence. */
    var canonicalV2 = found.value.v === 2 &&
      Object.prototype.hasOwnProperty.call(found.value, 'package') &&
      Object.prototype.hasOwnProperty.call(found.value, 'unit');
    if (!canonicalV2) {
      found.map[found.code] = normalized;
      write(KEYS.packaging, found.map);
    }
    return { code: found.code, map: found.map, value: normalized };
  }

  function pruneBarcodeMap(map, max, kind) {
    var recognized = Object.keys(map).filter(function (key) {
      return canonicalBarcode(key) === key && isObject(map[key]);
    });
    if (recognized.length <= max) return map;
    recognized.sort(function (a, b) {
      var pa = barcodeRecordPriority({ key: a, value: map[a] }, kind, a);
      var pb = barcodeRecordPriority({ key: b, value: map[b] }, kind, b);
      return pb.priority - pa.priority || pb.ts - pa.ts;
    });
    recognized.slice(max).forEach(function (key) { delete map[key]; });
    return map;
  }

  function normalizeProductPack(value) {
    if (!isObject(value)) return null;
    var total = positiveNumber(value.total);
    if (total == null) return null;
    var out = {
      total: total,
      unite: baseUnit(value.unite) || 'g',
      unitesSuggerees: null,
      parUniteSuggeree: null,
      labelSuggere: shortText(value.labelSuggere, 24),
      suggestionConflit: value.suggestionConflit === true,
      confirme: false
    };
    /* `unites` est l'ancien nom ambigu. En cache produit il devient seulement
       une suggestion ; seule la définition séparée dans packaging peut être
       confirmée par l'utilisateur. */
    var units = positiveNumber(value.unitesSuggerees != null
      ? value.unitesSuggerees : value.unites, 1000000);
    if (units != null && Math.floor(units) === units) out.unitesSuggerees = units;
    var perUnit = positiveNumber(value.parUniteSuggeree, 100000);
    if (perUnit != null) out.parUniteSuggeree = perUnit;
    var rawQuantity = shortText(value.rawQuantity, 120);
    if (rawQuantity) out.rawQuantity = rawQuantity;
    return out;
  }

  function normalizeProductRecord(value, code) {
    if (!isObject(value)) return null;
    var carb = finite(value.carb), name = shortText(value.n, 120);
    if (!name || carb == null || carb < 0 || carb > 100) return null;
    var serving = positiveNumber(value.serving, 1000000);
    return {
      n: name,
      brand: shortText(value.brand, 60),
      carb: carb,
      code: code,
      serving: serving,
      pack: normalizeProductPack(value.pack),
      source: value.source === 'perso' ? 'perso' : 'off',
      ts: timestampNumber(value.ts) || 0
    };
  }

  function sanitizePortions(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 30).map(function (portion) {
      if (!Array.isArray(portion) || portion.length < 2) return null;
      var grams = finite(portion[1]);
      if (!(grams > 0) || grams > 5000) return null;
      return [shortText(portion[0], 80) || '1 portion', grams];
    }).filter(Boolean);
  }

  function sanitizeFoodList(value, custom) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 500).map(function (raw) {
      if (!isObject(raw)) return null;
      var name = shortText(raw.n, 160), carb = finite(raw.carb);
      if (!name || carb == null || carb < 0 || carb > 100) return null;
      return {
        id: shortText(raw.id, 80), n: name, carb: carb,
        portions: sanitizePortions(raw.portions),
        custom: custom ? true : raw.custom === true,
        cat: custom ? 'Perso' : shortText(raw.cat, 80)
      };
    }).filter(Boolean);
  }

  function sanitizeSavedMeals(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 40).map(function (raw) {
      if (!isObject(raw)) return null;
      var name = shortText(raw.name, 160);
      var items = Array.isArray(raw.items) ? raw.items.slice(0, 80).map(function (it) {
        if (!isObject(it)) return null;
        var itemName = shortText(it.name, 160), carbs = finite(it.carbsG);
        if (!itemName || carbs == null || carbs < 0 || carbs > 400) return null;
        return { name: itemName, carbsG: Math.round(carbs) };
      }).filter(Boolean) : [];
      if (!name || !items.length) return null;
      return {
        id: shortText(raw.id, 80) || ('m' + Date.now()),
        name: name,
        items: items,
        totalCarbsG: items.reduce(function (sum, it) { return sum + it.carbsG; }, 0),
        savedAt: finite(raw.savedAt) || Date.now()
      };
    }).filter(Boolean);
  }

  function sanitizeObjectMap(value, max) {
    if (!isObject(value)) return {};
    var out = {};
    Object.keys(value).slice(0, max || 500).forEach(function (key) {
      if (!/^\d{6,18}$/.test(key) || !isObject(value[key])) return;
      out[key] = safeClone(value[key]);
    });
    return out;
  }

  /* Une fusion sauvegardée est redondante exprès : le total affiché, ses deux
     sources, le snapshot et le second avis doivent tous raconter la même
     histoire. Cette fonction pure permet de vérifier cette cohérence avant de
     réafficher une moyenne après un redémarrage. */
  function validateStoredMerge(entry, snapshot, result, verification) {
    if (!isObject(entry) || !isObject(snapshot) || !isObject(result) ||
        !isObject(verification) || verification.ok !== true ||
        !Array.isArray(entry.mergedFrom) || entry.mergedFrom.length !== 2) return null;
    var primary = finite(entry.mergedFrom[0]);
    var verify = finite(entry.mergedFrom[1]);
    var snapshotMerged = finite(snapshot.mergedTotalCarbsG);
    var snapshotVerify = finite(snapshot.verifyTotalCarbsG);
    var entryTotal = finite(entry.totalCarbsG);
    var resultTotal = finite(result.totalCarbsG);
    var verificationTotal = finite(verification.total);
    var numbers = [primary, verify, snapshotMerged, snapshotVerify,
                   entryTotal, resultTotal, verificationTotal];
    if (numbers.some(function (n) { return n == null || n !== Math.round(n); }) ||
        !(primary > 0 && primary <= 400 && verify > 0 && verify <= 400)) return null;
    var merged = Math.round((primary + verify) / 2);
    if (resultTotal !== primary || snapshotMerged !== merged || snapshotVerify !== verify ||
        entryTotal !== merged || verificationTotal !== verify) return null;
    return { primaryTotal: primary, verifyTotal: verify, mergedTotal: merged };
  }

  function sanitizeHistoryList(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, MAX_HISTORY).map(function (raw) {
      if (!isObject(raw)) return null;
      var e = safeClone(raw);
      var date = finite(e.date);
      if (!(date > 0)) return null;
      e.date = date;
      var historyTotal = finite(e.totalCarbsG);
      if (historyTotal == null || historyTotal < 0 || historyTotal > 2000) return null;
      e.totalCarbsG = Math.round(historyTotal);
      if (e.realCarbsG != null) {
        var real = finite(e.realCarbsG);
        if (real == null || real < 0 || real > 2000) delete e.realCarbsG;
        else e.realCarbsG = Math.round(real);
      }
      e.source = /^(photo|texte|manuel)$/.test(e.source || '') ? e.source : 'manuel';
      /* Conservé pour pouvoir un jour calibrer PAR LIEU (« au restaurant, tu
         sous-estimes de 22 % »). Sans stockage aujourd'hui, ce calcul serait
         impossible demain : on ne rattrape pas un historique qu'on n'a pas. */
      if (!/^(maison|restaurant|cantine)$/.test(e.venue || '')) delete e.venue;
      e.provider = PROVIDERS.indexOf(e.provider) >= 0 ? e.provider : '';
      e.model = shortText(e.model, 200);
      e.seen = shortText(e.seen, 2000);
      e.glycemicSpeed = /^(rapide|moderee|lente)$/.test(e.glycemicSpeed || '')
        ? e.glycemicSpeed : null;
      var storedPartSize = finite(e.partSizeG);
      if (storedPartSize == null || storedPartSize < 5 || storedPartSize > 20) delete e.partSizeG;
      else e.partSizeG = storedPartSize;
      if (typeof e.thumb !== 'string' || e.thumb.length > 1024 * 1024 ||
          !/^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/=\s]+$/i.test(e.thumb)) {
        delete e.thumb;
      }
      if (typeof e.photo !== 'string' || e.photo.length > 120 ||
          !/^[a-z0-9][a-z0-9._-]*\.(?:jpe?g|png|webp)$/i.test(e.photo)) {
        delete e.photo;
      }
      if (isObject(e.gi)) {
        var giValue = finite(e.gi.gi), glValue = finite(e.gi.gl);
        if ((giValue == null || giValue < 0 || giValue > 100) &&
            (glValue == null || glValue < 0 || glValue > 2000)) delete e.gi;
        else e.gi = {
          gi: giValue != null && giValue >= 0 && giValue <= 100 ? giValue : null,
          gl: glValue != null && glValue >= 0 && glValue <= 2000 ? glValue : null
        };
      } else if (e.gi != null) {
        delete e.gi;
      }
      if (!Array.isArray(e.items)) e.items = [];
      else e.items = e.items.slice(0, 80).map(function (it) {
        if (!isObject(it)) return null;
        var name = shortText(it.name, 160), carbs = finite(it.carbsG);
        if (!name || carbs == null || carbs < 0 || carbs > 400) return null;
        return {
          name: name, carbsG: Math.round(carbs),
          portion: shortText(it.portion || it.portionDescription, 200),
          added: it.added === true
        };
      }).filter(Boolean);
      if (!Array.isArray(e.opinions)) e.opinions = [];
      else e.opinions = e.opinions.slice(0, 3).map(function (opinion) {
        if (!isObject(opinion)) return null;
        var total = finite(opinion.totalCarbsG);
        return {
          provider: PROVIDERS.indexOf(opinion.provider) >= 0 ? opinion.provider : '',
          model: shortText(opinion.model, 200),
          ok: opinion.ok === true && total != null && total >= 0 && total <= 400,
          totalCarbsG: total != null && total >= 0 && total <= 400 ? Math.round(total) : null,
          error: shortText(opinion.error, 500),
          items: Array.isArray(opinion.items) ? opinion.items.slice(0, 40).map(function (it) {
            if (!isObject(it)) return null;
            var name = shortText(it.name, 160), carbs = finite(it.carbsG);
            return name && carbs != null && carbs >= 0 && carbs <= 400
              ? { name: name, carbsG: Math.round(carbs), portion: shortText(it.portion, 200) }
              : null;
          }).filter(Boolean) : []
        };
      }).filter(Boolean);
      e.blocked = e.blocked === true || !!(e.blocking && e.blocking.length);
      if (e.draft != null) e.draft = e.draft === true;
      e.choiceRequired = e.choiceRequired === true;
      if (e.dominantRequired != null) e.dominantRequired = e.dominantRequired === true;
      if (e.dominantConfirmed != null) e.dominantConfirmed = e.dominantConfirmed === true;
      if (!isObject(e.resultSnapshot)) delete e.resultSnapshot;
      if (!isObject(e.input)) delete e.input;
      if (!isObject(e.verification)) delete e.verification;
      return e;
    }).filter(Boolean);
  }

  /* Écriture de l'historique avec gestion du quota. Les vignettes de repas pèsent
     lourd : quand le navigateur refuse d'écrire, on abandonne les plus anciennes
     images (pas les données) et on réessaie. Si cela ne suffit pas, on échoue
     explicitement : supprimer la moitié des repas en prétendant avoir réussi
     détruirait aussi leurs photos et les données de calibration. */
  function writeHistory(h) {
    h = sanitizeHistoryList(h);
    if (write(KEYS.history, h)) return h;
    var trimmed = h.map(function (e) { return Object.assign({}, e); });
    for (var i = trimmed.length - 1; i >= 0; i--) {
      if (trimmed[i].thumb) {
        trimmed[i] = Object.assign({}, trimmed[i]);
        delete trimmed[i].thumb;
        if (write(KEYS.history, trimmed)) return trimmed;
      }
    }
    return null;
  }

  var Storage = {
    DEFAULT_MODELS: DEFAULT_MODELS,
    MODEL_CATALOG: MODEL_CATALOG,

    PROVIDERS: PROVIDERS,
    categoryOf: categoryOf,
    isConfirmedMeal: isConfirmedMeal,
    validateStoredMerge: validateStoredMerge,

    /* Relit les clés API chiffrées et, au premier lancement de l'APK, y déplace
       celles qui étaient encore en clair dans localStorage. À appeler AVANT le
       premier rendu ; sur le web c'est un no-op immédiat. */
    hydrate: function () {
      if (!native || !window.Native) {
        secureReady = true;
        return Promise.resolve(false);
      }
      secureReady = false;
      return Promise.resolve().then(function () {
        return window.Native.secure.load(PROVIDERS);
      }).then(function (stored) {
        stored = isObject(stored) ? stored : {};
        var plainSettings = read(KEYS.settings, {}) || {};
        var plain = isObject(plainSettings.apiKeys) ? plainSettings.apiKeys : {};
        var merged = {};
        var needsMigration = false;
        var hasPlaintext = false;
        PROVIDERS.forEach(function (p) {
          var fromSecure = cleanKey(stored[p]);
          var fromPlain = cleanKey(plain[p]);
          merged[p] = fromSecure || fromPlain;
          if (!fromSecure && fromPlain) needsMigration = true;
          if (fromPlain) hasPlaintext = true;
        });
        if (hasPlaintext) {
          /* Migration : on chiffre si nécessaire, puis on efface toujours la
             copie en clair. Si une tentative précédente avait chiffré avant
             d'échouer sur localStorage, le lancement suivant retente donc bien
             le nettoyage au lieu de laisser le secret en clair indéfiniment. */
          var secureWrite = needsMigration
            ? Promise.resolve(window.Native.secure.save(merged))
            : Promise.resolve(true);
          return secureWrite.then(function (ok) {
            if (ok === false) throw new Error('Keystore indisponible.');
            var s = read(KEYS.settings, {}) || {};
            if (!isObject(s)) s = {};
            s.apiKeys = { claude: '', gemini: '', openai: '', openrouter: '' };
            if (!write(KEYS.settings, s)) {
              throw new Error('Impossible d\'effacer la copie locale des clés API.');
            }
            secureKeys = merged;
            secureReady = true;
            return true;
          });
        }
        secureKeys = merged;
        secureReady = true;
        return true;
      }).catch(function () {
        // APK : si le Keystore est illisible, aucune ancienne clé en clair ne
        // doit redevenir active par accident.
        secureKeys = { claude: '', gemini: '', openai: '', openrouter: '' };
        secureReady = false;
        return false;
      });
    },

    getSettings: function () {
      var raw = read(KEYS.settings, {}) || {};
      var s = isObject(raw) ? safeClone(raw) : {};
      var merged = Object.assign({}, DEFAULT_SETTINGS, s);
      // Objets complets (sans muter les valeurs par défaut).
      merged.apiKeys = Object.assign({}, DEFAULT_SETTINGS.apiKeys, s.apiKeys || {});
      merged.models = Object.assign({}, DEFAULT_SETTINGS.models, s.models || {});
      // Migration depuis l'ancien format (clé/modèle uniques).
      if (s.apiKey && !s.apiKeys) merged.apiKeys[s.provider || 'claude'] = s.apiKey;
      if (s.model && !s.models) merged.models[s.provider || 'claude'] = s.model;
      // APK : les clés font autorité depuis le Keystore, pas depuis localStorage.
      if (secureKeys) {
        PROVIDERS.forEach(function (p) {
          merged.apiKeys[p] = cleanKey(secureKeys[p]);
        });
      }
      // Remplace les modèles retirés par leur équivalent actuel.
      Object.keys(merged.models).forEach(function (p) {
        var repl = MODEL_MIGRATIONS[merged.models[p]];
        if (repl) merged.models[p] = repl;
      });
      /* v37 réunit l'ancien « 2e avis » et la vérification automatique sous un
         seul mode. On interprète les anciens réglages sans modifier leur blob :
         ils seront normalisés au prochain Enregistrer. */
      if (!s.verificationMode) {
        if (s.verifyEnabled) {
          merged.verificationMode = 'auto';
        } else if (s.compareProvider) {
          merged.verificationMode = 'ask';
          merged.verifyProvider = s.compareProvider;
        }
      }
      if (!/^(off|ask|auto)$/.test(merged.verificationMode)) {
        merged.verificationMode = 'off';
      }
      /* v66 — bascule UNIQUE vers les trois rôles issus de la manche 3 du banc :
         Gemini en principal, Grok 4.5 en second avis affiché côte à côte, Claude
         Opus 5 en troisième avis à la demande.

         C'est la seule migration de ce fichier qui change un comportement déjà
         choisi, et elle mérite d'être justifiée. La règle habituelle — ne jamais
         remplacer dans le dos de l'utilisateur le modèle qui produit le nombre
         saisi dans la pompe — vise à protéger un réglage DÉLIBÉRÉ. Or ici le
         mode de vérification valait 'off' parce que c'était le défaut d'alors,
         pas parce qu'on l'avait éteint.

         Le drapeau garantit qu'elle ne passe qu'une fois : si le second avis est
         ensuite désactivé, ce sera un choix, et il tiendra. Le modèle PRINCIPAL,
         lui, n'est jamais touché — c'est celui qui donne le chiffre. */
      if (!s.rolesV66) {
        merged.verificationMode = 'ask';
        merged.verifyProvider = 'openrouter';
        merged.models.openrouter = DEFAULT_MODELS.openrouter;
        merged.fallbackProvider = DEFAULT_SETTINGS.fallbackProvider;
        merged.doubtProvider = DEFAULT_SETTINGS.doubtProvider;
        merged.doubtModel = DEFAULT_SETTINGS.doubtModel;
        merged.rolesV66 = true;
        var brut = read(KEYS.settings, {}) || {};
        if (isObject(brut) && Object.keys(brut).length) {
          brut.rolesV66 = true;
          brut.verificationMode = 'ask';
          brut.verifyProvider = 'openrouter';
          brut.models = Object.assign({}, brut.models || {},
            { openrouter: DEFAULT_MODELS.openrouter });
          brut.fallbackProvider = DEFAULT_SETTINGS.fallbackProvider;
          brut.doubtProvider = DEFAULT_SETTINGS.doubtProvider;
          brut.doubtModel = DEFAULT_SETTINGS.doubtModel;
          write(KEYS.settings, brut);
        }
      }
      /* La fusion n'a de sens que si un second avis tourne à chaque estimation.
         En mode 'ask' ou 'off', il n'y a rien à moyenner. */
      merged.mergeVerification = !!merged.mergeVerification && merged.verificationMode === 'auto';
      return sanitizeSettings(merged);
    },
    saveSettings: function (s) {
      var normalized = sanitizeSettings(s);
      if (native && window.Native) {
        if (!secureReady) {
          return Promise.reject(new Error(
            'Keystore illisible : déverrouille le téléphone puis relance l’application avant d’enregistrer.'));
        }
        var nextKeys = Object.assign({}, normalized.apiKeys);
        var previousKeys = secureKeys
          ? Object.assign({}, secureKeys)
          : { claude: '', gemini: '', openai: '', openrouter: '' };
        // Le blob localStorage ne garde aucune clé en clair sur l'APK.
        var copy = Object.assign({}, normalized, {
          apiKeys: { claude: '', gemini: '', openai: '', openrouter: '' } });
        return Promise.resolve().then(function () {
          return window.Native.secure.save(nextKeys);
        }).then(function (ok) {
          if (ok === false) throw new Error('Keystore indisponible.');
          if (!write(KEYS.settings, copy)) {
            throw new Error('Impossible d\'enregistrer les réglages locaux.');
          }
          secureKeys = nextKeys;
          return normalized;
        }).catch(function (err) {
          // Promise.all peut rejeter après avoir déjà écrit une partie des
          // fournisseurs : on restaure donc toujours le snapshot précédent,
          // même si l'appel initial n'a jamais résolu avec succès.
          return Promise.resolve().then(function () {
            return window.Native.secure.save(previousKeys);
          }).then(function (ok) {
            if (ok === false) throw new Error('Restauration du Keystore refusée.');
            secureKeys = previousKeys;
            throw err;
          }, function () {
            secureKeys = { claude: '', gemini: '', openai: '', openrouter: '' };
            secureReady = false;
            throw new Error((err && err.message ? err.message : 'Échec des réglages') +
              ' (et restauration du Keystore impossible).');
          });
        });
      }
      if (!write(KEYS.settings, normalized)) {
        return Promise.reject(new Error('Impossible d\'enregistrer les réglages.'));
      }
      return Promise.resolve(normalized);
    },

    getHistory: function () {
      return sanitizeHistoryList(read(KEYS.history, []));
    },
    addHistory: function (entry) {
      return this.upsertHistory(entry);
    },
    /* Insère un repas ou met à jour le brouillon qui porte le même horodatage.
       Les corrections de portions peuvent donc être sauvegardées à chaque
       rendu sans créer une ligne d'historique par frappe. */
    upsertHistory: function (entry) {
      var h = this.getHistory();
      var idx = h.findIndex(function (e) { return e.date === entry.date; });
      if (idx >= 0) h[idx] = Object.assign({}, h[idx], entry);
      else h.unshift(entry);
      if (h.length > MAX_HISTORY) h = h.slice(0, MAX_HISTORY);
      /* PWA : les vignettes en base64 sont ce qui sature localStorage, on ne les
         garde donc que sur les repas récents. APK : l'image est un fichier, la
         référence pèse 20 octets — aucune raison de l'abandonner. */
      if (!native) {
        h.forEach(function (e, i) { if (i >= 40 && e.thumb) delete e.thumb; });
      }
      var saved = writeHistory(h);
      return saved;
    },
    updateHistory: function (date, patch) {
      var h = this.getHistory();
      var changed = false;
      h = h.map(function (e) {
        if (e.date !== date) return e;
        changed = true;
        return Object.assign({}, e, patch || {});
      });
      if (!changed) return null;
      var saved = writeHistory(h);
      return saved;
    },
    clearHistory: function () {
      if (!write(KEYS.history, [])) return null;
      if (native) this.prunePhotos([]).catch(function () { /* repris au prochain démarrage */ });
      return [];
    },
    // Réécrit l'historique tel quel (utilisé pour retirer les images en masse).
    replaceHistory: function (h) {
      var saved = writeHistory(h || []);
      return saved;
    },
    deleteHistory: function (date) {
      var h = this.getHistory().filter(function (e) { return e.date !== date; });
      var saved = writeHistory(h);
      if (!saved) return null;
      if (native) this.prunePhotos(saved).catch(function () { /* repris au prochain démarrage */ });
      return saved;
    },

    /* Supprime les fichiers image qu'aucune entrée ne référence plus. Se rattrape
       aussi toute seule si une écriture d'historique a échoué en cours de route. */
    prunePhotos: function (history) {
      if (!native || !window.Native) return Promise.resolve(0);
      var keep = (Array.isArray(history) ? history : this.getHistory())
        .map(function (e) { return e.photo; })
        .filter(Boolean);
      return window.Native.photos.prune(keep);
    },
    // Enregistre les glucides RÉELS d'un repas (pour l'apprentissage post-repas).
    /* La SOURCE de la valeur réelle compte autant que la valeur. Une pesée et
       une estimation à l'oeil ne méritent pas le même poids : calibrer le
       modèle sur une valeur elle-même estimée amplifie du bruit au lieu de le
       corriger. Par défaut on suppose une estimation personnelle, hypothèse
       prudente. */
    REAL_SOURCES: [
      { id: 'pesee', label: 'Pesé à la balance' },
      { id: 'etiquette', label: 'Lu sur l\'emballage' },
      { id: 'recette', label: 'Calculé depuis la recette' },
      { id: 'estimation', label: 'Estimation personnelle' }
    ],

    // Une estimation personnelle ne sert pas d'arbitre : ni pour le biais, ni
    // pour le banc d'essai.
    isReliableReal: function (e) {
      return !!e && (!e.realSource || e.realSource === 'pesee' ||
        e.realSource === 'etiquette' || e.realSource === 'recette');
    },

    setHistoryReal: function (date, realCarbsG, source) {
      var h = this.getHistory();
      var changed = false;
      h.forEach(function (e) {
        if (e.date === date) {
          changed = true;
          if (realCarbsG == null || realCarbsG === '') {
            delete e.realCarbsG;
            delete e.realSource;
          } else {
            e.realCarbsG = Math.max(0, Math.round(realCarbsG));
            e.realSource = source || e.realSource || 'estimation';
          }
        }
      });
      if (!changed) return null;
      return writeHistory(h);
    },
    // Calcule le biais personnel : compare estimé vs réel sur les repas corrigés.
    // Renvoie { count, meanRatio, pct } (pct > 0 = tendance à SOUS-estimer).
    getBias: function () {
      var self = this;
      var h = this.getHistory().filter(function (e) {
        return isConfirmedMeal(e) && self.isReliableReal(e);
      });
      var ratios = [];
      h.forEach(function (e) {
        var est = e.totalCarbsG, real = e.realCarbsG;
        if (est > 0 && finite(real) > 0 && real <= 400) ratios.push(real / est);
      });
      return robustRatio(ratios);
    },

    /* Biais par catégorie d'aliment. La valeur réelle est saisie pour le REPAS
       entier, pas par aliment : on attribue donc l'écart à la catégorie qui
       apporte le plus de glucides au repas. C'est une approximation, mais elle
       suffit à distinguer « je me trompe sur les féculents » de « sur les fruits ».
       minMeals évite de conclure sur un seul repas. */
    getBiasByCategory: function (minMeals) {
      minMeals = minMeals || 3;
      var groups = {};
      var self = this;
      this.getHistory().forEach(function (e) {
        if (!isConfirmedMeal(e)) return;
        if (finite(e.realCarbsG) == null || !(e.realCarbsG > 0) || e.realCarbsG > 400) return;
        if (!self.isReliableReal(e)) return;
        var cat = dominantCategory(e.items);
        if (!cat) return;
        (groups[cat] = groups[cat] || []).push(e.realCarbsG / e.totalCarbsG);
      });
      return Object.keys(groups).map(function (cat) {
        var r = groups[cat];
        var stat = robustRatio(r);
        return { category: cat, count: stat.count, meanRatio: stat.meanRatio,
          medianRatio: stat.medianRatio, pct: stat.pct };
      }).filter(function (g) {
        return g.count >= minMeals;
      }).sort(function (a, b) {
        return Math.abs(b.pct) - Math.abs(a.pct);
      });
    },

    foodKey: foodKey,
    sameFood: sameFood,
    matchFoods: matchFoods,
    canonicalBarcode: canonicalBarcode,
    barcodeChecksumValid: barcodeChecksumValid,
    packageFingerprint: packageFingerprint,

    /* ----- Retrouver un repas déjà mangé -----
       Un repas passé dont la valeur RÉELLE a été relevée vaut mieux que
       n'importe quelle estimation : c'est une mesure, sur ce plat précis, avec
       tes portions habituelles. Le biais moyen, lui, mélange tous les repas.

       Comparaison locale et volontairement stricte : identité canonique des
       aliments, appariement un-à-un et proximité du total. « Pomme » ne peut
       donc plus correspondre à « pomme de terre », ni une ligne à deux lignes. */
    findSimilarMeal: function (items, totalCarbsG) {
      var ref = (items || []).filter(function (it) { return it && it.carbsG > 0; });
      if (!ref.length || !(finite(totalCarbsG) > 0) || totalCarbsG > 400) return null;

      var best = null;
      var self = this;
      this.getHistory().forEach(function (e) {
        if (!isConfirmedMeal(e) || !self.isReliableReal(e) ||
            !(finite(e.realCarbsG) > 0) || e.realCarbsG > 400) return;
        var match = matchFoods(ref, e.items);
        if (!match.pairs.length || match.onlyA.length || match.onlyB.length) return;
        // Totaux trop éloignés : ce n'est pas la même assiette, même si les
        // aliments se ressemblent.
        var ecart = Math.abs(e.totalCarbsG - totalCarbsG) / totalCarbsG;
        if (ecart > 0.35) return;
        var score = 1 - ecart;
        if (!best || score > best.score) {
          best = { score: score, entry: e };
        }
      });
      if (!best) return null;
      return {
        date: best.entry.date,
        estimated: best.entry.totalCarbsG,
        real: best.entry.realCarbsG,
        realSource: best.entry.realSource || null,
        // Écart constaté ce jour-là, en pourcentage de l'estimation.
        pct: Math.round((best.entry.realCarbsG - best.entry.totalCarbsG) / best.entry.totalCarbsG * 100),
        names: (best.entry.items || []).filter(function (it) { return it.carbsG > 0; })
                 .map(function (it) { return it.name; }).slice(0, 3)
      };
    },

    /* ----- Consommation d'API -----
       Depuis qu'un fournisseur se facture à l'usage et qu'une vérification
       tourne à chaque repas, il faut pouvoir répondre à « combien ça me coûte ».
       On compte les appels par modèle et par mois ; le prix est appliqué à
       l'affichage, pour que corriger un tarif ne réécrive pas l'historique. */
    noteUsage: function (provider, model) {
      var u = read(KEYS.usage, {}) || {};
      var mois = new Date().toISOString().slice(0, 7);   // AAAA-MM
      u[mois] = u[mois] || {};
      var k = provider + '|' + model;
      u[mois][k] = (u[mois][k] || 0) + 1;
      // On ne garde que 13 mois : de quoi comparer à l'an dernier, pas plus.
      var mois_tries = Object.keys(u).sort().reverse().slice(0, 13);
      var garde = {};
      mois_tries.forEach(function (m) { garde[m] = u[m]; });
      write(KEYS.usage, garde);
      return garde;
    },

    getUsage: function (mois) {
      var u = read(KEYS.usage, {}) || {};
      if (mois) return u[mois] || {};
      return u;
    },

    // ----- Repas enregistrés (« mes repas fréquents ») -----
    getSavedMeals: function () {
      return sanitizeSavedMeals(read(KEYS.savedMeals, []));
    },
    saveMeal: function (name, items) {
      var list = this.getSavedMeals().filter(function (m) { return m.name !== name; });
      list.unshift({
        id: 'm' + Date.now(),
        name: name,
        items: items.map(function (it) {
          return { name: it.name, carbsG: Math.round(it.carbsG || 0) };
        }),
        totalCarbsG: items.reduce(function (s, it) { return s + Math.round(it.carbsG || 0); }, 0),
        savedAt: Date.now()
      });
      if (list.length > 40) list = list.slice(0, 40);
      return write(KEYS.savedMeals, list) ? list : null;
    },
    deleteSavedMeal: function (id) {
      var list = this.getSavedMeals().filter(function (m) { return m.id !== id; });
      write(KEYS.savedMeals, list);
      return list;
    },

    // ----- Sauvegarde / restauration -----
    /* Les clés API ne sortent jamais de leur support de stockage. Une ancienne
       sauvegarde qui en contenait peut encore être importée, mais tout nouvel
       export est partageable sans secret facturable. */
    exportAll: function () {
      var out = {
        app: 'GlucoVision',
        formatVersion: 3,
        exportedAt: new Date().toISOString(),
        containsApiKeys: false,
        warning: 'Fichier personnel sans clés API. Les photos originales de l’APK ne sont pas incluses.',
        /* Une restauration est annoncée comme un REMPLACEMENT. Chaque catégorie
           doit donc exister, même vide : omettre une clé jamais écrite ferait
           survivre les anciennes données du téléphone destinataire. */
        data: {
          usage: safeClone(read(KEYS.usage, {}) || {}),
          settings: safeClone(Storage.getSettings()),
          history: Storage.getHistory().map(function (entry) {
            var copy = safeClone(entry);
            /* Un nom de fichier interne n'est pas une sauvegarde de la photo.
               L'exporter créerait une image cassée sur l'autre téléphone. Les
               petites vignettes PWA en base64, elles, voyagent réellement. */
            delete copy.photo;
            return copy;
          }),
          disclaimer: Storage.disclaimerAccepted(),
          customFoods: Storage.getCustomFoods(),
          recentFoods: Storage.getRecentFoods(),
          savedMeals: Storage.getSavedMeals(),
          packaging: sanitizeObjectMap(read(KEYS.packaging, {}), 300),
          products: sanitizeObjectMap(read(KEYS.products, {}), 500)
        }
      };
      if (out.data.settings) {
        delete out.data.settings.apiKeys;
        delete out.data.settings.apiKey;
      }
      return out;
    },
    importAll: function (obj) {
      if (!obj || obj.app !== 'GlucoVision' || !isObject(obj.data)) {
        return Promise.reject(new Error('Fichier non reconnu : ce n\'est pas une sauvegarde GlucoVision.'));
      }

      var staged = {};
      var replaceAll = Number(obj.formatVersion) >= 3;
      var emptyFor = function (name) {
        if (name === 'settings' || name === 'usage' || name === 'packaging' || name === 'products') return {};
        if (name === 'disclaimer') return false;
        return [];
      };
      Object.keys(KEYS).forEach(function (name) {
        var present = Object.prototype.hasOwnProperty.call(obj.data, name);
        /* Les anciens formats étaient parfois partiels : on conserve leur
           sémantique d'import ciblé. Le format v3, lui, remplace explicitement
           toutes les catégories et remet une catégorie absente à vide. */
        if (!present && !replaceAll) return;
        var value = present ? obj.data[name] : emptyFor(name);
        if (name === 'settings') {
          var incoming = isObject(value) ? safeClone(value) : {};
          var current = Storage.getSettings();
          var keys = Object.assign({}, current.apiKeys);
          var importedKeys = isObject(incoming.apiKeys) ? incoming.apiKeys : {};
          PROVIDERS.forEach(function (p) {
            var candidate = cleanKey(importedKeys[p]);
            if (candidate) keys[p] = candidate;
          });
          // Compatibilité des sauvegardes très anciennes à clé unique.
          if (incoming.apiKey) {
            var legacyProvider = cleanProvider(incoming.provider, current.provider, false);
            keys[legacyProvider] = cleanKey(incoming.apiKey) || keys[legacyProvider];
          }
          incoming.apiKeys = keys;
          delete incoming.apiKey;
          staged[name] = sanitizeSettings(incoming);
        } else if (name === 'history') {
          staged[name] = sanitizeHistoryList(value);
          /* Le JSON n'embarque pas les octets des photos APK. Une référence
             importée seule pointerait vers un fichier arbitraire ou absent. */
          staged[name].forEach(function (entry) { delete entry.photo; });
        } else if (name === 'disclaimer') {
          staged[name] = value === true;
        } else if (name === 'usage') {
          staged[name] = isObject(value) ? safeClone(value) : {};
        } else if (name === 'packaging' || name === 'products') {
          staged[name] = sanitizeObjectMap(value, name === 'products' ? 500 : 300);
        } else if (name === 'savedMeals') {
          staged[name] = sanitizeSavedMeals(value);
        } else if (name === 'customFoods') {
          staged[name] = sanitizeFoodList(value, true);
        } else if (name === 'recentFoods') {
          staged[name] = sanitizeFoodList(value, false).slice(0, 12);
        } else {
          staged[name] = Array.isArray(value) ? safeClone(value).slice(0, 500) : [];
        }
      });

      var names = Object.keys(staged);
      if (!names.length) return Promise.reject(new Error('Sauvegarde vide : rien à restaurer.'));

      var snapshots = {};
      names.forEach(function (name) {
        try { snapshots[name] = localStorage.getItem(KEYS[name]); }
        catch (e) { snapshots[name] = null; }
      });
      function rollbackLocal() {
        names.forEach(function (name) {
          try {
            if (snapshots[name] == null) localStorage.removeItem(KEYS[name]);
            else localStorage.setItem(KEYS[name], snapshots[name]);
          } catch (e) {}
        });
      }

      var restored = [];
      try {
        names.forEach(function (name) {
          if (name === 'settings') return;
          if (!write(KEYS[name], staged[name])) {
            throw new Error('Restauration interrompue : impossible d\'écrire « ' + name + ' ».');
          }
          restored.push(name);
        });
      } catch (err) {
        rollbackLocal();
        return Promise.reject(err);
      }

      if (!staged.settings) return Promise.resolve(restored);
      return Storage.saveSettings(staged.settings).then(function () {
        restored.push('settings');
        return restored;
      }).catch(function (err) {
        rollbackLocal();
        throw err;
      });
    },

    // ----- Aliments récents (mode manuel) -----
    getRecentFoods: function () {
      return sanitizeFoodList(read(KEYS.recentFoods, []), false).slice(0, 12);
    },
    addRecentFood: function (food) {
      var list = this.getRecentFoods().filter(function (f) { return f.n !== food.n; });
      list.unshift({
        n: food.n, carb: food.carb,
        portions: food.portions || [], custom: !!food.custom, id: food.id
      });
      if (list.length > 12) list = list.slice(0, 12);
      write(KEYS.recentFoods, list);
      return list;
    },

    disclaimerAccepted: function () {
      return read(KEYS.disclaimer, false) === true;
    },
    acceptDisclaimer: function () {
      write(KEYS.disclaimer, true);
    },

    // ----- Aliments personnalisés -----
    getCustomFoods: function () {
      return sanitizeFoodList(read(KEYS.customFoods, []), true);
    },
    addCustomFood: function (food) {
      var list = this.getCustomFoods();
      food.id = 'c' + Date.now();
      food.cat = 'Perso';
      food.custom = true;
      list.unshift(food);
      write(KEYS.customFoods, list);
      return list;
    },
    deleteCustomFood: function (id) {
      var list = this.getCustomFoods().filter(function (f) { return f.id !== id; });
      write(KEYS.customFoods, list);
      return list;
    },

    /* ----- Emballages connus, par code-barres -----
       Le poids du paquet et la définition de l'unité sont deux vérités
       différentes. « 2 x 250 g » décrit parfois deux sachets, pas deux biscuits.
       Une unité n'est donc utilisable qu'après confirmation humaine et reste
       liée à l'empreinte poids+unité du paquet observé. */
    getPackageFacts: function (code) {
      var found = getNormalizedPackagingEntry(code);
      return found ? publicPackageFacts(found.value.package) : null;
    },
    setPackageFacts: function (code, info) {
      var c = canonicalBarcode(code), pack = normalizePackageFacts(info,
        info && info.source === 'off' ? 'off' : 'user');
      if (!c || !pack) return false;
      var map = readBarcodeMap(KEYS.packaging, 'packaging');
      var previous = normalizePackagingRecord(map[c]);
      var unit = previous && previous.unit &&
        ((previous.unit.methode === 'unite' && previous.unit.unite === pack.unite) ||
         previous.unit.fingerprint === pack.fingerprint)
        ? previous.unit : null;
      map[c] = { v: 2, package: pack, unit: unit, ts: Date.now() };
      pruneBarcodeMap(map, 300, 'packaging');
      return write(KEYS.packaging, map);
    },
    getUnitDefinition: function (code, currentPackage) {
      var found = getNormalizedPackagingEntry(code);
      if (!found || !found.value.unit) return null;
      if (found.value.unit.methode === 'unite') {
        if (currentPackage != null) {
          var directPack = normalizePackageFacts(currentPackage, 'off');
          if (!directPack || directPack.unite !== found.value.unit.unite) return null;
        }
        return publicUnitDefinition(found.value.unit);
      }
      if (!found.value.package) return null;
      var expected = currentPackage == null
        ? found.value.package.fingerprint
        : (typeof currentPackage === 'string'
          ? currentPackage : packageFingerprint(currentPackage));
      if (!expected || found.value.unit.fingerprint !== expected) return null;
      return publicUnitDefinition(found.value.unit);
    },
    setUnitDefinition: function (code, info) {
      var c = canonicalBarcode(code);
      if (!c || !isObject(info)) return false;
      var map = readBarcodeMap(KEYS.packaging, 'packaging');
      var previous = normalizePackagingRecord(map[c]);
      /* Ergonomie : le premier appel peut fournir le paquet et l'unité ensemble.
         Sinon, une définition sans poids de référence serait impossible à
         invalider lors d'un changement de format. */
      var pack = previous && previous.package;
      if (!pack) pack = normalizePackageFacts(info, info.source === 'off' ? 'off' : 'user');
      if (!pack && info.methode !== 'unite') return false;
      var unit = normalizeUnitDefinition(info, pack, false, true);
      if (!unit) return false;
      map[c] = { v: 2, package: pack, unit: unit, ts: Date.now() };
      pruneBarcodeMap(map, 300, 'packaging');
      return write(KEYS.packaging, map);
    },
    /* API historique gardée pour app.js : elle ne rend désormais qu'une
       définition confirmée et cohérente avec le paquet courant éventuel. */
    getPackaging: function (code, currentPackage) {
      var found = getNormalizedPackagingEntry(code);
      if (!found || !found.value.unit) return null;
      var storedPack = found.value.package;
      var pack = currentPackage == null
        ? storedPack : normalizePackageFacts(currentPackage, 'off');
      var unit = found.value.unit;
      if (unit.methode === 'unite' && pack && unit.unite !== pack.unite) return null;
      if (unit.methode === 'paquet' &&
          (!pack || unit.fingerprint !== pack.fingerprint)) return null;
      var provenance = unit.source;
      return {
        total: unit.methode === 'paquet' && pack ? pack.total : null,
        unites: unit.unites,
        parUnite: unit.methode === 'unite' ? unit.parUnite : pack.total / unit.unites,
        label: unit.label,
        unite: unit.unite,
        methode: unit.methode,
        confirmed: true,
        source: provenance,
        method: provenance,
        fingerprint: unit.fingerprint,
        fingerprintTotal: unit.methode === 'paquet' && pack ? pack.fingerprint : null,
        confirmedAt: unit.confirmedAt
      };
    },
    setPackaging: function (code, info) {
      if (!isObject(info)) return false;
      var normalizedInfo = Object.assign({ unite: 'g' }, info);
      var c = canonicalBarcode(code), pack = normalizePackageFacts(normalizedInfo, 'user');
      if (!c || (!pack && normalizedInfo.methode !== 'unite')) return false;
      var unit = normalizeUnitDefinition(normalizedInfo, pack, false, true);
      if (!unit) return false;
      var map = readBarcodeMap(KEYS.packaging, 'packaging');
      map[c] = { v: 2, package: pack, unit: unit, ts: Date.now() };
      pruneBarcodeMap(map, 300, 'packaging');
      return write(KEYS.packaging, map);
    },

    /* ----- Produits connus, par code-barres -----
       Deux manques que la base publique ne comblera pas :

       — OpenFoodFacts a des coupures régulières, et une cuisine n'a pas toujours
         de réseau. Sans cache, un produit scanné dix fois échoue dix fois.
       — Aucun catalogue n'est complet. Un produit absent n'était jusqu'ici qu'un
         cul-de-sac : « introuvable », et débrouille-toi.

       Un produit recopié une fois depuis l'étiquette devient donc permanent. La
       base utile n'est pas la plus grosse, c'est celle qui contient ce que tu
       achètes — et celle-là, seule ton usage peut la construire.

       source distingue ce qui vient d'OpenFoodFacts de ce que tu as saisi : on
       rafraîchit le premier quand le réseau répond, jamais le second, qui vient
       de l'emballage que tu avais sous les yeux. */
    getProduct: function (code) {
      var found = getBarcodeRecord(KEYS.products, 'products', code);
      return found ? normalizeProductRecord(found.value, found.code) : null;
    },
    setProduct: function (code, food, source) {
      var c = canonicalBarcode(code);
      if (!c || !isObject(food)) return false;
      var carb = finite(food.carb);
      if (carb == null || carb < 0 || carb > 100) return false;
      if (typeof food.n !== 'string' || !food.n.trim()) return false;

      var tous = readBarcodeMap(KEYS.products, 'products');
      var ancien = tous[c];
      /* Une réponse d'OpenFoodFacts n'écrase pas une saisie personnelle : tu as
         lu l'emballage, la base a été remplie par un inconnu. */
      if (isObject(ancien) && ancien.source === 'perso' && source !== 'perso') return false;

      tous[c] = {
        n: food.n.trim().slice(0, 120),
        brand: typeof food.brand === 'string' ? food.brand.slice(0, 60) : '',
        carb: carb,
        serving: finite(food.serving),
        pack: normalizeProductPack(food.pack),
        source: source === 'perso' ? 'perso' : 'off',
        ts: Date.now()
      };

      /* Purge par ancienneté, mais les saisies personnelles restent prioritaires. */
      pruneBarcodeMap(tous, 500, 'products');
      return write(KEYS.products, tous);
    },
    getProducts: function (limit) {
      var tous = readBarcodeMap(KEYS.products, 'products');
      var list = Object.keys(tous).map(function (code) {
        return canonicalBarcode(code) === code ? normalizeProductRecord(tous[code], code) : null;
      }).filter(Boolean).sort(function (a, b) { return b.ts - a.ts; });
      if (limit == null) return list;
      limit = Math.floor(Number(limit));
      if (!isFinite(limit) || limit < 0) return [];
      return list.slice(0, Math.min(limit, 5000));
    },
    countProducts: function () {
      return this.getProducts().length;
    },
    /* Recherche par nom dans les produits déjà rencontrés. Sert quand
       OpenFoodFacts ne répond pas : les produits qu'on rachète chaque semaine
       restent trouvables sans réseau. Comparaison sans accents ni casse, sinon
       « pâtes » ne trouverait pas « pates ». */
    searchProducts: function (query) {
      var q = sansAccents(query);
      if (q.length < 2) return [];
      return this.getProducts(500).filter(function (p) {
          return p && sansAccents(p.n + ' ' + p.brand).indexOf(q) !== -1;
        })
        .sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); })
        .slice(0, 20);
    }
  };

  window.Storage = Storage;
})();
