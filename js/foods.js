/* foods.js — base de données glucidique hors-ligne (mode manuel).
   carb = grammes de glucides pour 100 g d'aliment (tel que consommé).
   portions = mesures courantes [libellé, grammes]. La 1re est la portion par défaut.
   Valeurs génériques arrondies : ce sont des repères moyens, jamais la valeur
   exacte d'une recette ou d'un produit emballé. */
(function () {
  'use strict';

  // Ordre d'affichage des catégories.
  var CATEGORIES = [
    'Féculents', 'Légumineuses', 'Pain', 'Boulangerie', 'Petit-déj',
    'Fruits', 'Laitier', 'Légumes', 'Plats', 'Sucré', 'Boissons', 'Protéines'
  ];

  var FOODS = [
    // ----- Féculents (cuits) -----
    { n: 'Riz blanc (cuit)', cat: 'Féculents', carb: 28, portions: [['Petit bol', 120], ['Assiette', 200], ['1 c. à soupe', 20]] },
    { n: 'Riz complet (cuit)', cat: 'Féculents', carb: 25, portions: [['Petit bol', 120], ['Assiette', 200], ['1 c. à soupe', 20]] },
    { n: 'Pâtes (cuites)', cat: 'Féculents', carb: 25, portions: [['Petit bol', 120], ['Assiette', 220], ['1 c. à soupe', 25]] },
    { n: 'Pomme de terre (cuite)', cat: 'Féculents', carb: 17, portions: [['1 moyenne', 100], ['Assiette', 200], ['1 petite', 60]] },
    { n: 'Purée de pomme de terre', cat: 'Féculents', carb: 14, portions: [['1 louche', 150], ['Assiette', 250], ['1 c. à soupe', 40]] },
    { n: 'Frites', cat: 'Féculents', carb: 36, portions: [['Petite portion', 100], ['Grande portion', 150], ['Poignée', 40]] },
    { n: 'Semoule / couscous (cuit)', cat: 'Féculents', carb: 25, portions: [['Petit bol', 120], ['Assiette', 200], ['1 c. à soupe', 20]] },
    { n: 'Quinoa (cuit)', cat: 'Féculents', carb: 20, portions: [['Petit bol', 120], ['Assiette', 200]] },
    { n: 'Blé (Ebly, cuit)', cat: 'Féculents', carb: 26, portions: [['Petit bol', 120], ['Assiette', 200]] },
    { n: 'Boulgour (cuit)', cat: 'Féculents', carb: 19, portions: [['Petit bol', 120], ['Assiette', 200]] },
    { n: 'Polenta (cuite)', cat: 'Féculents', carb: 15, portions: [['1 portion', 150], ['Assiette', 250]] },
    { n: 'Nouilles (cuites)', cat: 'Féculents', carb: 25, portions: [['Petit bol', 120], ['Assiette', 220]] },
    { n: 'Patate douce (cuite)', cat: 'Féculents', carb: 20, portions: [['1 moyenne', 130], ['Assiette', 200]] },

    // ----- Légumineuses -----
    { n: 'Lentilles (cuites)', cat: 'Légumineuses', carb: 16, portions: [['1 louche', 150], ['Assiette', 200], ['1 c. à soupe', 30]] },
    { n: 'Pois chiches (cuits)', cat: 'Légumineuses', carb: 18, portions: [['1 louche', 150], ['1 c. à soupe', 30]] },
    { n: 'Haricots blancs (cuits)', cat: 'Légumineuses', carb: 17, portions: [['1 louche', 150], ['1 c. à soupe', 30]] },
    { n: 'Haricots rouges (cuits)', cat: 'Légumineuses', carb: 17, portions: [['1 louche', 150], ['1 c. à soupe', 30]] },
    { n: 'Pois cassés (cuits)', cat: 'Légumineuses', carb: 16, portions: [['1 louche', 150]] },

    // ----- Pain -----
    { n: 'Pain baguette', cat: 'Pain', carb: 55, portions: [['1 tranche', 25], ['1 morceau (⅕)', 50], ['½ baguette', 125]] },
    { n: 'Pain complet', cat: 'Pain', carb: 45, portions: [['1 tranche', 30], ['1 morceau', 50]] },
    { n: 'Pain de campagne', cat: 'Pain', carb: 52, portions: [['1 tranche', 40], ['1 morceau', 50]] },
    { n: 'Pain de mie', cat: 'Pain', carb: 48, portions: [['1 tranche', 30], ['2 tranches', 60]] },
    { n: 'Pain burger (bun)', cat: 'Pain', carb: 47, portions: [['1 pain', 60]] },
    { n: 'Biscotte', cat: 'Pain', carb: 75, portions: [['1 biscotte', 10], ['2 biscottes', 20]] },
    { n: 'Pain grillé (toast)', cat: 'Pain', carb: 50, portions: [['1 tranche', 25]] },

    // ----- Boulangerie / viennoiseries -----
    { n: 'Croissant', cat: 'Boulangerie', carb: 46, portions: [['1 croissant', 60]] },
    { n: 'Pain au chocolat', cat: 'Boulangerie', carb: 45, portions: [['1 pièce', 70]] },
    { n: 'Brioche', cat: 'Boulangerie', carb: 50, portions: [['1 tranche', 35], ['1 part', 60]] },
    { n: 'Pain aux raisins', cat: 'Boulangerie', carb: 48, portions: [['1 pièce', 90]] },
    { n: 'Crêpe', cat: 'Boulangerie', carb: 30, portions: [['1 crêpe', 70]] },
    { n: 'Gaufre', cat: 'Boulangerie', carb: 40, portions: [['1 gaufre', 80]] },

    // ----- Petit-déjeuner -----
    { n: 'Céréales (corn flakes)', cat: 'Petit-déj', carb: 84, portions: [['1 bol', 40], ['Petit bol', 30]] },
    { n: 'Muesli', cat: 'Petit-déj', carb: 60, portions: [['1 bol', 50], ['Petit bol', 40]] },
    { n: "Flocons d'avoine", cat: 'Petit-déj', carb: 60, portions: [['1 bol', 40], ['3 c. à soupe', 30]] },
    { n: 'Confiture', cat: 'Petit-déj', carb: 60, portions: [['1 c. à café', 8], ['1 c. à soupe', 20]] },
    { n: 'Miel', cat: 'Petit-déj', carb: 80, portions: [['1 c. à café', 8], ['1 c. à soupe', 20]] },
    { n: 'Pâte à tartiner (Nutella)', cat: 'Petit-déj', carb: 57, portions: [['1 c. à café', 8], ['1 c. à soupe', 20]] },

    // ----- Fruits -----
    { n: 'Pomme', cat: 'Fruits', carb: 12, portions: [['1 moyenne', 150], ['1 petite', 100], ['1 grande', 200]] },
    { n: 'Banane', cat: 'Fruits', carb: 20, portions: [['1 moyenne', 120], ['1 petite', 90], ['1 grande', 150]] },
    { n: 'Orange', cat: 'Fruits', carb: 9, portions: [['1 moyenne', 150]] },
    { n: 'Clémentine', cat: 'Fruits', carb: 12, portions: [['1 pièce', 60], ['2 pièces', 120]] },
    { n: 'Raisin', cat: 'Fruits', carb: 16, portions: [['1 petite grappe', 100], ['Poignée', 50]] },
    { n: 'Fraises', cat: 'Fruits', carb: 7, portions: [['1 bol', 150], ['Poignée', 80]] },
    { n: 'Poire', cat: 'Fruits', carb: 12, portions: [['1 moyenne', 150]] },
    { n: 'Pêche', cat: 'Fruits', carb: 9, portions: [['1 moyenne', 150]] },
    { n: 'Kiwi', cat: 'Fruits', carb: 11, portions: [['1 pièce', 80]] },
    { n: 'Ananas', cat: 'Fruits', carb: 12, portions: [['1 tranche', 100], ['1 bol', 150]] },
    { n: 'Melon', cat: 'Fruits', carb: 8, portions: [['1 part', 150]] },
    { n: 'Abricot', cat: 'Fruits', carb: 10, portions: [['1 pièce', 40], ['3 pièces', 120]] },
    { n: 'Mangue', cat: 'Fruits', carb: 14, portions: [['1 portion', 150], ['Petit bol', 100]] },
    { n: 'Framboises', cat: 'Fruits', carb: 5, portions: [['1 barquette', 125], ['Poignée', 80]] },
    { n: 'Myrtilles', cat: 'Fruits', carb: 10, portions: [['1 barquette', 125], ['Poignée', 80]] },
    { n: 'Compote (sans sucre ajouté)', cat: 'Fruits', carb: 12, portions: [['1 gourde/coupelle', 100]] },
    { n: 'Dattes', cat: 'Fruits', carb: 65, portions: [['1 datte', 8], ['3 dattes', 24]] },

    // ----- Produits laitiers -----
    { n: 'Yaourt nature', cat: 'Laitier', carb: 5, portions: [['1 pot', 125]] },
    { n: 'Yaourt aux fruits sucré', cat: 'Laitier', carb: 14, portions: [['1 pot', 125]] },
    { n: 'Yaourt à boire', cat: 'Laitier', carb: 12, portions: [['1 bouteille', 100]] },
    { n: 'Lait demi-écrémé', cat: 'Laitier', carb: 5, portions: [['1 verre', 200], ['1 bol', 250]] },
    { n: 'Fromage blanc', cat: 'Laitier', carb: 4, portions: [['1 pot', 100]] },
    { n: 'Skyr nature', cat: 'Laitier', carb: 4, portions: [['1 pot', 140], ['100 g', 100]] },
    { n: 'Riz au lait', cat: 'Laitier', carb: 17, portions: [['1 pot', 120]] },

    // ----- Légumes -----
    { n: 'Carottes (cuites)', cat: 'Légumes', carb: 6, portions: [['1 portion', 100], ['1 c. à soupe', 30]] },
    { n: 'Petits pois', cat: 'Légumes', carb: 10, portions: [['1 portion', 100], ['1 c. à soupe', 30]] },
    { n: 'Maïs', cat: 'Légumes', carb: 19, portions: [['1 portion', 80], ['1 c. à soupe', 30]] },
    { n: 'Tomate', cat: 'Légumes', carb: 3, portions: [['1 moyenne', 100]] },
    { n: 'Haricots verts', cat: 'Légumes', carb: 4, portions: [['1 portion', 130]] },
    { n: 'Courgette', cat: 'Légumes', carb: 2, portions: [['1 portion', 100]] },
    { n: 'Aubergine (cuite)', cat: 'Légumes', carb: 3, portions: [['1 portion', 150]] },
    { n: 'Potiron / courge (cuits)', cat: 'Légumes', carb: 4, portions: [['1 portion', 150]] },
    { n: 'Brocoli', cat: 'Légumes', carb: 4, portions: [['1 portion', 100]] },
    { n: 'Salade verte', cat: 'Légumes', carb: 2, portions: [['1 portion', 50]] },
    { n: 'Soupe de légumes', cat: 'Légumes', carb: 6, portions: [['1 bol', 250], ['1 assiette', 300]] },

    // ----- Plats -----
    { n: 'Pizza', cat: 'Plats', carb: 30, portions: [['1 part', 100], ['½ pizza', 200], ['1 pizza', 400]] },
    { n: 'Quiche', cat: 'Plats', carb: 20, portions: [['1 part', 150]] },
    { n: 'Sandwich jambon-beurre', cat: 'Plats', carb: 40, portions: [['1 sandwich', 180], ['½ sandwich', 90]] },
    { n: 'Hamburger', cat: 'Plats', carb: 25, portions: [['1 burger', 220]] },
    { n: 'Sushi', cat: 'Plats', carb: 20, portions: [['1 pièce', 25], ['6 pièces', 150]] },
    { n: 'Lasagnes', cat: 'Plats', carb: 14, portions: [['1 part', 250]] },
    { n: 'Hachis parmentier', cat: 'Plats', carb: 12, portions: [['1 part', 250]] },
    { n: 'Nuggets', cat: 'Plats', carb: 15, portions: [['1 pièce', 20], ['6 pièces', 120]] },
    { n: 'Tarte salée / feuilletée', cat: 'Plats', carb: 22, portions: [['1 part', 130]] },

    // ----- Sucreries -----
    { n: 'Chocolat au lait', cat: 'Sucré', carb: 57, portions: [['1 carré', 5], ['1 rangée', 25]] },
    { n: 'Chocolat noir', cat: 'Sucré', carb: 45, portions: [['1 carré', 5], ['1 rangée', 25]] },
    { n: 'Biscuit sec (type petit-beurre)', cat: 'Sucré', carb: 70, portions: [['1 biscuit', 8], ['3 biscuits', 24]] },
    { n: 'Cookie', cat: 'Sucré', carb: 60, portions: [['1 cookie', 40]] },
    { n: 'Glace', cat: 'Sucré', carb: 24, portions: [['1 boule', 60], ['2 boules', 120]] },
    { n: 'Bonbons', cat: 'Sucré', carb: 90, portions: [['1 poignée', 30], ['1 bonbon', 5]] },
    { n: 'Gâteau (part)', cat: 'Sucré', carb: 45, portions: [['1 part', 80]] },
    { n: 'Sucre', cat: 'Sucré', carb: 100, portions: [['1 morceau', 5], ['1 c. à café', 5]] },

    // ----- Boissons -----
    { n: 'Soda / cola', cat: 'Boissons', carb: 11, portions: [['1 verre', 200], ['1 canette', 330]] },
    { n: "Jus d'orange", cat: 'Boissons', carb: 10, portions: [['1 verre', 200]] },
    { n: 'Jus de pomme', cat: 'Boissons', carb: 11, portions: [['1 verre', 200]] },
    { n: 'Sirop (dilué)', cat: 'Boissons', carb: 10, portions: [['1 verre', 200]] },
    { n: 'Bière', cat: 'Boissons', carb: 4, portions: [['1 verre (25 cl)', 250], ['1 demi (50 cl)', 500]] },

    // ----- Protéines (repère, peu de glucides) -----
    { n: 'Poulet (viande)', cat: 'Protéines', carb: 0, portions: [['1 portion', 120]] },
    { n: 'Bœuf (viande)', cat: 'Protéines', carb: 0, portions: [['1 portion', 120]] },
    { n: 'Poisson', cat: 'Protéines', carb: 0, portions: [['1 portion', 120]] },
    { n: 'Œuf', cat: 'Protéines', carb: 1, portions: [['1 œuf', 55], ['2 œufs', 110]] },
    { n: 'Jambon', cat: 'Protéines', carb: 1, portions: [['1 tranche', 40]] },
    { n: 'Fromage (pâte dure)', cat: 'Protéines', carb: 1, portions: [['1 part', 30]] }
  ];

  /* Les synonymes servent uniquement à retrouver une ligne. Ils ne signifient
     jamais que deux aliments ont le même profil nutritionnel : « pdt » pointe
     vers la pomme de terre cuite, mais les frites gardent leur propre ligne. */
  var SEARCH_ALIASES = {
    'Pomme de terre (cuite)': ['pdt', 'patate', 'pommes de terre'],
    'Pâtes (cuites)': ['pate', 'pates', 'spaghetti', 'spaghettis'],
    'Biscuit sec (type petit-beurre)': ['petit beurre', 'petit-beurre'],
    'Lait demi-écrémé': ['lait demi ecreme'],
    'Œuf': ['oeuf', 'oeufs'],
    'Bœuf (viande)': ['boeuf'],
    'Semoule / couscous (cuit)': ['couscous', 'semoule cuite'],
    'Flocons d\'avoine': ['avoine', 'flocons avoine'],
    'Potiron / courge (cuits)': ['courge cuite', 'potiron cuit']
  };

  // Forme canonique commune aux noms, requêtes, marques et synonymes.
  function normalize(s) {
    var out = (s == null ? '' : s).toString().toLowerCase()
      .replace(/œ/g, 'oe').replace(/æ/g, 'ae');
    if (typeof out.normalize === 'function') {
      out = out.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    }
    return out
      .replace(/[’'`´]/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function words(value) {
    var normalized = normalize(value);
    return normalized ? normalized.split(' ') : [];
  }

  function localId(name) {
    return 'local:' + (normalize(name).replace(/\s+/g, '-') || 'aliment');
  }

  /* L'identifiant est stable entre deux versions. La provenance décrit
     honnêtement la précision disponible sans revendiquer un code de table
     nutritionnelle que cette petite base n'embarque pas. */
  FOODS.forEach(function (food) {
    food.id = localId(food.n);
    food.meta = {
      source: 'local-generic-average',
      label: 'Repère moyen embarqué',
      approximate: true
    };
  });

  function safeCustomFoods() {
    if (!window.Storage || typeof window.Storage.getCustomFoods !== 'function') return [];
    try {
      var list = window.Storage.getCustomFoods();
      return Array.isArray(list) ? list : [];
    } catch (err) {
      return [];
    }
  }

  function finiteCarb(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (typeof value === 'string' && !value.trim()) return null;
    var number = typeof value === 'number' ? value : Number(value.replace(',', '.'));
    return isFinite(number) && number >= 0 && number <= 100 ? number : null;
  }

  function safePositive(value) {
    var number = typeof value === 'number' ? value : Number(value);
    return isFinite(number) && number > 0 && number <= 100000 ? number : null;
  }

  function safePack(value) {
    if (!value || typeof value !== 'object') return null;
    var total = safePositive(value.total);
    var suggestedUnits = safePositive(value.unitesSuggerees);
    var suggestedUnitWeight = safePositive(value.parUniteSuggeree);
    if (suggestedUnits != null && Math.floor(suggestedUnits) !== suggestedUnits) suggestedUnits = null;
    if (total == null && suggestedUnits == null && suggestedUnitWeight == null) return null;
    return {
      total: total,
      unite: value.unite === 'ml' ? 'ml' : 'g',
      unitesSuggerees: suggestedUnits,
      parUniteSuggeree: suggestedUnitWeight,
      labelSuggere: typeof value.labelSuggere === 'string' ? value.labelSuggere.trim().slice(0, 60) : '',
      suggestionConflit: value.suggestionConflit === true
    };
  }

  /* getProducts est volontairement facultatif : les anciennes versions de
     Storage ne l'exposent pas. On accepte une liste ou une table par code-barres
     et on ne reprend aucune portion/serving issue d'OpenFoodFacts. */
  function knownProducts() {
    if (!window.Storage || typeof window.Storage.getProducts !== 'function') return [];
    var raw;
    try { raw = window.Storage.getProducts(); } catch (err) { return []; }

    var entries = [];
    if (Array.isArray(raw)) {
      entries = raw.map(function (product) { return { product: product, key: '' }; });
    } else if (raw && typeof raw === 'object') {
      entries = Object.keys(raw).map(function (key) {
        return { product: raw[key], key: key };
      });
    }

    var seen = {};
    return entries.map(function (entry) {
      var product = entry.product;
      if (!product || typeof product !== 'object') return null;
      var name = typeof product.n === 'string' ? product.n.trim().slice(0, 160) : '';
      var carb = finiteCarb(product.carb);
      if (!name || carb == null) return null;

      var brand = typeof product.brand === 'string' ? product.brand.trim().slice(0, 80) : '';
      var code = String(product.code || entry.key || '').replace(/\D/g, '').slice(0, 18);
      var identity = code ? 'code:' + code : 'name:' + normalize(name + ' ' + brand);
      if (seen[identity]) return null;
      seen[identity] = true;

      var personal = product.source === 'perso';
      return {
        id: 'product:' + (code || normalize(name + ' ' + brand).replace(/\s+/g, '-')),
        n: name,
        brand: brand,
        cat: 'Produits connus',
        carb: carb,
        code: code,
        pack: safePack(product.pack),
        packaged: true,
        source: personal ? 'perso' : 'off',
        portions: [],
        custom: false,
        meta: {
          source: personal ? 'personal-label' : 'openfoodfacts-cache',
          label: personal ? 'Valeur recopiée de l\'étiquette' : 'Produit OpenFoodFacts en cache',
          approximate: !personal
        }
      };
    }).filter(Boolean);
  }

  function aliasesFor(food) {
    return SEARCH_ALIASES[food.n] || [];
  }

  function tokenMatchScore(queryToken, candidateToken, fieldWeight) {
    if (candidateToken === queryToken) return fieldWeight + 30;
    if (candidateToken.indexOf(queryToken) === 0) return fieldWeight + 18;
    if (candidateToken.indexOf(queryToken) !== -1) return fieldWeight + 6;
    return -1;
  }

  function sameTokenBag(left, right) {
    if (left.length !== right.length) return false;
    var sortedLeft = left.slice().sort().join('|');
    var sortedRight = right.slice().sort().join('|');
    return sortedLeft === sortedRight;
  }

  function searchScore(food, normalizedQuery) {
    var queryWords = words(normalizedQuery);
    if (!queryWords.length) return null;

    var name = normalize(food.n);
    var aliasValues = aliasesFor(food).map(normalize);
    var brand = normalize(food.brand);
    var category = normalize(food.cat);
    var code = normalize(food.code);
    var fields = [
      { values: words(name), weight: 60 },
      { values: aliasValues.reduce(function (all, alias) { return all.concat(words(alias)); }, []), weight: 48 },
      { values: words(brand), weight: 34 },
      { values: words(category), weight: 18 },
      { values: words(code), weight: 12 }
    ];

    var score = 0;
    for (var q = 0; q < queryWords.length; q++) {
      var best = -1;
      fields.forEach(function (field) {
        field.values.forEach(function (candidate) {
          best = Math.max(best, tokenMatchScore(queryWords[q], candidate, field.weight));
        });
      });
      if (best < 0) return null;
      score += best;
    }

    if (name === normalizedQuery) score += 1000;
    if (aliasValues.indexOf(normalizedQuery) !== -1) score += 900;
    if (name.indexOf(normalizedQuery) === 0) score += 360;
    else if (name.indexOf(normalizedQuery) !== -1) score += 260;
    if (aliasValues.some(function (alias) { return alias.indexOf(normalizedQuery) === 0; })) score += 240;
    if (sameTokenBag(queryWords, words(name))) score += 520;
    if (food.custom) score += 8;
    else if (food.cat === 'Produits connus') score += 4;
    return score;
  }

  var Foods = {
    all: FOODS,
    categories: CATEGORIES,

    // Les produits connus viennent après la base pour préserver l'accueil court.
    combined: function () {
      return safeCustomFoods().concat(FOODS, knownProducts());
    },

    /* Recherche par texte + catégorie optionnelle. */
    search: function (query, category) {
      var q = normalize(query);
      var list = this.combined();
      if (category && category !== 'Tous') {
        list = list.filter(function (f) { return f.cat === category; });
      }
      if (q) {
        list = list.map(function (food, index) {
          return { food: food, index: index, score: searchScore(food, q) };
        }).filter(function (result) {
          return result.score != null;
        }).sort(function (left, right) {
          return right.score - left.score || left.index - right.index;
        }).map(function (result) { return result.food; });
      }
      // Sans recherche ni filtre : on limite pour ne pas tout afficher.
      if (!q && (!category || category === 'Tous')) return list.slice(0, 15);
      return list;
    },

    // Catégories réellement présentes, y compris les produits utilisables hors ligne.
    activeCategories: function () {
      var cats = ['Tous'];
      var custom = safeCustomFoods();
      if (custom.length) cats.push('Perso');
      cats = cats.concat(CATEGORIES);
      if (knownProducts().length) cats.push('Produits connus');
      return cats;
    }
  };

  window.Foods = Foods;
})();
