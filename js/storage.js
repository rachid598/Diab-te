/* storage.js — persistance locale des réglages et de l'historique.
   Tout reste dans le navigateur (localStorage). Rien n'est envoyé à un serveur. */
(function () {
  'use strict';

  var KEYS = {
    settings: 'diabete.settings.v1',
    history: 'diabete.history.v1',
    disclaimer: 'diabete.disclaimer.v1',
    customFoods: 'diabete.customfoods.v1',
    recentFoods: 'diabete.recentfoods.v1',
    savedMeals: 'diabete.savedmeals.v1'
  };

  // Catalogue de modèles par fournisseur. stars = indice de qualité/précision (1 à 3).
  var MODEL_CATALOG = {
    claude: [
      { id: 'claude-opus-5', label: 'Opus 5', note: 'précision max · raisonnement', stars: 3 },
      { id: 'claude-opus-4-8', label: 'Opus 4.8', note: 'très précis', stars: 3 },
      { id: 'claude-sonnet-5', label: 'Sonnet 5', note: 'équilibré · recommandé', stars: 2 },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5', note: 'rapide · économique', stars: 1 }
    ],
    gemini: [
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', note: 'le plus fin · gratuit', stars: 3 },
      { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', note: 'récent · gratuit · recommandé', stars: 3 },
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', note: 'gratuit', stars: 2 },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', note: 'rapide · gratuit', stars: 2 },
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', note: 'très rapide · gratuit', stars: 1 }
    ],
    openai: [
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', note: 'précision max · raisonnement', stars: 3 },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', note: 'équilibré · recommandé', stars: 2 },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', note: 'rapide · économique', stars: 1 }
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
    'gpt-4-vision-preview': 'gpt-5.6-terra'
  };

  // Modèles par défaut suggérés par fournisseur.
  var DEFAULT_MODELS = {
    claude: 'claude-sonnet-5',
    gemini: 'gemini-3.6-flash',
    openai: 'gpt-5.6-terra'
  };

  var DEFAULT_SETTINGS = {
    provider: 'claude',                                   // fournisseur actif
    compareProvider: '',                                  // 2ᵉ avis (vide = aucun)
    apiKeys: { claude: '', gemini: '', openai: '' },      // une clé par fournisseur
    models: {                                             // un modèle par fournisseur
      claude: DEFAULT_MODELS.claude,
      gemini: DEFAULT_MODELS.gemini,
      openai: DEFAULT_MODELS.openai
    },
    partSizeG: 10,       // 1 part = 10 g (standard France)
    roundHalf: true      // arrondir les parts au 0,5
  };

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

    getSettings: function () {
      var s = read(KEYS.settings, {}) || {};
      var merged = Object.assign({}, DEFAULT_SETTINGS, s);
      // Objets complets (sans muter les valeurs par défaut).
      merged.apiKeys = Object.assign({}, DEFAULT_SETTINGS.apiKeys, s.apiKeys || {});
      merged.models = Object.assign({}, DEFAULT_SETTINGS.models, s.models || {});
      // Migration depuis l'ancien format (clé/modèle uniques).
      if (s.apiKey && !s.apiKeys) merged.apiKeys[s.provider || 'claude'] = s.apiKey;
      if (s.model && !s.models) merged.models[s.provider || 'claude'] = s.model;
      // Remplace les modèles retirés par leur équivalent actuel.
      Object.keys(merged.models).forEach(function (p) {
        var repl = MODEL_MIGRATIONS[merged.models[p]];
        if (repl) merged.models[p] = repl;
      });
      return merged;
    },
    saveSettings: function (s) {
      write(KEYS.settings, s);
    },

    getHistory: function () {
      return read(KEYS.history, []);
    },
    addHistory: function (entry) {
      var h = this.getHistory();
      h.unshift(entry);
      if (h.length > 100) h = h.slice(0, 100);
      // Les vignettes ne sont gardées que sur les repas récents (limite du stockage).
      h.forEach(function (e, i) { if (i >= 40 && e.thumb) delete e.thumb; });
      return writeHistory(h);
    },
    clearHistory: function () {
      write(KEYS.history, []);
    },
    deleteHistory: function (date) {
      var h = this.getHistory().filter(function (e) { return e.date !== date; });
      write(KEYS.history, h);
      return h;
    },
    // Enregistre les glucides RÉELS d'un repas (pour l'apprentissage post-repas).
    setHistoryReal: function (date, realCarbsG) {
      var h = this.getHistory();
      h.forEach(function (e) {
        if (e.date === date) {
          if (realCarbsG == null || realCarbsG === '') delete e.realCarbsG;
          else e.realCarbsG = Math.max(0, Math.round(realCarbsG));
        }
      });
      return writeHistory(h);
    },
    // Calcule le biais personnel : compare estimé vs réel sur les repas corrigés.
    // Renvoie { count, meanRatio, pct } (pct > 0 = tendance à SOUS-estimer).
    getBias: function () {
      var h = this.getHistory();
      var ratios = [];
      h.forEach(function (e) {
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
      this.getHistory().forEach(function (e) {
        if (!(e.totalCarbsG > 0) || e.realCarbsG == null || !(e.realCarbsG > 0)) return;
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
          var current = read(KEYS.settings, {}) || {};
          var merged = Object.assign({}, current.apiKeys || {});
          var incoming = value.apiKeys || {};
          Object.keys(incoming).forEach(function (p) {
            if (incoming[p]) merged[p] = incoming[p];
          });
          value = Object.assign({}, value, { apiKeys: merged });
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
