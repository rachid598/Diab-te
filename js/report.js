/* report.js — synthèse imprimable des repas, destinée à la consultation.

   L'export JSON existant sert à restaurer l'app sur un autre téléphone : il est
   illisible pour un tiers. Ici on produit une page autonome, lisible telle
   quelle, qui répond aux questions qu'un diabétologue pose réellement :
   combien de glucides par repas, à quelles heures, et avec quelle fiabilité.

   Choix assumé : le document n'affiche AUCUNE dose et aucune glycémie. L'app
   n'en connaît pas, et en présenter donnerait au document une autorité
   clinique qu'il n'a pas. Il est présenté pour ce qu'il est — des estimations
   faites par l'utilisateur, pas des mesures. */
(function () {
  'use strict';

  var TRANCHES = [
    ['Matin', 5, 11],
    ['Midi', 11, 15],
    ['Après-midi', 15, 18],
    ['Soir', 18, 23],
    ['Nuit', 23, 5]
  ];

  function trancheOf(date) {
    var h = new Date(date).getHours();
    for (var i = 0; i < TRANCHES.length; i++) {
      var t = TRANCHES[i];
      if (t[1] < t[2] ? (h >= t[1] && h < t[2]) : (h >= t[1] || h < t[2])) return t[0];
    }
    return 'Soir';
  }

  function fr1(n) {
    return (Math.round(n * 10) / 10).toString().replace('.', ',');
  }

  function esc(s) {
    return (s || '').toString()
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* Agrégats sur la période. Tout est calculé ici plutôt qu'au rendu pour que
     les mêmes chiffres puissent servir à un autre format plus tard. */
  function analyse(days) {
    var since = Date.now() - days * 86400000;
    var meals = Storage.getHistory().filter(function (e) {
      return e.date >= since && e.totalCarbsG > 0;
    }).sort(function (a, b) { return a.date - b.date; });

    if (!meals.length) return null;

    var partSize = Storage.getSettings().partSizeG || 10;
    var carbs = meals.map(function (e) { return e.totalCarbsG; });
    var sum = carbs.reduce(function (s, c) { return s + c; }, 0);
    var sorted = carbs.slice().sort(function (a, b) { return a - b; });

    // Répartition par moment de la journée.
    var byTranche = {};
    TRANCHES.forEach(function (t) { byTranche[t[0]] = { n: 0, sum: 0 }; });
    meals.forEach(function (e) {
      var t = byTranche[trancheOf(e.date)];
      t.n++; t.sum += e.totalCarbsG;
    });

    // Nombre de jours réellement couverts (pas la longueur de la fenêtre).
    var jours = {};
    meals.forEach(function (e) { jours[new Date(e.date).toDateString()] = true; });
    var nbJours = Object.keys(jours).length;

    // Charge glycémique, sur les repas où elle a pu être calculée.
    var gls = meals.map(function (e) { return e.gi && e.gi.gl; }).filter(function (v) { return v != null; });

    // Fiabilité : uniquement les repas où une valeur réelle a été saisie.
    var mesures = meals.filter(function (e) { return e.realCarbsG > 0; });

    return {
      days: days,
      meals: meals,
      count: meals.length,
      nbJours: nbJours,
      parJour: nbJours ? meals.length / nbJours : 0,
      partSize: partSize,
      moyenne: sum / meals.length,
      mediane: sorted[Math.floor(sorted.length / 2)],
      min: sorted[0],
      max: sorted[sorted.length - 1],
      glucidesParJour: nbJours ? sum / nbJours : 0,
      byTranche: byTranche,
      gl: gls.length ? gls.reduce(function (s, v) { return s + v; }, 0) / gls.length : null,
      glCount: gls.length,
      mesures: mesures.length,
      bias: Storage.getBias(),
      byCategory: Storage.getBiasByCategory(3) || [],
      from: meals[0].date,
      to: meals[meals.length - 1].date
    };
  }

  function bar(value, max) {
    var pct = max > 0 ? Math.round(value / max * 100) : 0;
    return '<span class="bar"><span style="width:' + pct + '%"></span></span>';
  }

  function html(a) {
    var d = function (t) { return new Date(t).toLocaleDateString('fr-FR'); };
    var maxTranche = 0;
    Object.keys(a.byTranche).forEach(function (k) {
      if (a.byTranche[k].n > maxTranche) maxTranche = a.byTranche[k].n;
    });

    var trancheRows = TRANCHES.map(function (t) {
      var v = a.byTranche[t[0]];
      if (!v.n) return '';
      return '<tr><td>' + t[0] + '</td>' +
        '<td class="num">' + v.n + '</td>' +
        '<td class="num">' + Math.round(v.sum / v.n) + ' g</td>' +
        '<td class="barcell">' + bar(v.n, maxTranche) + '</td></tr>';
    }).join('');

    // Fiabilité : on ne conclut pas sur trop peu de repas mesurés.
    var fiab;
    if (a.mesures < 3) {
      fiab = '<p class="muted">Trop peu de repas avec une valeur réelle saisie (' + a.mesures +
        ') pour conclure sur un écart systématique.</p>';
    } else {
      var sens = a.bias.pct > 0 ? 'sous-estimation' : 'sur-estimation';
      fiab = '<p>Sur <strong>' + a.mesures + ' repas</strong> où la valeur réelle a été relevée, ' +
        'les estimations montrent une <strong>' + sens + ' moyenne de ' +
        Math.abs(a.bias.pct) + ' %</strong>.</p>';
      if (a.byCategory.length) {
        fiab += '<table><thead><tr><th>Catégorie</th><th class="num">Repas</th>' +
          '<th class="num">Écart moyen</th></tr></thead><tbody>' +
          a.byCategory.map(function (g) {
            return '<tr><td>' + esc(g.category) + '</td><td class="num">' + g.count +
              '</td><td class="num">' + (g.pct > 0 ? '+' : '') + g.pct + ' %</td></tr>';
          }).join('') + '</tbody></table>' +
          '<p class="muted">Un écart positif signifie que le repas contenait plus de glucides ' +
          'qu\'estimé.</p>';
      }
    }

    var glBlock = a.gl != null
      ? '<tr><td>Charge glycémique moyenne</td><td class="num">' + Math.round(a.gl) +
        '</td><td class="muted">sur ' + a.glCount + ' repas</td></tr>'
      : '';

    return [
      '<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<title>GlucoVision — synthèse ' + a.days + ' jours</title><style>',
      'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
      'max-width:760px;margin:0 auto;padding:24px 18px;color:#111;line-height:1.55;font-size:15px}',
      'h1{font-size:21px;margin:0 0 4px}h2{font-size:16px;margin:26px 0 8px;',
      'padding-bottom:5px;border-bottom:2px solid #0f766e;color:#0f766e}',
      '.sub{color:#666;font-size:13px;margin:0 0 18px}',
      'table{border-collapse:collapse;width:100%;margin:10px 0;font-size:14px}',
      'th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #e5e5e5}',
      'th{font-weight:600;color:#555;font-size:12.5px;text-transform:uppercase;letter-spacing:.03em}',
      '.num{text-align:right;white-space:nowrap}',
      '.muted{color:#666;font-size:13px}',
      '.barcell{width:38%}',
      '.bar{display:block;background:#eee;height:9px;border-radius:5px;overflow:hidden}',
      '.bar span{display:block;background:#0f766e;height:100%}',
      '.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:12px 0}',
      '.kpi{border:1px solid #e5e5e5;border-radius:9px;padding:10px 12px}',
      '.kpi b{display:block;font-size:22px;color:#0f766e;line-height:1.2}',
      '.kpi span{font-size:12.5px;color:#666}',
      '.warn{background:#fff8e6;border:1px solid #f0d089;border-radius:9px;',
      'padding:11px 13px;font-size:13px;margin:20px 0}',
      '@media print{body{padding:0;font-size:12pt}h2{break-after:avoid}tr{break-inside:avoid}}',
      '</style></head><body>',

      '<h1>Synthèse des glucides — ' + a.days + ' derniers jours</h1>',
      '<p class="sub">Du ' + d(a.from) + ' au ' + d(a.to) + ' · ' + a.count + ' repas sur ' +
        a.nbJours + ' jours · document généré le ' + new Date().toLocaleDateString('fr-FR') + '</p>',

      '<div class="warn"><strong>Nature du document.</strong> Ces chiffres sont des ' +
      '<strong>estimations</strong> faites par le patient à partir de photos de repas, ' +
      'pas des mesures de laboratoire. L\'application n\'est pas un dispositif médical, ' +
      'ne connaît ni les glycémies ni les doses d\'insuline, et n\'en propose aucune.</div>',

      '<h2>Vue d\'ensemble</h2>',
      '<div class="grid">',
      '<div class="kpi"><b>' + Math.round(a.moyenne) + ' g</b><span>glucides par repas (moyenne)</span></div>',
      '<div class="kpi"><b>' + fr1(a.moyenne / a.partSize) + '</b><span>parts par repas · 1 part = ' + a.partSize + ' g</span></div>',
      '<div class="kpi"><b>' + Math.round(a.glucidesParJour) + ' g</b><span>glucides par jour</span></div>',
      '<div class="kpi"><b>' + fr1(a.parJour) + '</b><span>repas enregistrés par jour</span></div>',
      '</div>',

      '<table><tbody>',
      '<tr><td>Médiane par repas</td><td class="num">' + a.mediane + ' g</td><td class="muted">moins sensible aux repas exceptionnels</td></tr>',
      '<tr><td>Étendue</td><td class="num">' + a.min + ' – ' + a.max + ' g</td><td class="muted">du plus léger au plus copieux</td></tr>',
      glBlock,
      '</tbody></table>',

      '<h2>Répartition dans la journée</h2>',
      '<table><thead><tr><th>Moment</th><th class="num">Repas</th>' +
        '<th class="num">Moyenne</th><th></th></tr></thead><tbody>' + trancheRows + '</tbody></table>',

      '<h2>Fiabilité des estimations</h2>',
      fiab,

      '<h2>Détail des repas</h2>',
      '<table><thead><tr><th>Date</th><th>Moment</th><th class="num">Glucides</th>' +
        '<th class="num">Parts</th><th class="num">Réel</th></tr></thead><tbody>',
      a.meals.slice().reverse().map(function (e) {
        var dt = new Date(e.date);
        return '<tr><td>' + dt.toLocaleDateString('fr-FR') + ' ' +
          dt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) + '</td>' +
          '<td>' + trancheOf(e.date) + '</td>' +
          '<td class="num">' + e.totalCarbsG + ' g</td>' +
          '<td class="num">' + fr1(e.totalCarbsG / (e.partSizeG || a.partSize)) + '</td>' +
          '<td class="num">' + (e.realCarbsG > 0 ? e.realCarbsG + ' g' : '—') + '</td></tr>';
      }).join(''),
      '</tbody></table>',
      '<p class="muted">Généré par GlucoVision. Les aliments de chaque repas ne sont pas ' +
      'détaillés ici pour garder le document lisible.</p>',
      '</body></html>'
    ].join('\n');
  }

  window.Report = {
    analyse: analyse,
    html: function (days) {
      var a = analyse(days);
      return a ? { html: html(a), stats: a } : null;
    }
  };
})();
