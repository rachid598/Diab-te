#!/usr/bin/env bash
# Prépare le projet iOS et y injecte la mesure LiDAR.
#
# Le projet ios/ n'est pas versionné, exactement comme android/ : Capacitor le
# régénère à partir de capacitor.config.json, et le committer reviendrait à
# suivre des milliers de lignes générées. Les seules sources qui nous
# appartiennent vivent dans ios-src/ et sont recopiées ici à chaque fois.
#
# À relancer après CHAQUE modification de js/, css/, index.html ou ios-src/.
# Ensuite, dans Xcode, le bouton ▶ suffit.
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

echo "→ Injection de la mesure LiDAR"
cp ios-src/*.swift "$APP"/

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
  "'GlucoVision photographie et mesure votre assiette pour estimer les glucides.'"
set_plist NSPhotoLibraryUsageDescription \
  "'Pour estimer les glucides d'\''une photo de repas déjà prise.'"
set_plist NSPhotoLibraryAddUsageDescription \
  "'Pour enregistrer la photo du repas analysé.'"

echo
echo "Prêt. Ouvre Xcode :   npx cap open ios"
