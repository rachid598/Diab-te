/* foods.js — base de données glucidique hors-ligne (mode manuel).
   carb = grammes de glucides pour 100 g d'aliment (tel que consommé).
   portion = poids typique d'une portion courante en grammes.
   Valeurs de référence usuelles (Ciqual / tables nutritionnelles courantes),
   arrondies. À utiliser comme repère, pas comme mesure exacte. */
(function () {
  'use strict';

  var FOODS = [
    // ----- Féculents / céréales (cuits) -----
    { n: 'Riz blanc (cuit)', carb: 28, portion: 150, cat: 'Féculents' },
    { n: 'Riz complet (cuit)', carb: 25, portion: 150, cat: 'Féculents' },
    { n: 'Pâtes (cuites)', carb: 25, portion: 180, cat: 'Féculents' },
    { n: 'Pomme de terre (cuite)', carb: 17, portion: 150, cat: 'Féculents' },
    { n: 'Purée de pomme de terre', carb: 14, portion: 150, cat: 'Féculents' },
    { n: 'Frites', carb: 36, portion: 130, cat: 'Féculents' },
    { n: 'Semoule / couscous (cuit)', carb: 25, portion: 150, cat: 'Féculents' },
    { n: 'Quinoa (cuit)', carb: 20, portion: 150, cat: 'Féculents' },
    { n: 'Lentilles (cuites)', carb: 16, portion: 150, cat: 'Légumineuses' },
    { n: 'Pois chiches (cuits)', carb: 18, portion: 150, cat: 'Légumineuses' },
    { n: 'Haricots rouges (cuits)', carb: 17, portion: 150, cat: 'Légumineuses' },

    // ----- Pain / boulangerie -----
    { n: 'Pain baguette', carb: 55, portion: 50, cat: 'Pain' },
    { n: 'Pain complet', carb: 45, portion: 50, cat: 'Pain' },
    { n: 'Pain de mie', carb: 48, portion: 30, cat: 'Pain' },
    { n: 'Biscotte', carb: 75, portion: 10, cat: 'Pain' },
    { n: 'Croissant', carb: 46, portion: 60, cat: 'Boulangerie' },
    { n: 'Pain au chocolat', carb: 45, portion: 70, cat: 'Boulangerie' },

    // ----- Petit-déjeuner -----
    { n: 'Céréales (corn flakes)', carb: 84, portion: 30, cat: 'Petit-déj' },
    { n: 'Muesli', carb: 60, portion: 40, cat: 'Petit-déj' },
    { n: 'Flocons d\'avoine', carb: 60, portion: 40, cat: 'Petit-déj' },
    { n: 'Confiture', carb: 60, portion: 20, cat: 'Petit-déj' },
    { n: 'Miel', carb: 80, portion: 20, cat: 'Petit-déj' },

    // ----- Fruits -----
    { n: 'Pomme', carb: 12, portion: 150, cat: 'Fruits' },
    { n: 'Banane', carb: 20, portion: 120, cat: 'Fruits' },
    { n: 'Orange', carb: 9, portion: 150, cat: 'Fruits' },
    { n: 'Raisin', carb: 16, portion: 100, cat: 'Fruits' },
    { n: 'Fraises', carb: 7, portion: 150, cat: 'Fruits' },
    { n: 'Poire', carb: 12, portion: 150, cat: 'Fruits' },
    { n: 'Pêche', carb: 9, portion: 150, cat: 'Fruits' },
    { n: 'Kiwi', carb: 11, portion: 80, cat: 'Fruits' },
    { n: 'Compote (sans sucre)', carb: 12, portion: 100, cat: 'Fruits' },

    // ----- Produits laitiers -----
    { n: 'Yaourt nature', carb: 5, portion: 125, cat: 'Laitier' },
    { n: 'Yaourt aux fruits sucré', carb: 14, portion: 125, cat: 'Laitier' },
    { n: 'Lait demi-écrémé', carb: 5, portion: 200, cat: 'Laitier' },
    { n: 'Fromage blanc', carb: 4, portion: 100, cat: 'Laitier' },

    // ----- Légumes (repère, faibles en glucides) -----
    { n: 'Carottes (cuites)', carb: 6, portion: 100, cat: 'Légumes' },
    { n: 'Petits pois', carb: 10, portion: 100, cat: 'Légumes' },
    { n: 'Maïs', carb: 19, portion: 80, cat: 'Légumes' },
    { n: 'Tomate', carb: 3, portion: 100, cat: 'Légumes' },
    { n: 'Haricots verts', carb: 4, portion: 100, cat: 'Légumes' },
    { n: 'Courgette', carb: 2, portion: 100, cat: 'Légumes' },
    { n: 'Salade verte', carb: 2, portion: 50, cat: 'Légumes' },

    // ----- Plats / divers -----
    { n: 'Pizza', carb: 30, portion: 200, cat: 'Plats' },
    { n: 'Quiche', carb: 20, portion: 150, cat: 'Plats' },
    { n: 'Sandwich jambon-beurre', carb: 40, portion: 180, cat: 'Plats' },
    { n: 'Hamburger (pain + steak)', carb: 25, portion: 220, cat: 'Plats' },
    { n: 'Sushi (6 pièces)', carb: 30, portion: 150, cat: 'Plats' },

    // ----- Sucreries / boissons -----
    { n: 'Chocolat au lait', carb: 57, portion: 25, cat: 'Sucré' },
    { n: 'Biscuit sec', carb: 70, portion: 25, cat: 'Sucré' },
    { n: 'Glace', carb: 24, portion: 100, cat: 'Sucré' },
    { n: 'Sucre (morceau)', carb: 100, portion: 5, cat: 'Sucré' },
    { n: 'Soda / cola', carb: 11, portion: 250, cat: 'Boissons' },
    { n: 'Jus d\'orange', carb: 10, portion: 200, cat: 'Boissons' },

    // ----- Protéines (peu/pas de glucides — repère) -----
    { n: 'Poulet (viande)', carb: 0, portion: 120, cat: 'Protéines' },
    { n: 'Bœuf (viande)', carb: 0, portion: 120, cat: 'Protéines' },
    { n: 'Poisson', carb: 0, portion: 120, cat: 'Protéines' },
    { n: 'Œuf', carb: 1, portion: 55, cat: 'Protéines' },
    { n: 'Fromage (pâte dure)', carb: 1, portion: 30, cat: 'Protéines' }
  ];

  // Recherche insensible aux accents et à la casse.
  function normalize(s) {
    return (s || '').toString().toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  var Foods = {
    all: FOODS,
    search: function (query) {
      var q = normalize(query).trim();
      if (!q) return FOODS.slice(0, 12);
      return FOODS.filter(function (f) {
        return normalize(f.n).indexOf(q) !== -1 || normalize(f.cat).indexOf(q) !== -1;
      });
    }
  };

  window.Foods = Foods;
})();
