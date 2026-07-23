/* storage.js — persistance locale des réglages et de l'historique.
   Tout reste dans le navigateur (localStorage). Rien n'est envoyé à un serveur. */
(function () {
  'use strict';

  var KEYS = {
    settings: 'diabete.settings.v1',
    history: 'diabete.history.v1',
    disclaimer: 'diabete.disclaimer.v1'
  };

  var DEFAULT_SETTINGS = {
    provider: 'claude',
    apiKey: '',
    model: 'claude-sonnet-5',
    partSizeG: 10,       // 1 part = 10 g (standard France)
    roundHalf: true      // arrondir les parts au 0,5
  };

  // Modèles par défaut suggérés par fournisseur.
  var DEFAULT_MODELS = {
    claude: 'claude-sonnet-5',
    openai: 'gpt-4o'
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

    getSettings: function () {
      var s = read(KEYS.settings, {});
      var merged = Object.assign({}, DEFAULT_SETTINGS, s || {});
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

    disclaimerAccepted: function () {
      return read(KEYS.disclaimer, false) === true;
    },
    acceptDisclaimer: function () {
      write(KEYS.disclaimer, true);
    }
  };

  window.Storage = Storage;
})();
