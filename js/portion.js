/* portion.js — arithmétique des portions d'un produit emballé.

   Le problème concret : l'emballage donne des glucides pour 100 g, mais on ne
   mange pas 100 g, on mange « deux biscuits ». Convertir de tête demande le
   poids du paquet, le nombre d'unités dedans, une division et une multiplication
   — au moment précis où on est en train de se faire à manger.

   Tout est ici plutôt que dans l'interface parce que ces calculs décident d'un
   nombre de glucides destiné à une pompe à insuline : ils doivent être testables
   seuls, sans navigateur.

   Un mot sur les volumes. OpenFoodFacts exprime la quantité en g pour les
   solides et en ml pour les liquides. On ne convertit JAMAIS des ml en g : la
   densité n'est pas 1 pour un sirop ou une huile, et se tromper là-dessus
   fausserait la dose sans que rien ne le signale. L'unité est donc transportée
   telle quelle, et l'appelant affiche « ml ». */
(function () {
  'use strict';

  var UNITES = { g: 1, kg: 1000, ml: 1, cl: 10, l: 1000, dl: 100 };
  var LIQUIDES = { ml: 1, cl: 1, l: 1, dl: 1 };

  function nombre(t) {
    var n = parseFloat(String(t).replace(',', '.'));
    return isFinite(n) ? n : null;
  }

  function normalise(valeur, unite) {
    var u = String(unite || '').toLowerCase();
    var f = UNITES[u];
    if (!f || valeur == null || valeur <= 0) return null;
    return { valeur: Math.round(valeur * f * 100) / 100, unite: LIQUIDES[u] ? 'ml' : 'g' };
  }

  /* Lit le champ « quantity » d'OpenFoodFacts, qui est du texte libre saisi par
     les contributeurs. Deux formes utiles :
       « 12 x 25 g »  → le paquet ANNONCE lui-même son nombre d'unités ;
       « 300 g e »    → seulement le poids total (le « e » est la marque
                        d'estimation métrologique européenne, pas une unité).
     Tout le reste renvoie null : mieux vaut demander que deviner. */
  function parseQuantity(texte) {
    var t = String(texte || '').toLowerCase().trim();
    if (!t) return null;

    var multi = /(\d+)\s*[x×*]\s*([\d.,]+)\s*(kg|g|ml|cl|dl|l)\b/.exec(t);
    if (multi) {
      var unites = parseInt(multi[1], 10);
      var parPiece = normalise(nombre(multi[2]), multi[3]);
      if (unites > 0 && parPiece) {
        return {
          total: Math.round(unites * parPiece.valeur * 100) / 100,
          unites: unites,
          parUnite: parPiece.valeur,
          unite: parPiece.unite
        };
      }
    }

    var simple = /([\d.,]+)\s*(kg|g|ml|cl|dl|l)\b/.exec(t);
    if (simple) {
      var tot = normalise(nombre(simple[1]), simple[2]);
      if (tot) return { total: tot.valeur, unites: null, parUnite: null, unite: tot.unite };
    }
    return null;
  }

  /* Poids d'une unité. Renvoie null plutôt qu'un nombre douteux : afficher
     « 0 g par biscuit » ou une division par zéro serait pire que ne rien
     afficher, parce que le chiffre serait quand même recopié dans la pompe. */
  function parUnite(total, unites) {
    var t = nombre(total), n = nombre(unites);
    if (t == null || n == null || t <= 0 || n <= 0) return null;
    return Math.round((t / n) * 100) / 100;
  }

  /* Glucides d'une quantité donnée. Arrondi au dixième : l'affichage final
     arrondit à l'entier, mais arrondir deux fois de suite décale le total. */
  function glucides(quantite, pour100) {
    var q = nombre(quantite), c = nombre(pour100);
    if (q == null || c == null || q < 0 || c < 0) return null;
    return Math.round(q * c) / 100;
  }

  /* Résumé complet d'une saisie « paquet de X, N unités, j'en mange M ».
     Renvoie null dès qu'un maillon manque — l'interface n'affiche alors rien
     plutôt qu'un résultat partiel qui aurait l'air d'un résultat. */
  function calcule(total, unites, mange, pour100) {
    var pu = parUnite(total, unites);
    var m = nombre(mange);
    if (pu == null || m == null || m <= 0) return null;
    var quantite = Math.round(pu * m * 100) / 100;
    return { parUnite: pu, quantite: quantite, glucides: glucides(quantite, pour100) };
  }

  window.Portion = {
    parseQuantity: parseQuantity,
    parUnite: parUnite,
    glucides: glucides,
    calcule: calcule
  };
})();
