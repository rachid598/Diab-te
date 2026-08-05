#!/usr/bin/env bash
# Prépare le projet iOS à partir du contenu web.
#
# Le projet ios/ n'est pas versionné, exactement comme android/ : Capacitor le
# régénère à partir de capacitor.config.json, et le committer reviendrait à
# suivre des milliers de lignes générées.
#
# Cette branche ne contient aucune mesure de profondeur : le script se limite
# donc à préparer www/, à synchroniser le projet, et à déclarer les
# autorisations. Rien de natif ne lui est propre.
#
# À relancer après CHAQUE modification de js/, css/ ou index.html. Ensuite,
# dans Xcode, le bouton ▶ suffit.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$(uname)" != "Darwin" ]; then
  echo "ERREUR : la construction iOS exige macOS." >&2
  exit 1
fi

bash scripts/build-www.sh

if [ ! -d ios ]; then
  echo "→ Création du projet iOS"
  npx cap add ios
fi

npx cap sync ios

APP=ios/App/App
if [ ! -d "$APP" ]; then
  echo "ERREUR : $APP introuvable après 'cap sync'." >&2
  exit 1
fi

# Les autorisations. Sans ces clés, iOS TUE l'application au moment précis où
# elle demande la caméra — sans message, sans journal côté web. C'est le genre
# de panne qu'on met une heure à diagnostiquer parce qu'elle ne ressemble pas à
# une erreur de permission mais à un plantage.
PLIST="$APP/Info.plist"
set_plist() {
  /usr/libexec/PlistBuddy -c "Set :$1 $2" "$PLIST" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$PLIST"
}
set_plist NSCameraUsageDescription \
  "'GlucoVision photographie votre assiette pour estimer les glucides.'"
set_plist NSPhotoLibraryUsageDescription \
  "'Pour estimer les glucides d'\''une photo de repas déjà prise.'"
set_plist NSPhotoLibraryAddUsageDescription \
  "'Pour enregistrer la photo du repas analysé.'"

echo
echo "Prêt. Ouvre Xcode :   npx cap open ios"
