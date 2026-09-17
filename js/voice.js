/* voice.js — comprend une phrase dictée du type « je mange 2 barquettes de LU »
   ou « 4 petit beurre de LU ». Ne cherche AUCUN produit ici : ce module extrait
   juste une quantité et une requête de recherche, en pur texte, sans DOM ni
   réseau — c'est app.js qui lance ensuite Foods.search / OFF.search avec cette
   requête et affiche les résultats à confirmer.

   Volontairement modeste : c'est un heuristique sur des tournures courantes en
   français, pas un analyseur syntaxique. Une phrase qu'il ne comprend pas
   renvoie null, et app.js bascule alors sur le mode Description (texte libre
   interprété par le modèle) plutôt que de deviner. */
(function () {
  'use strict';

  /* Préfixes qu'on retire s'ils ouvrent la phrase, jamais ailleurs : « ajoute »
     au milieu d'une phrase pourrait faire partie du produit lui-même. */
  var FILLER = /^(?:j['’](?:ai (?:mang[ée]|pris|bu)|en mange)|je (?:mange|viens de manger|prends|bois|vais manger)|ajoute(?:r)?|il y a|y a)\s+/i;

  var NUMBER_WORDS = {
    un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7,
    huit: 8, neuf: 9, dix: 10, onze: 11, douze: 12, treize: 13, quatorze: 14,
    quinze: 15, seize: 16, 'dix-sept': 17, 'dix-huit': 18, 'dix-neuf': 19,
    vingt: 20
  };

  /* Au-delà, la dictée s'est presque certainement trompée (« 50 barquettes »
     n'est pas un vrai repas) : mieux vaut échouer proprement que retenir un
     nombre absurde qui finirait affiché comme une quantité réelle. */
  var MAX_QUANTITE = 30;

  function quantiteEnTete(texte) {
    var chiffres = /^(\d{1,3}(?:[.,]\d+)?)\s+(.+)$/.exec(texte);
    if (chiffres) {
      var n = parseFloat(chiffres[1].replace(',', '.'));
      return isFinite(n) ? { quantite: n, reste: chiffres[2], ambigu: false } : null;
    }
    var mots = texte.split(/\s+/);
    var premier = (mots[0] || '').toLowerCase();
    if (NUMBER_WORDS[premier] == null) return null;
    var reste = mots.slice(1).join(' ');
    if (!reste) return null;
    /* « un »/« une » sert aussi d'article indéfini (« un bon repas ») : sans
       garde-fou, toute phrase commençant ainsi serait comprise comme une
       quantité de 1. « deux », « trois »… n'ont pas cette ambiguïté. */
    return { quantite: NUMBER_WORDS[premier], reste: reste, ambigu: premier === 'un' || premier === 'une' };
  }

  /* { quantite, unite, requete, brut } si une quantité a été comprise en tête
     de phrase, sinon null. 'unite' est le nom lu (« barquette », « yaourt »…)
     quand la phrase en contient un reconnu, sinon null : la requête porte
     alors la phrase entière, comme pour « petit beurre de LU ». */
  function parse(transcript) {
    var brut = String(transcript || '').trim();
    if (!brut) return null;

    var t = brut.replace(FILLER, '');
    var q = quantiteEnTete(t);
    if (!q || !(q.quantite > 0) || q.quantite > MAX_QUANTITE) return null;

    var reste = q.reste.trim();
    var unite = null;
    var u = (window.Portion && Portion.matchLeadingUnit) ? Portion.matchLeadingUnit(reste) : null;
    if (u) {
      unite = u.label;
      // « un yaourt » : rien après l'unité — elle EST la requête.
      reste = (u.rest && u.rest.trim()) || u.label;
    } else if (q.ambigu) {
      // « un »/« une » sans nom d'unité reconnu juste après : trop incertain
      // pour être traité comme une quantité (ex. « un bon repas »).
      return null;
    }
    reste = reste.trim();
    if (!reste) return null;

    return { quantite: q.quantite, unite: unite, requete: reste, brut: brut };
  }

  window.Voice = {
    NUMBER_WORDS: NUMBER_WORDS,
    MAX_QUANTITE: MAX_QUANTITE,
    parse: parse,
    // Feature-detect seulement : ne dit rien de la disponibilité réelle du
    // micro (permission refusée, aucun service de reconnaissance installé).
    supported: function () {
      return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    }
  };
})();
