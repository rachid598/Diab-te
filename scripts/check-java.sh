#!/usr/bin/env bash
# Compile android-src/DepthMeasure.java hors du projet Android, contre des
# bouchons minimaux.
#
# Pourquoi : le code natif n'est compilé qu'en intégration continue, où un cycle
# complet prend trois minutes. Une faute de frappe — « kept.length » sur un int —
# a suffi à livrer une version qui ne compilait pas, après avoir annoncé un APK.
# DepthMeasure est le fichier où l'on itère le plus (c'est lui qui porte tout le
# calcul), et il ne dépend que de quatre types externes : c'est donc celui qui
# vaut la peine d'être vérifié en deux secondes avant de pousser.
#
# Les autres fichiers natifs tirent la moitié du SDK Android ; les boucher
# coûterait plus cher que ce que ça rapporte. Ils restent couverts par le build.
set -euo pipefail
cd "$(dirname "$0")/.."

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/stubs/android/media" "$WORK/stubs/com/google/ar/core" "$WORK/out"

cat > "$WORK/stubs/android/media/Image.java" <<'EOF'
package android.media;
import java.nio.ByteBuffer;
public abstract class Image {
  public static abstract class Plane {
    public abstract ByteBuffer getBuffer();
    public abstract int getRowStride();
  }
  public abstract int getWidth();
  public abstract int getHeight();
  public abstract int getFormat();
  public abstract Plane[] getPlanes();
  public abstract void close();
}
EOF

cat > "$WORK/stubs/com/google/ar/core/CameraIntrinsics.java" <<'EOF'
package com.google.ar.core;
public abstract class CameraIntrinsics {
  public abstract int[] getImageDimensions();
  public abstract float[] getFocalLength();
  public abstract float[] getPrincipalPoint();
}
EOF

cat > "$WORK/stubs/com/google/ar/core/Camera.java" <<'EOF'
package com.google.ar.core;
public abstract class Camera {
  public abstract CameraIntrinsics getTextureIntrinsics();
}
EOF

cat > "$WORK/stubs/com/google/ar/core/Frame.java" <<'EOF'
package com.google.ar.core;
public abstract class Frame {
  public abstract Camera getCamera();
}
EOF

javac -nowarn -d "$WORK/out" -sourcepath "$WORK/stubs" \
      $(find "$WORK/stubs" -name '*.java') android-src/DepthMeasure.java

echo "DepthMeasure.java compile."
