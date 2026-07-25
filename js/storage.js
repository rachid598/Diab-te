/* storage.js — persistance locale des réglages et de l'historique.
   Tout reste dans le navigateur (localStorage). Rien n'est envoyé à un serveur. */
(function () {
  'use strict';

  var KEYS = {
    settings: 'diabete.settings.v1',
    history: 'diabete.history.v1',
    disclaimer: 'diabete.disclaimer.v1',
    customFoods: 'diabete.customfoods.v1',
    recentFoods: 'diabete.recentfoods.v1'
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

  function read(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
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
      write(KEYS.history, h);
      return h;
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
      write(KEYS.history, h);
      return h;
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
