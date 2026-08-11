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
    if (typeof t === 'number') return isFinite(t) ? t : null;
    if (typeof t !== 'string') return null;
    var raw = t.trim();
    if (!/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(raw)) return null;
    var n = Number(raw.replace(',', '.'));
    return isFinite(n) ? n : null;
  }

  function normalise(valeur, unite) {
    var u = String(unite || '').toLowerCase();
    var f = UNITES[u];
    if (!f || valeur == null || valeur <= 0) return null;
    return { valeur: Math.round(valeur * f * 100) / 100, unite: LIQUIDES[u] ? 'ml' : 'g' };
  }

  var UNIT_LABELS = [
    ['biscuit', /\bbiscuits?\b/], ['cookie', /\bcookies?\b/],
    ['gaufrette', /\bgaufrettes?\b/], ['barre', /\bbarres?\b/],
    ['tranche', /\btranches?\b/], ['galette', /\bgalettes?\b/],
    ['capsule', /\bcapsules?\b/], ['sachet', /\bsachets?\b/],
    ['pot', /\bpots?\b/], ['bouteille', /\bbouteilles?\b/],
    ['canette', /\bcanettes?\b/], ['portion', /\bportions?\b/],
    ['pièce', /\bpieces?\b|\bpi[eè]ces?\b/]
  ];

  function labelDans(texte) {
    var t = String(texte || '').toLowerCase();
    if (t.normalize) t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    for (var i = 0; i < UNIT_LABELS.length; i++) {
      if (UNIT_LABELS[i][1].test(t)) return UNIT_LABELS[i][0];
    }
    return '';
  }

  function compteDans(texte) {
    var t = String(texte || '').toLowerCase();
    if (!t) return null;
    var label = labelDans(t);
    if (!label) return null;
    var m = /(\d{1,4}(?:[.,]\d+)?)\s*(?:x\s*)?(?:biscuits?|cookies?|gaufrettes?|barres?|tranches?|galettes?|capsules?|sachets?|pots?|bouteilles?|canettes?|portions?|pi[eè]ces?)\b/.exec(t);
    var n = m ? nombre(m[1]) : null;
    if (!(n > 0) || Math.floor(n) !== n) return null;
    return { unitesSuggerees: n, label: label };
  }

  /* Lit le champ « quantity » d'OpenFoodFacts, qui est du texte libre saisi par
     les contributeurs. Le nombre trouvé n'est JAMAIS déclaré confirmé :
     « 2 × 250 g » peut désigner deux sachets contenant chacun six biscuits.
     L'interface peut le proposer, mais l'utilisateur doit confirmer ce qui est
     réellement consommable avant qu'il entre dans le calcul. */
  function parseQuantity(texte) {
    var t = String(texte || '').toLowerCase().trim();
    if (!t) return null;

    var nomme = /(\d+)\s*(?:biscuits?|cookies?|gaufrettes?|barres?|tranches?|galettes?|capsules?|sachets?|pots?|bouteilles?|canettes?|portions?|pi[eè]ces?)\s*(?:[x×*]|de|à|a)?\s*([\d.,]+)\s*(kg|g|ml|cl|dl|l)\b/.exec(t);
    if (nomme) {
      var nombrePieces = parseInt(nomme[1], 10);
      var poidsPiece = normalise(nombre(nomme[2]), nomme[3]);
      if (nombrePieces > 0 && poidsPiece) return {
        total: Math.round(nombrePieces * poidsPiece.valeur * 100) / 100,
        unitesSuggerees: nombrePieces,
        parUniteSuggeree: poidsPiece.valeur,
        label: labelDans(t),
        unite: poidsPiece.unite,
        confirme: false
      };
    }

    var multi = /(\d+)\s*[x×*]\s*([\d.,]+)\s*(kg|g|ml|cl|dl|l)\b/.exec(t);
    if (multi) {
      var unites = parseInt(multi[1], 10);
      var parPiece = normalise(nombre(multi[2]), multi[3]);
      if (unites > 0 && parPiece) {
        return {
          total: Math.round(unites * parPiece.valeur * 100) / 100,
          unitesSuggerees: unites,
          parUniteSuggeree: parPiece.valeur,
          label: labelDans(t),
          unite: parPiece.unite,
          confirme: false
        };
      }
    }

    var simple = /([\d.,]+)\s*(kg|g|ml|cl|dl|l)\b/.exec(t);
    if (simple) {
      var tot = normalise(nombre(simple[1]), simple[2]);
      if (tot) {
        var compte = compteDans(t);
        return {
          total: tot.valeur,
          unitesSuggerees: compte ? compte.unitesSuggerees : null,
          parUniteSuggeree: null,
          label: compte ? compte.label : '',
          unite: tot.unite,
          confirme: false
        };
      }
    }
    var seulementCompte = compteDans(t);
    if (seulementCompte) return {
      total: null,
      unitesSuggerees: seulementCompte.unitesSuggerees,
      parUniteSuggeree: null,
      label: seulementCompte.label,
      unite: 'g',
      confirme: false
    };
    return null;
  }

  /* Poids d'une unité. Renvoie null plutôt qu'un nombre douteux : afficher
     « 0 g par biscuit » ou une division par zéro serait pire que ne rien
     afficher, parce que le chiffre serait quand même recopié dans la pompe. */
  function parUnite(total, unites) {
    var t = nombre(total), n = nombre(unites);
    if (t == null || n == null || t <= 0 || n <= 0 || Math.floor(n) !== n) return null;
    return t / n;
  }

  /* Glucides d'une quantité donnée. Aucun arrondi ici : l'affichage final peut
     arrondir, mais le calcul et la portion mémorisée restent exacts. */
  function glucides(quantite, pour100) {
    var q = nombre(quantite), c = nombre(pour100);
    if (q == null || c == null || q < 0 || c < 0) return null;
    return q * c / 100;
  }

  function calculeUnites(options) {
    var o = options || {};
    var m = nombre(o.mange);
    var densite = nombre(o.pour100);
    if (m == null || m <= 0 || m > 10000 || densite == null || densite < 0 || densite > 100) return null;

    var methode = o.methode === 'unite' ? 'unite' : 'paquet';
    var poids;
    var total = nombre(o.total);
    var unites = nombre(o.unites);
    if (methode === 'unite') {
      poids = nombre(o.parUnite);
      if (poids == null || poids <= 0 || poids > 100000) return null;
    } else {
      poids = parUnite(total, unites);
      if (poids == null || total > 100000 || unites > 10000) return null;
    }

    var quantite = poids * m;
    return {
      methode: methode,
      parUnite: poids,
      quantite: quantite,
      glucides: glucides(quantite, densite),
      depassePaquet: methode === 'paquet' && m > unites
    };
  }

  /* Résumé complet d'une saisie « paquet de X, N unités, j'en mange M ».
     Renvoie null dès qu'un maillon manque — l'interface n'affiche alors rien
     plutôt qu'un résultat partiel qui aurait l'air d'un résultat. */
  function calcule(total, unites, mange, pour100) {
    return calculeUnites({ total: total, unites: unites, mange: mange,
      pour100: pour100, methode: 'paquet' });
  }

  window.Portion = {
    parseQuantity: parseQuantity,
    countFromText: compteDans,
    labelFromText: labelDans,
    normalizeQuantity: normalise,
    parUnite: parUnite,
    glucides: glucides,
    calcule: calcule,
    calculeUnites: calculeUnites
  };
})();
