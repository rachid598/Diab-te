/* gi.js — index glycémique (IG) et charge glycémique (CG).

   IG : vitesse à laquelle les glucides d'un aliment font monter la glycémie,
   sur une échelle où le glucose pur vaut 100. Bas < 55, moyen 55-69, élevé ≥ 70.
   C'est une propriété de l'ALIMENT, indépendante de la quantité.

   CG = IG × glucides / 100. C'est le chiffre réellement utile : il tient compte
   de la portion. La pastèque a un IG élevé (76) mais une CG faible, parce qu'une
   tranche contient peu de glucides. Basse < 10, modérée 10-19, élevée ≥ 20.

   POURQUOI UNE TABLE LOCALE plutôt que de demander l'IG à l'IA :
   ce sont des valeurs mesurées expérimentalement et publiées ; un modèle qui les
   « retrouve » de mémoire peut se tromper de 20 points sans le signaler. La table
   fait donc autorité, et la valeur du modèle ne sert que pour un aliment inconnu
   d'elle — auquel cas c'est marqué comme estimé.

   Valeurs : tables internationales usuelles (Foster-Powell / Sydney), arrondies.
   Ce sont des MOYENNES de population mesurées sur aliment isolé : dans un repas
   mixte, le gras et les protéines déplacent le résultat réel. Repère, pas mesure. */
