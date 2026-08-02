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

# Puis TOUTES les autres copies présentes dans ios/. Quand on ajoute les
# fichiers au projet via « File > Add Files to "App"… » en laissant cochée
# l'option « Copy items if needed », Xcode les dépose dans le dossier du groupe
# racine — ios/App/ — et non dans ios/App/App/. Le projet référence alors cette
# copie-là, celle que le cp ci-dessus ne touche pas.
#
# La panne qui en découle est la pire de toutes : le script annonce
# « Injection », la construction réussit, l'app se lance, et elle exécute
# l'ancien code. Rien n'échoue, donc rien ne le signale. Un nettoyage complet du
# cache n'y change rien : il recompile à fond le mauvais fichier. Ça a coûté
# trois cycles de compilation avant qu'un find ne montre les deux chemins.
#
# On ne supprime pas la copie parallèle : le projet la référence, l'effacer
# casserait la construction. On la garde alignée.
for src in ios-src/*.swift; do
  base=$(basename "$src")
  while IFS= read -r dup; do
    [ "$dup" = "$APP/$base" ] && continue
    echo "  ↳ copie parallèle alignée : $dup"
    cp "$src" "$dup"
  done < <(find ios -name "$base" -type f)
done

# Poser les fichiers dans le dossier ne suffit pas : Xcode ne compile que ce qui
# est référencé dans App.xcodeproj. Non référencés, ils sont ignorés EN SILENCE —
# la construction réussit, l'app se lance, et le plugin DepthScan n'existe
# simplement pas côté JS. Aucun message nulle part pour le dire.
if ! grep -q "DepthMeasure.swift" ios/App/App.xcodeproj/project.pbxproj 2>/dev/null; then
  echo
  echo "  À VÉRIFIER — Depth*.swift n'est pas listé dans App.xcodeproj."
  echo "  Ouvre Xcode : si les trois fichiers n'apparaissent pas sous App > App,"
  echo "  fais File > Add Files to \"App\"…, sélectionne-les dans $APP,"
  echo "  et coche « Add to targets: App ». Une seule fois."
  echo "  (Fausse alerte possible : les versions récentes de Xcode peuvent inclure"
  echo "   un dossier entier sans le détailler dans le fichier projet.)"
  echo
fi

# Le contrôleur de vue du storyboard doit être NOTRE sous-classe, celle qui
# enregistre DepthScanPlugin. Capacitor ne découvre pas les plugins écrits dans
# la cible de l'app : sans cet enregistrement, le proxy JS existe, l'appel part,
# et le pont répond « not implemented on ios » sans que rien n'ait échoué.
STORY="$APP/Base.lproj/Main.storyboard"
if [ -f "$STORY" ] && ! grep -q "GVBridgeViewController" "$STORY"; then
  echo "→ Branchement du contrôleur de vue"
  /usr/bin/sed -i '' \
    's|customClass="CAPBridgeViewController" customModule="Capacitor"|customClass="GVBridgeViewController" customModule="App" customModuleProvider="target"|' \
    "$STORY"
  if ! grep -q "GVBridgeViewController" "$STORY"; then
    echo "  ERREUR : impossible de patcher $STORY." >&2
    echo "  Ouvre-le dans Xcode, sélectionne le View Controller, et mets" >&2
    echo "  « GVBridgeViewController » dans l'inspecteur d'identité (Class)." >&2
  fi
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
  "'GlucoVision photographie et mesure votre assiette pour estimer les glucides.'"
set_plist NSPhotoLibraryUsageDescription \
  "'Pour estimer les glucides d'\''une photo de repas déjà prise.'"
set_plist NSPhotoLibraryAddUsageDescription \
  "'Pour enregistrer la photo du repas analysé.'"

echo
echo "Prêt. Ouvre Xcode :   npx cap open ios"
