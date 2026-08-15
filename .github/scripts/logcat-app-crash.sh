#!/usr/bin/env bash
# Signale uniquement les plantages qui appartiennent à l'application testée.
#
# Usage : logcat-app-crash.sh LOGCAT APPLICATION_ID
# Code retour 0 : FATAL EXCEPTION ou ANR de l'application trouvé.
# Code retour 1 : aucun plantage de cette application (les pannes Android
# système ou celles d'une autre application sont volontairement ignorées).
set -euo pipefail

LOGCAT=${1:?fichier logcat manquant}
APP_ID=${2:?applicationId manquant}

test -f "$LOGCAT" || exit 1

awk -v app_id="$APP_ID" '
  function is_exact_anr(line, marker, pos, following) {
    marker = "ANR in " app_id
    pos = index(line, marker)
    if (!pos) return 0
    following = substr(line, pos + length(marker), 1)
    return following == "" || following !~ /[[:alnum:]_.]/
  }

  /FATAL EXCEPTION:/ {
    fatal_line = $0
    # AndroidRuntime écrit normalement « Process: … » sur la ligne suivante.
    # Une petite fenêtre tolère les variantes de format sans laisser un ancien
    # FATAL contaminer tout le reste du journal.
    fatal_window = 8
    next
  }

  {
    if (fatal_window > 0) {
      if (index($0, "Process: " app_id ",") > 0) {
        print fatal_line
        print $0
        found = 1
      }
      fatal_window--
    }

    if (is_exact_anr($0)) {
      print $0
      found = 1
    }
  }

  END { exit(found ? 0 : 1) }
' "$LOGCAT"
