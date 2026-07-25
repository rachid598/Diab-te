#!/usr/bin/env bash
# Prépare www/ : les seuls fichiers web à embarquer dans l'APK.
# On ne peut pas pointer Capacitor sur la racine du dépôt — il y copierait
# .git, node_modules et le projet android lui-même.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf www
mkdir -p www

cp index.html manifest.webmanifest www/
cp -r css js vendor icons www/

# Le service worker est délibérément exclu : dans l'APK les fichiers sont déjà
# embarqués, et son cache ne ferait que risquer de servir une version périmée.
# Son enregistrement échoue alors sans bruit (l'appel est déjà dans un catch).

echo "www/ prêt — $(find www -type f | wc -l) fichiers, $(du -sh www | cut -f1)"
