#!/usr/bin/env python3
"""Vérifie que chaque appel à DepthMeasure.measure passe le bon nombre d'arguments.

Les appelants ne sont pas compilés par scripts/check-java.sh : ils tirent la
moitié du SDK Android, et les boucher coûterait plus que le service rendu. Or
c'est précisément là que la v56 a échoué. La signature de measure() avait gagné
un paramètre — la carte de confiance — et un second appel resté dans l'activité
n'a été signalé qu'après deux minutes de compilation Gradle, une fois l'APK déjà
annoncé.

À défaut de compiler ces fichiers, on compte leurs arguments.
"""
import glob
import re
import sys

SRC = 'android-src/DepthMeasure.java'


def expected_arity():
    m = re.search(r'static Result measure\(([^)]*)\)', open(SRC, encoding='utf-8').read())
    if not m:
        sys.exit('signature de measure() introuvable dans ' + SRC)
    return len([a for a in m.group(1).split(',') if a.strip()])


def arity_at(text, start):
    """Nombre d'arguments de l'appel dont la parenthèse ouvrante suit `start`."""
    depth, count, seen = 0, 1, False
    for ch in text[start:]:
        if ch in '([':
            depth += 1
        elif ch in ')]':
            if depth == 0:
                return count if seen else 0
            depth -= 1
        elif ch == ',' and depth == 0:
            count += 1
        if not ch.isspace():
            seen = True
    return count


def main():
    want = expected_arity()
    bad = False
    for path in sorted(glob.glob('android-src/*.java')):
        text = open(path, encoding='utf-8').read()
        for m in re.finditer(r'DepthMeasure\.measure\(', text):
            got = arity_at(text, m.end())
            if got != want:
                line = text.count('\n', 0, m.start()) + 1
                print('::error file=%s,line=%d::DepthMeasure.measure appelé avec %d '
                      'argument(s), %d attendu(s)' % (path, line, got, want))
                bad = True
    if bad:
        sys.exit(1)
    print('Appels à DepthMeasure.measure conformes (%d arguments).' % want)


if __name__ == '__main__':
    main()
