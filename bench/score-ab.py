#!/usr/bin/env python3
"""Comparaison APPARIEE de deux manches du banc sur les memes plats.

Comparer deux MAE globales ne dit presque rien sur 44 plats : l'ecart-type entre
plats ecrase la difference entre prompts. Ici chaque plat est son propre temoin
— on regarde, plat par plat, si l'erreur absolue a baisse ou monte. C'est le
seul cadre ou une difference de quelques grammes devient interpretable.

Test des signes, sans dependance : sous l'hypothese nulle « le prompt ne change
rien », chaque plat a une chance sur deux de s'ameliorer, et la p-valeur est
la binomiale exacte bilaterale.

Usage : BENCH_A=g_avant.json BENCH_B=g_apres.json python3 bench/score-ab.py
"""
import json, os, statistics
from math import comb

HERE = os.path.dirname(os.path.abspath(__file__))
A = json.load(open(os.path.join(HERE, os.environ.get('BENCH_A', 'g_avant.json'))))
B = json.load(open(os.path.join(HERE, os.environ.get('BENCH_B', 'g_apres.json'))))


def binom_bilaterale(k, n):
    """P(au moins aussi extreme que k succes sur n) si p=0.5."""
    if n == 0:
        return 1.0
    total = 2.0 ** n
    k = min(k, n - k)
    queue = sum(comb(n, i) for i in range(0, k + 1))
    return min(1.0, 2 * queue / total)


for model in sorted(set(A) & set(B)):
    a = {r['dish']: r for r in A[model] if 'erreur' not in r and r.get('estime')}
    b = {r['dish']: r for r in B[model] if 'erreur' not in r and r.get('estime')}
    communs = sorted(set(a) & set(b))
    if not communs:
        print('%s : aucun plat commun' % model)
        continue

    ea = [abs(a[d]['estime'] - a[d]['reel']) for d in communs]
    eb = [abs(b[d]['estime'] - b[d]['reel']) for d in communs]
    deltas = [y - x for x, y in zip(ea, eb)]          # < 0 = B est meilleur

    mieux = sum(1 for d in deltas if d < -0.5)
    pire = sum(1 for d in deltas if d > 0.5)
    nuls = len(deltas) - mieux - pire
    p = binom_bilaterale(min(mieux, pire), mieux + pire)

    print('\n=== %s — %d plats communs ===' % (model, len(communs)))
    print('  MAE   A %.1f g   ->   B %.1f g   (%+.1f g)'
          % (statistics.mean(ea), statistics.mean(eb),
             statistics.mean(eb) - statistics.mean(ea)))
    print('  med   A %.1f g   ->   B %.1f g'
          % (statistics.median(ea), statistics.median(eb)))
    print('  biais A %+.1f%%  ->   B %+.1f%%'
          % (statistics.mean(100 * (a[d]['estime'] - a[d]['reel']) / a[d]['reel'] for d in communs),
             statistics.mean(100 * (b[d]['estime'] - b[d]['reel']) / b[d]['reel'] for d in communs)))
    print('  >20 g A %.0f%%    ->   B %.0f%%'
          % (100 * sum(1 for e in ea if e > 20) / len(ea),
             100 * sum(1 for e in eb if e > 20) / len(eb)))
    print('  apparie : %d plats ameliores, %d degrades, %d inchanges  ->  p = %.3f%s'
          % (mieux, pire, nuls, p, '' if p < 0.05 else '  (non significatif)'))

    ecarts = sorted(zip(deltas, communs), key=lambda x: x[0])
    print('  meilleurs gains : ' + ', '.join('%s %+.0f g' % (d[-6:], v) for v, d in ecarts[:3]))
    print('  pires reculs    : ' + ', '.join('%s %+.0f g' % (d[-6:], v) for v, d in ecarts[-3:]))
