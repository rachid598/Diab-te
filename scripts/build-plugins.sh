#!/usr/bin/env bash
# Reconstruit vendor/capacitor-plugins.js à partir de src/capacitor-plugins.js.
#
# Pourquoi un fichier committé plutôt qu'une étape de build ?
# L'app est servie en scripts classiques, sans bundler à l'exécution, et
# GitHub Pages publie le dépôt tel quel. Committer le bundle garantit que la
# PWA, l'APK et les mises à jour OTA servent tous exactement les mêmes octets.
#
# À relancer uniquement après un changement de version de plugin Capacitor.
set -euo pipefail
cd "$(dirname "$0")/.."

npx esbuild src/capacitor-plugins.js \
  --bundle --minify --format=iife --target=es2017 \
  --outfile=vendor/capacitor-plugins.js

echo "vendor/capacitor-plugins.js reconstruit — $(du -h vendor/capacitor-plugins.js | cut -f1)"
