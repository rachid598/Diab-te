#!/usr/bin/env bash
# Compile et execute la geometrie ARCore sans Android, puis compile l'adaptateur
# Image/Frame contre des bouchons minimaux. Le build Gradle reste l'autorite pour
# l'activite complete, mais ces tests echouent en quelques secondes.
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
    public abstract int getPixelStride();
  }
  public abstract int getWidth();
  public abstract int getHeight();
  public abstract Plane[] getPlanes();
  public abstract long getTimestamp();
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
  public abstract CameraIntrinsics getImageIntrinsics();
}
EOF

cat > "$WORK/stubs/com/google/ar/core/Frame.java" <<'EOF'
package com.google.ar.core;
public abstract class Frame {
  public abstract Camera getCamera();
  public abstract long getTimestamp();
}
EOF

javac -encoding UTF-8 -Xlint:all -Werror -d "$WORK/out" \
  $(find "$WORK/stubs" -name '*.java' -print) \
  android-src/DepthGeometry.java \
  android-src/DepthMeasure.java \
  native-tests/DepthGeometryTest.java

java -cp "$WORK/out" io.github.rachid598.glucovision.DepthGeometryTest
python3 scripts/check-calls.py
python3 scripts/test-depth-geometry.py
echo "Contrats Java/ARCore conformes."
