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
    savedMeals: 'diabete.savedmeals.v1'
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
    openrouter: 'qwen/qwen3-vl-235b-a22b-thinking'
  };

  var PROVIDERS = ['claude', 'gemini', 'openai', 'openrouter'];

  var DEFAULT_SETTINGS = {
    /* Fournisseur par défaut : Gemini, pour son modèle 3.1 Flash-Lite — meilleur
       rapport précision/prix mesuré au banc d'essai (BENCHMARK.md), à environ
       0,002 $ l'analyse. Ce défaut ne concerne QUE les installations neuves :
       un réglage déjà enregistré n'est jamais écrasé. */
    provider: 'gemini',                                   // fournisseur actif
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
    /* Vérification croisée automatique. Un 2ᵉ modèle bon marché tourne en
       parallèle à chaque estimation ; on n'alerte que si l'écart dépasse le
       seuil. C'est le seul garde-fou capable de rattraper une erreur grossière
       du modèle principal, et à ce prix il n'y a pas de raison de l'éteindre. */
    verificationMode: 'off', // off | ask | auto
    verifyEnabled: false,    // compatibilité avant v37
    verifyProvider: 'openrouter',
    verifyThresholdPct: 20,
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
    mergeVerification: false,

    /* Outils expérimentaux — le bouton « Photo mesurée » (LiDAR sur iPhone Pro,
       ARCore sur Android).

       ALLUMÉ par défaut SUR CETTE BRANCHE uniquement. C'est la variante
       « avec relief » : elle existe pour mettre la mesure au point, et l'y
       trouver décochée à chaque installation n'aurait aucun sens. La branche
       sans-relief garde false, et c'est elle qui sert au quotidien.

       Ce que le bouton apporte réellement est l'ÉCHELLE de la photo, seule
       grandeur validée et seule transmise à l'estimateur. Le volume reste
       affiché mais n'entre pas dans le calcul des glucides : il est juste à 2 %
       sur un objet mat et plein, et ne voit qu'un tiers d'un contenu liquide
       sans que rien ne le signale. Voir ios-src/README.md. */
    experimentalTools: true
  };

  /* Clés API relues du Keystore au démarrage (APK). On les garde en mémoire
     pour que getSettings() reste SYNCHRONE : il est appelé partout, y compris
     dans des chemins de rendu, et le rendre asynchrone contaminerait tout
     l'appel. La lecture chiffrée, elle, n'a lieu qu'une fois, avant le premier
     rendu (voir Storage.hydrate). */
  var secureKeys = null;

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

  /* Écriture de l'historique avec gestion du quota. Les vignettes de repas pèsent
     lourd : quand le navigateur refuse d'écrire, on abandonne les plus anciennes
     images (pas les données) et on réessaie, plutôt que de perdre l'enregistrement. */
  function writeHistory(h) {
    if (write(KEYS.history, h)) return h;
    var trimmed = h.map(function (e) { return e; });
    for (var i = trimmed.length - 1; i >= 0; i--) {
      if (trimmed[i].thumb) {
        trimmed[i] = Object.assign({}, trimmed[i]);
        delete trimmed[i].thumb;
        if (write(KEYS.history, trimmed)) return trimmed;
      }
    }
    // Toujours trop gros : on tronque l'historique le plus ancien.
    while (trimmed.length > 10) {
      trimmed = trimmed.slice(0, Math.floor(trimmed.length / 2));
      if (write(KEYS.history, trimmed)) return trimmed;
    }
    return trimmed;
  }

  var Storage = {
    DEFAULT_MODELS: DEFAULT_MODELS,
    MODEL_CATALOG: MODEL_CATALOG,

    PROVIDERS: PROVIDERS,
    categoryOf: categoryOf,

    /* Relit les clés API chiffrées et, au premier lancement de l'APK, y déplace
       celles qui étaient encore en clair dans localStorage. À appeler AVANT le
       premier rendu ; sur le web c'est un no-op immédiat. */
    hydrate: function () {
      if (!native || !window.Native) return Promise.resolve(false);
      return window.Native.secure.load(PROVIDERS).then(function (stored) {
        var plain = (read(KEYS.settings, {}) || {}).apiKeys || {};
        var merged = {};
        var needsMigration = false;
        PROVIDERS.forEach(function (p) {
          var fromSecure = (stored && stored[p]) || '';
          merged[p] = fromSecure || plain[p] || '';
          if (!fromSecure && plain[p]) needsMigration = true;
        });
        secureKeys = merged;
        if (needsMigration) {
          // Migration : on chiffre, puis on efface la copie en clair.
          return window.Native.secure.save(merged).then(function () {
            var s = read(KEYS.settings, {}) || {};
            s.apiKeys = { claude: '', gemini: '', openai: '', openrouter: '' };
            write(KEYS.settings, s);
            return true;
          });
        }
        return true;
      }).catch(function () { return false; });
    },

    getSettings: function () {
      var s = read(KEYS.settings, {}) || {};
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
          if (secureKeys[p]) merged.apiKeys[p] = secureKeys[p];
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
      /* La fusion n'a de sens que si un second avis tourne à chaque estimation.
         En mode 'ask' ou 'off', il n'y a rien à moyenner. */
      merged.mergeVerification = !!merged.mergeVerification && merged.verificationMode === 'auto';
      return merged;
    },
    saveSettings: function (s) {
      if (native && window.Native) {
        secureKeys = Object.assign({}, s.apiKeys || {});
        window.Native.secure.save(secureKeys);
        // Le blob localStorage ne garde aucune clé en clair sur l'APK.
        var copy = Object.assign({}, s, {
          apiKeys: { claude: '', gemini: '', openai: '', openrouter: '' } });
        write(KEYS.settings, copy);
        return;
      }
      write(KEYS.settings, s);
    },

    getHistory: function () {
      return read(KEYS.history, []);
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
      if (native) this.prunePhotos(saved);
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
      if (!changed) return h;
      var saved = writeHistory(h);
      if (native) this.prunePhotos(saved);
      return saved;
    },
    clearHistory: function () {
      write(KEYS.history, []);
      if (native) this.prunePhotos([]);
    },
    // Réécrit l'historique tel quel (utilisé pour retirer les images en masse).
    replaceHistory: function (h) {
      return writeHistory(h || []);
    },
    deleteHistory: function (date) {
      var h = this.getHistory().filter(function (e) { return e.date !== date; });
      write(KEYS.history, h);
      if (native) this.prunePhotos(h);
      return h;
    },

    /* Supprime les fichiers image qu'aucune entrée ne référence plus. Se rattrape
       aussi toute seule si une écriture d'historique a échoué en cours de route. */
    prunePhotos: function (history) {
      if (!native || !window.Native) return Promise.resolve(0);
      var keep = (history || this.getHistory())
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
      return !!e && e.realSource !== 'estimation';
    },

    setHistoryReal: function (date, realCarbsG, source) {
      var h = this.getHistory();
      h.forEach(function (e) {
        if (e.date === date) {
          if (realCarbsG == null || realCarbsG === '') {
            delete e.realCarbsG;
            delete e.realSource;
          } else {
            e.realCarbsG = Math.max(0, Math.round(realCarbsG));
            e.realSource = source || e.realSource || 'estimation';
            e.draft = false;
          }
        }
      });
      return writeHistory(h);
    },
    // Calcule le biais personnel : compare estimé vs réel sur les repas corrigés.
    // Renvoie { count, meanRatio, pct } (pct > 0 = tendance à SOUS-estimer).
    getBias: function () {
      var self = this;
      var h = this.getHistory().filter(function (e) { return self.isReliableReal(e); });
      var ratios = [];
      h.forEach(function (e) {
        if (e.draft) return;
        var est = e.totalCarbsG, real = e.realCarbsG;
        if (est > 0 && real != null && real > 0) ratios.push(real / est);
      });
      if (!ratios.length) return { count: 0, meanRatio: 1, pct: 0 };
      var mean = ratios.reduce(function (s, r) { return s + r; }, 0) / ratios.length;
      return { count: ratios.length, meanRatio: mean, pct: Math.round((mean - 1) * 100) };
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
        if (e.draft) return;
        if (!(e.totalCarbsG > 0) || e.realCarbsG == null || !(e.realCarbsG > 0)) return;
        if (!self.isReliableReal(e)) return;
        var cat = dominantCategory(e.items);
        if (!cat) return;
        (groups[cat] = groups[cat] || []).push(e.realCarbsG / e.totalCarbsG);
      });
      return Object.keys(groups).map(function (cat) {
        var r = groups[cat];
        var mean = r.reduce(function (s, x) { return s + x; }, 0) / r.length;
        return { category: cat, count: r.length, meanRatio: mean, pct: Math.round((mean - 1) * 100) };
      }).filter(function (g) {
        return g.count >= minMeals;
      }).sort(function (a, b) {
        return Math.abs(b.pct) - Math.abs(a.pct);
      });
    },

    /* ----- Retrouver un repas déjà mangé -----
       Un repas passé dont la valeur RÉELLE a été relevée vaut mieux que
       n'importe quelle estimation : c'est une mesure, sur ce plat précis, avec
       tes portions habituelles. Le biais moyen, lui, mélange tous les repas.

       Comparaison volontairement simple, et locale : recouvrement des mots des
       noms d'aliments (indice de Jaccard) plus proximité du total. Pas
       d'empreinte d'image ni d'appel réseau — on cherche « le même plat »,
       pas « la même photo ». */
    findSimilarMeal: function (items, totalCarbsG) {
      var mots = function (list) {
        var set = {};
        (list || []).forEach(function (it) {
          if (!(it.carbsG > 0)) return;   // un aliment sans glucides ne caractérise pas le plat
          (it.name || '').toLowerCase()
            .replace(/[^a-zà-ÿ ]/g, ' ')
            .split(/\s+/)
            .forEach(function (w) { if (w.length >= 4) set[w] = true; });
        });
        return Object.keys(set);
      };

      var ref = mots(items);
      if (ref.length < 1 || !(totalCarbsG > 0)) return null;

      var best = null;
      this.getHistory().forEach(function (e) {
        if (!(e.realCarbsG > 0) || !(e.totalCarbsG > 0)) return;
        var autres = mots(e.items);
        if (!autres.length) return;
        var communs = ref.filter(function (w) { return autres.indexOf(w) !== -1; }).length;
        var union = ref.length + autres.length - communs;
        var jaccard = union ? communs / union : 0;
        // Totaux trop éloignés : ce n'est pas la même assiette, même si les
        // aliments se ressemblent.
        var ecart = Math.abs(e.totalCarbsG - totalCarbsG) / totalCarbsG;
        if (jaccard < 0.5 || ecart > 0.4) return;
        var score = jaccard - ecart * 0.5;
        if (!best || score > best.score) {
          best = { score: score, jaccard: jaccard, entry: e };
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
      return read(KEYS.savedMeals, []);
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
      write(KEYS.savedMeals, list);
      return list;
    },
    deleteSavedMeal: function (id) {
      var list = this.getSavedMeals().filter(function (m) { return m.id !== id; });
      write(KEYS.savedMeals, list);
      return list;
    },

    // ----- Sauvegarde / restauration -----
    /* L'export inclut les clés API : c'est ce qui rend une bascule PWA -> APK
       (ou un changement de téléphone) réellement transparente. En contrepartie
       le fichier contient des secrets facturables — il est marqué comme tel, et
       l'app le signale au moment de l'export pour qu'on ne le partage pas. */
    exportAll: function () {
      var out = {
        app: 'GlucoVision',
        formatVersion: 2,
        exportedAt: new Date().toISOString(),
        containsApiKeys: false,
        warning: 'Fichier personnel : il peut contenir tes clés API. Ne le partage pas.',
        data: {}
      };
      Object.keys(KEYS).forEach(function (name) {
        var raw = null;
        try { raw = localStorage.getItem(KEYS[name]); } catch (e) {}
        if (raw != null) { try { out.data[name] = JSON.parse(raw); } catch (e) {} }
      });
      /* Sur l'APK les clés ne sont plus dans le blob localStorage mais dans le
         Keystore : on les réinjecte ici, sinon la sauvegarde partirait sans
         elles et une restauration sur un autre appareil serait incomplète. */
      if (out.data.settings) {
        out.data.settings.apiKeys = Object.assign({}, this.getSettings().apiKeys);
      }
      var keys = out.data.settings && out.data.settings.apiKeys;
      if (keys) {
        out.containsApiKeys = Object.keys(keys).some(function (k) { return !!keys[k]; });
      }
      return out;
    },
    importAll: function (obj) {
      if (!obj || obj.app !== 'GlucoVision' || !obj.data) {
        throw new Error('Fichier non reconnu : ce n\'est pas une sauvegarde GlucoVision.');
      }
      var restored = [];
      Object.keys(KEYS).forEach(function (name) {
        if (!(name in obj.data)) return;
        var value = obj.data[name];
        /* Clés API : une sauvegarde faite sans clé (ou depuis un appareil où
           l'une d'elles était vide) ne doit pas effacer celles déjà en place.
           On ne remplace donc que les clés réellement renseignées dans le
           fichier, et on conserve les autres. */
        if (name === 'settings' && value) {
          var current = Storage.getSettings();
          var merged = Object.assign({}, current.apiKeys || {});
          var incoming = value.apiKeys || {};
          Object.keys(incoming).forEach(function (p) {
            if (incoming[p]) merged[p] = incoming[p];
          });
          value = Object.assign({}, value, { apiKeys: merged });
          // Sur l'APK, saveSettings redirige les clés vers le Keystore.
          Storage.saveSettings(value);
          restored.push(name);
          return;
        }
        write(KEYS[name], value);
        restored.push(name);
      });
      if (!restored.length) throw new Error('Sauvegarde vide : rien à restaurer.');
      return restored;
    },

    // ----- Aliments récents (mode manuel) -----
    getRecentFoods: function () {
      return read(KEYS.recentFoods, []);
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
      return read(KEYS.customFoods, []);
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
    }
  };

  window.Storage = Storage;
})();
