#!/usr/bin/env bash
# Installe l'APK signé sur l'émulateur, le lance, et attend la preuve qu'il a
# réellement démarré.
#
# La preuve est une ligne que l'application écrit elle-même (annoncerDemarrage,
# dans js/app.js) au tout dernier moment de son initialisation, dans son cache
# privé :
#
#   GLUCOVISION_READY platform=android version=76 build=2076 camera=ok … manques=aucun
#
# Elle n'est atteignable qu'après Native.ready(), Storage.hydrate(), le rendu
# complet et markReady(). Un APK qui plante, qui reste sur un écran blanc ou dont
# le pont natif ne répond pas ne l'écrit jamais : ici, le SILENCE est un échec.
#
# Pourquoi un fichier et non logcat : dans un APK release, Capacitor ne relaie
# pas les messages de console vers les journaux (loggingBehavior = « debug »,
# actif seulement sur une compilation debuggable). Passer par logcat aurait
# imposé d'activer la journalisation dans l'APK publié, c'est-à-dire de tester
# autre chose que ce qu'on livre.
#
# On refuse aussi le démarrage « réussi mais amputé » : manques=… liste les
# plugins requis qui ne se sont pas enregistrés. L'app s'ouvre, mais une partie
# de ce qu'elle affiche n'existe pas — exactement le genre de panne que les
# contrôles d'intégrité de la chaîne de publication ne peuvent pas voir.
set -uo pipefail

APP_ID="${APP_ID:?APP_ID manquant}"
APK=dist/glucovision.apk
SORTIE=emulateur
LOG="$SORTIE/logcat.txt"
RAPPORT="/data/data/$APP_ID/cache/demarrage.txt"
DELAI=90            # secondes accordées au premier démarrage

mkdir -p "$SORTIE"

# Le cache est privé à l'application : sur un APK release (non debuggable),
# « run-as » est refusé. Les images google_apis sont userdebug, adb root y est
# donc disponible — contrairement aux images google_apis_playstore.
echo "== Passage en root"
adb root || true
adb wait-for-device
adb shell id || true

echo "== Installation de $APK ($APP_ID)"
adb install -r "$APK"

# Départ propre : sans ça on pourrait lire le rapport d'un lancement précédent.
adb shell am force-stop "$APP_ID" || true
adb shell rm -f "$RAPPORT" || true
adb logcat -c || true

adb logcat -v time > "$LOG" 2>&1 &
LOGCAT_PID=$!
# shellcheck disable=SC2064
trap "kill $LOGCAT_PID 2>/dev/null || true" EXIT

echo "== Lancement"
# monkey plutôt que « am start -n » : il résout lui-même l'activité de lancement,
# donc le test ne dépend ni du nom de classe ni de l'écart entre applicationId
# et namespace.
adb shell monkey -p "$APP_ID" -c android.intent.category.LAUNCHER 1 >/dev/null

etat=timeout
LIGNE=""
for _ in $(seq 1 $((DELAI / 2))); do
  LIGNE=$(adb shell cat "$RAPPORT" 2>/dev/null | tr -d '\r')
  if [ -n "$LIGNE" ]; then etat=pret; break; fi
  # Un plantage se voit tout de suite : inutile d'attendre le délai complet.
  if grep -qE "FATAL EXCEPTION|ANR in $APP_ID" "$LOG"; then etat=plantage; break; fi
  sleep 2
done

# La capture est prise dans tous les cas : sur échec, c'est elle qui montre si
# l'écran est blanc, figé sur le logo, ou couvert d'un dialogue système.
adb exec-out screencap -p > "$SORTIE/ecran.png" 2>/dev/null || true
printf '%s\n' "$LIGNE" > "$SORTIE/demarrage.txt"

# On ne garde que ce qui concerne l'app : un logcat complet est illisible.
grep -E "FATAL EXCEPTION|AndroidRuntime|Capacitor|$APP_ID" \
  "$LOG" > "$SORTIE/pertinent.txt" 2>/dev/null || true

echo
echo "== Résultat : $etat"

if [ "$etat" = plantage ]; then
  echo "::error::L'APK plante au lancement."
  sed -n '/FATAL EXCEPTION/,+25p' "$LOG" | head -60
  exit 1
fi

if [ "$etat" = timeout ]; then
  echo "::error::Aucun rapport de démarrage après ${DELAI}s : l'application n'a pas fini de démarrer."
  echo "-- 60 dernières lignes pertinentes --"
  tail -60 "$SORTIE/pertinent.txt" || true
  exit 1
fi

echo "$LIGNE"

case "$LIGNE" in
  GLUCOVISION_READY*) ;;
  *) echo "::error::Rapport de démarrage illisible."; exit 1 ;;
esac

MANQUES=$(sed -n 's/.*manques=\([^ ]*\).*/\1/p' <<< "$LIGNE")
if [ "$MANQUES" != aucun ]; then
  echo "::error::L'app démarre mais des plugins natifs requis manquent : $MANQUES"
  exit 1
fi

# Le build annoncé doit être celui qu'on vient d'installer, sinon on validerait
# une application restée en place d'une exécution précédente.
INSTALLE=$(adb shell dumpsys package "$APP_ID" \
  | sed -n 's/.*versionCode=\([0-9]*\).*/\1/p' | head -1)
ANNONCE=$(sed -n 's/.*[^a-z]build=\([0-9?]*\).*/\1/p' <<< "$LIGNE")
echo "== versionCode installé=$INSTALLE, annoncé par l'app=$ANNONCE"
if [ -n "$INSTALLE" ] && [ "$INSTALLE" != "$ANNONCE" ]; then
  echo "::error::L'app annonce le build $ANNONCE alors que $INSTALLE est installé."
  exit 1
fi

echo "OK — l'APK s'installe, démarre, et toutes ses capacités requises répondent."
