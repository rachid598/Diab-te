#!/usr/bin/env python3
"""Notation du banc d'essai — memes metriques que score() de js/bench.js,
plus le cout et le taux d'erreurs cliniquement acceptables."""
import json, os, statistics

HERE = os.path.dirname(os.path.abspath(__file__))
res = json.load(open(os.path.join(HERE, 'resultats.json')))

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
        cout=cost, sec=statistics.mean(r.get('sec', 0) for r in ok),
    ))

rows.sort(key=lambda r: r.get('mae', 1e9))
print('%-34s %3s %4s %6s %6s %7s %6s %6s %6s %8s %5s' % (
    'modele', 'n', 'ech', 'MAE g', 'med g', 'MAPE %', 'biais', 'pire', '<=15g', '$/analyse', 'sec'))
print('-' * 112)
for r in rows:
    if not r['n']:
        print('%-34s  echec total' % r['model']); continue
    print('%-34s %3d %4d %6.1f %6.1f %6.1f%% %+5.1f%% %6.1f %5.0f%% %8.4f %5.0f' % (
        r['model'], r['n'], r['fail'], r['mae'], r['med'], r['mape'], r['biais'],
        r['pire'], r['sous15'], r['cout'], r['sec']))

print('\n--- rapport qualite/prix (MAE x cout, plus bas = mieux) ---')
for r in sorted([x for x in rows if x['n']], key=lambda r: r['mae'] * max(r['cout'], 1e-5)):
    print('%-34s  MAE %5.1f g  x  $%.4f  =  %.5f' % (r['model'], r['mae'], r['cout'], r['mae'] * r['cout']))

json.dump(rows, open(os.path.join(HERE, 'scores.json'), 'w'), indent=1)
