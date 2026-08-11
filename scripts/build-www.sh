#!/usr/bin/env bash
# Prépare www/ : les seuls fichiers web à embarquer dans l'APK.
# On ne peut pas pointer Capacitor sur la racine du dépôt — il y copierait
# .git, node_modules et le projet android lui-même.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf www
mkdir -p www

cp index.html manifest.webmanifest glucovision-card.svg www/
cp -r css js vendor icons www/

# Le service worker est délibérément exclu : dans l'APK les fichiers sont déjà
# embarqués, et son cache ne ferait que risquer de servir une version périmée.
# Les mises à jour passent par le mécanisme OTA (voir js/native.js).
# Son enregistrement est de toute façon court-circuité quand Native.isApp.

# vendor/capacitor-plugins.js est committé dans le dépôt (construit par
# scripts/build-plugins.sh) : le contenu web doit être identique sur la PWA et
# dans l'APK, sinon une mise à jour OTA embarquerait un bundle différent de
# celui qui a été testé.
if [ ! -f www/vendor/capacitor-plugins.js ]; then
  echo "ERREUR : vendor/capacitor-plugins.js manquant." >&2
  echo "Lance scripts/build-plugins.sh et committe le résultat." >&2
  exit 1
fi

echo "www/ prêt — $(find www -type f | wc -l) fichiers, $(du -sh www | cut -f1)"