(function () {
  'use strict';

  /* Ordre important : du plus spécifique au plus général.
     « pomme de terre » doit passer avant « pomme », « riz complet » avant « riz ». */
  var RULES = [
    /* ----- Collisions connues, à traiter en premier -----
       Ces plats contiennent le nom d'un autre aliment et seraient sinon classés
       par lui. Vérifiées par les tests : sans ce bloc, « riz au lait » prenait
       l'IG du riz nature (73 au lieu de 55) et « chocolat au lait » celui du
       lait (39 au lieu de 45). */
    [/riz au lait|semoule au lait|gateau de riz|gâteau de riz/, 55],
    [/chocolat.*noir|noir.*chocolat/, 40],
    [/chocolat/, 45],
    [/jus\b|smoothie|nectar/, 50],
    [/barre.*(cereale|céréale)/, 65],
    [/salade de fruit/, 45],

    // ----- Féculents -----
    [/pur[ée]e.*(pommes? de terre|patate)|patate.*pur[ée]e|pur[ée]e mousseline/, 87],
    [/pommes? de terre.*(four|rôti|roti)|patate.*four/, 85],
    [/pommes? de terre|patate(?! douce)/, 78],
    [/patate douce/, 63],
    [/frite/, 63],
    [/chips/, 56],
    [/gnocchi/, 68],
    [/riz.*(basmati|complet|brun|sauvage)|basmati/, 55],
    [/risotto|riz.*(rond|dessert|gluant|sushi)/, 80],
    [/\briz\b/, 73],
    [/pate|pâte|spaghetti|tagliatelle|penne|macaroni|nouille|lasagne|ravioli/, 50],
    [/semoule|couscous|boulgour|boulghour/, 65],
    [/quinoa/, 53],
    [/polenta/, 68],
    [/\bble\b|\bblé\b|ebly|epeautre|épeautre|orge/, 48],
    [/\bma(i|ï)s\b|epi de mais|épi de maïs/, 52],

    // ----- Légumineuses (IG bas : beaucoup de fibres et de protéines) -----
    [/lentille/, 32],
    [/pois chiche/, 28],
    [/haricot.*(blanc|rouge|noir)|flageolet/, 31],
    [/feve|fève/, 40],
    [/petits?[ -]?pois/, 51],
    [/soja|tofu/, 20],

    // ----- Pain et boulangerie -----
    [/levain/, 54],
    [/pain.*(complet|integral|intégral|seigle|cereale|céréale|son)/, 65],
    [/baguette/, 90],
    [/pain de mie|toast|sandwich|bun|burger/, 75],
    [/biscotte/, 70],
    [/\bpita\b|tortilla|wrap|naan/, 68],
    [/bagel/, 72],
    [/\bpain\b|tartine/, 75],
    [/croissant|pain au chocolat|viennois|chausson/, 67],
    [/brioche/, 70],
    [/crepe|crêpe|gaufre|pancake/, 67],
    [/pizza/, 60],

    // ----- Petit-déjeuner -----
    [/corn ?flakes|riz souffle|riz soufflé|pétales de maïs/, 81],
    [/muesli|granola/, 57],
    [/avoine|porridge|flocon/, 55],
    [/cereale|céréale/, 70],

    // ----- Fruits -----
    [/compote/, 42],
    [/pasteque|pastèque/, 76],
    [/datte/, 62],
    [/banane/, 51],
    [/raisin/, 59],
    [/ananas/, 59],
    [/melon/, 65],
    [/mangue/, 51],
    [/kiwi/, 50],
    [/orange(?! ?j)|clementine|clémentine|mandarine/, 43],
    [/pommes?(?! de terre)/, 36],
    [/poire/, 38],
    [/peche|pêche|nectarine/, 42],
    [/abricot/, 34],
    [/prune|pruneau/, 39],
    [/fraise|framboise|myrtille|mure|mûre|groseille/, 40],
    [/cerise/, 22],
    [/pamplemousse/, 25],

    // ----- Laitier -----
    [/yaourt|yogourt|skyr|fromage blanc|petit.?suisse/, 41],
    [/\blait\b/, 39],
    [/glace|creme glacee|crème glacée/, 51],

    // ----- Sucré -----
    [/miel/, 61],
    [/confiture|marmelade/, 51],
    [/bonbon|dragee|dragée/, 78],
    [/biscuit|cookie|sable|sablé|petits?[ -]?beurre/, 62],
    [/gateau|gâteau|genoise|génoise|muffin|madeleine|brownie/, 60],
    [/tarte|clafoutis|crumble/, 55],
    [/creme dessert|crème dessert|flan/, 55],
    [/sucre|saccharose/, 65],

    // ----- Boissons -----
    [/coca|soda|limonade|boisson.*(sucre|gazeuse)|energy|ice tea/, 63],
    [/sirop/, 60],
    [/biere|bière/, 66],

    // ----- Légumes (peu de glucides : l'IG y pèse très peu) -----
    [/carotte/, 39],
    [/betterave/, 64],
    [/courge(?!tte)|potiron|potimarron/, 64]
  ];

  /* Aliments sans glucides exploitables : l'IG n'a pas de sens (il se mesure sur
     une portion apportant 50 g de glucides, impossible à atteindre ici). */
  var NO_CARB = /viande|poulet|boeuf|bœuf|porc|veau|agneau|dinde|jambon|steak|saucisse|lardon|poisson|saumon|thon|cabillaud|crevette|oeuf|œuf|fromage(?! blanc)|beurre|huile|mayonnaise|salade(?! de fruit)|tomate|courgette|brocoli|epinard|épinard|poivron|concombre|chou|haricot vert|oignon|champignon|aubergine|poireau|celeri|céleri|radis|endive|avocat|noix|amande|noisette/;

  function lookup(name) {
    var n = (name || '').toString().toLowerCase();
    if (!n) return null;
    for (var i = 0; i < RULES.length; i++) {
      if (RULES[i][0].test(n)) return RULES[i][1];
    }
    return null;
  }

  function isLowCarbFood(name) {
    return NO_CARB.test((name || '').toString().toLowerCase());
  }

  /* IG d'un aliment du repas. La table prime ; la valeur du modèle ne sert qu'en
     dernier recours, et on la borne pour écarter une sortie aberrante. */
  function ofItem(item) {
    if (!item) return null;
    var fromTable = lookup(item.name);
    if (fromTable != null) return { gi: fromTable, estimated: false };
    var raw = parseFloat(item.gi);
    if (isFinite(raw) && raw >= 0 && raw <= 110) {
      return { gi: Math.round(raw), estimated: true };
    }
    return null;
  }

  /* Charge glycémique du repas. On ne compte que les aliments dont l'IG est connu :
     annoncer une CG en ignorant silencieusement la moitié du repas serait pire que
     ne rien annoncer. carbsCovered permet à l'interface de dire ce qui manque. */
  function meal(items) {
    var gl = 0, carbsCovered = 0, carbsTotal = 0, anyEstimated = false, unknown = [];
    (items || []).forEach(function (it) {
      var c = parseFloat(it.carbsG) || 0;
      carbsTotal += c;
      if (c <= 0) return;
      var g = ofItem(it);
      if (!g) {
        // Un aliment sans glucides ne manque pas vraiment : ne pas l'annoncer.
        if (!isLowCarbFood(it.name)) unknown.push(it.name);
        return;
      }
      gl += g.gi * c / 100;
      carbsCovered += c;
      if (g.estimated) anyEstimated = true;
    });
    if (carbsCovered <= 0) return null;
    return {
      gl: Math.round(gl),
      // IG du repas = moyenne des IG pondérée par les glucides apportés.
      gi: Math.round(gl * 100 / carbsCovered),
      carbsCovered: Math.round(carbsCovered),
      carbsTotal: Math.round(carbsTotal),
      coverage: carbsTotal > 0 ? carbsCovered / carbsTotal : 0,
      estimated: anyEstimated,
      unknown: unknown
    };
  }

  function giBand(gi) {
    if (gi == null) return null;
    if (gi < 55) return { key: 'bas', label: 'IG bas', cls: 'gi-low' };
    if (gi < 70) return { key: 'moyen', label: 'IG moyen', cls: 'gi-mid' };
    return { key: 'eleve', label: 'IG élevé', cls: 'gi-high' };
  }

  function glBand(gl) {
    if (gl == null) return null;
    if (gl < 10) return { key: 'basse', label: 'charge faible', cls: 'gi-low' };
    if (gl < 20) return { key: 'moderee', label: 'charge modérée', cls: 'gi-mid' };
    return { key: 'elevee', label: 'charge élevée', cls: 'gi-high' };
  }

  window.GI = {
    lookup: lookup,
    ofItem: ofItem,
    meal: meal,
    giBand: giBand,
    glBand: glBand,
    isLowCarbFood: isLowCarbFood
  };
})();
