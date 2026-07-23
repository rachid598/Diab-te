/* foods.js — base de données glucidique hors-ligne (mode manuel).
   carb = grammes de glucides pour 100 g d'aliment (tel que consommé).
   portions = mesures courantes [libellé, grammes]. La 1re est la portion par défaut.
   Valeurs de référence usuelles (tables type Ciqual), arrondies. Repère, pas mesure exacte. */
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
    { n: 'Compote (sans sucre ajouté)', cat: 'Fruits', carb: 12, portions: [['1 gourde/coupelle', 100]] },
    { n: 'Dattes', cat: 'Fruits', carb: 65, portions: [['1 datte', 8], ['3 dattes', 24]] },

    // ----- Produits laitiers -----
    { n: 'Yaourt nature', cat: 'Laitier', carb: 5, portions: [['1 pot', 125]] },
    { n: 'Yaourt aux fruits sucré', cat: 'Laitier', carb: 14, portions: [['1 pot', 125]] },
    { n: 'Yaourt à boire', cat: 'Laitier', carb: 12, portions: [['1 bouteille', 100]] },
    { n: 'Lait demi-écrémé', cat: 'Laitier', carb: 5, portions: [['1 verre', 200], ['1 bol', 250]] },
    { n: 'Fromage blanc', cat: 'Laitier', carb: 4, portions: [['1 pot', 100]] },
    { n: 'Riz au lait', cat: 'Laitier', carb: 17, portions: [['1 pot', 120]] },

    // ----- Légumes -----
    { n: 'Carottes (cuites)', cat: 'Légumes', carb: 6, portions: [['1 portion', 100], ['1 c. à soupe', 30]] },
    { n: 'Petits pois', cat: 'Légumes', carb: 10, portions: [['1 portion', 100], ['1 c. à soupe', 30]] },
    { n: 'Maïs', cat: 'Légumes', carb: 19, portions: [['1 portion', 80], ['1 c. à soupe', 30]] },
    { n: 'Tomate', cat: 'Légumes', carb: 3, portions: [['1 moyenne', 100]] },
    { n: 'Haricots verts', cat: 'Légumes', carb: 4, portions: [['1 portion', 130]] },
    { n: 'Courgette', cat: 'Légumes', carb: 2, portions: [['1 portion', 100]] },
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

  // Recherche insensible aux accents et à la casse.
  function normalize(s) {
    return (s || '').toString().toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  var Foods = {
    all: FOODS,
    categories: CATEGORIES,

    // Liste combinée base intégrée + aliments personnalisés (si Storage dispo).
    combined: function () {
      var custom = (window.Storage && window.Storage.getCustomFoods) ? window.Storage.getCustomFoods() : [];
      return custom.concat(FOODS);
    },

    /* Recherche par texte + catégorie optionnelle. */
    search: function (query, category) {
      var q = normalize(query).trim();
      var list = this.combined();
      if (category && category !== 'Tous') {
        list = list.filter(function (f) { return f.cat === category; });
      }
      if (q) {
        list = list.filter(function (f) {
          return normalize(f.n).indexOf(q) !== -1 || normalize(f.cat).indexOf(q) !== -1;
        });
      }
      // Sans recherche ni filtre : on limite pour ne pas tout afficher.
      if (!q && (!category || category === 'Tous')) return list.slice(0, 15);
      return list;
    },

    // Catégories réellement présentes (avec « Perso » en tête si aliments perso).
    activeCategories: function () {
      var cats = ['Tous'];
      var custom = (window.Storage && window.Storage.getCustomFoods) ? window.Storage.getCustomFoods() : [];
      if (custom.length) cats.push('Perso');
      return cats.concat(CATEGORIES);
    }
  };

  window.Foods = Foods;
})();
