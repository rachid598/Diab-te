#!/usr/bin/env python3
"""Notation du banc d'essai — memes metriques que score() de js/bench.js,
plus le cout et le taux d'erreurs cliniquement acceptables."""
import json, os, statistics

HERE = os.path.dirname(os.path.abspath(__file__))
res = json.load(open(os.path.join(HERE, os.environ.get('BENCH_OUT', 'resultats.json'))))

def pct(tries, q):
    """Centile sur une liste DEJA triee, par interpolation lineaire.

    Ecrit a la main plutot qu'importe : le banc doit tourner sans dependance,
    et statistics.quantiles change de definition selon la methode choisie.
    Sur peu de plats, prendre l'element d'indice arrondi ferait sauter le
    resultat d'un plat a l'autre."""
    if not tries:
        return 0.0
    if len(tries) == 1:
        return float(tries[0])
    pos = (len(tries) - 1) * q / 100.0
    bas = int(pos)
    haut = min(bas + 1, len(tries) - 1)
    return float(tries[bas] + (tries[haut] - tries[bas]) * (pos - bas))


rows = []
for model, recs in res.items():
    ok = [r for r in recs if 'erreur' not in r and r.get('estime')]
    if not ok:
        rows.append(dict(model=model, n=0)); continue
    errs = [r['estime'] - r['reel'] for r in ok]
    pcts = [100 * e / r['reel'] for e, r in zip(errs, ok)]
    cost = sum(r.get('cost', 0) for r in ok) / len(ok)
    rows.append(dict(
        model=model, n=len(ok), fail=len(recs) - len(ok),
        mae=statistics.mean(abs(e) for e in errs),
        mape=statistics.mean(abs(p) for p in pcts),
        biais=statistics.mean(pcts),
        med=statistics.median(abs(e) for e in errs),
        pire=max(abs(e) for e in errs),
        # marge de securite : un ecart > 15 g fausse d'environ 1,5 U d'insuline
        sous15=100 * sum(1 for e in errs if abs(e) <= 15) / len(errs),
        # Les gros ecarts separement de la moyenne. Un modele a 12 g de MAE qui
        # se trompe de 40 g une fois sur dix est plus dangereux qu'un modele a
        # 15 g regulier : c'est la queue qui provoque une mauvaise dose, pas la
        # moyenne. Les etudes cliniques comptent d'ailleurs ces depassements a
        # part.
        sup20=100 * sum(1 for e in errs if abs(e) > 20) / len(errs),
        p90=pct(sorted(abs(e) for e in errs), 90),
        p95=pct(sorted(abs(e) for e in errs), 95),
        cout=cost, sec=statistics.mean(r.get('sec', 0) for r in ok),
    ))

rows.sort(key=lambda r: r.get('mae', 1e9))
print('%-34s %3s %4s %6s %6s %6s %6s %7s %6s %6s %6s %8s %5s' % (
    'modele', 'n', 'ech', 'MAE g', 'med g', 'p90 g', 'p95 g', 'MAPE %', 'biais',
    '>20g', 'pire', '$/analyse', 'sec'))
print('-' * 128)
for r in rows:
    if not r['n']:
        print('%-34s  echec total' % r['model']); continue
    print('%-34s %3d %4d %6.1f %6.1f %6.1f %6.1f %6.1f%% %+5.1f%% %5.0f%% %6.1f %8.4f %5.0f' % (
        r['model'], r['n'], r['fail'], r['mae'], r['med'], r['p90'], r['p95'],
        r['mape'], r['biais'], r['sup20'], r['pire'], r['cout'], r['sec']))

print('\n--- rapport qualite/prix (MAE x cout, plus bas = mieux) ---')
for r in sorted([x for x in rows if x['n']], key=lambda r: r['mae'] * max(r['cout'], 1e-5)):
    print('%-34s  MAE %5.1f g  x  $%.4f  =  %.5f' % (r['model'], r['mae'], r['cout'], r['mae'] * r['cout']))

json.dump(rows, open(os.path.join(HERE, 'scores.json'), 'w'), indent=1)
