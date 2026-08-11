package io.github.rachid598.glucovision;

/**
 * Geometrie pure du repere carte ARCore.
 *
 * ARCore exprime la pose camera avec un axe optique -Z et +Y vers le haut,
 * tandis que les intrinseques de l'image CPU utilisent +Y vers le bas et une
 * profondeur positive. La conversion est faite une seule fois ici, puis le
 * plan de la carte reutilise exactement la geometrie de projection du plan de
 * table employee par {@link DepthGeometry}.
 */
final class CardGeometry {
    static final double CARD_WIDTH_M = 0.08560;
    static final double CARD_HEIGHT_M = 0.05398;

    private static final double MIN_DISTANCE_M = 0.50;
    private static final double MAX_DISTANCE_M = 0.75;
    private static final double MIN_FIELD_M = 0.10;
    private static final double MAX_FIELD_M = 2.00;
    private static final double MAX_INCIDENCE_DEG = 55.0;

    private CardGeometry() {}

    static final class Result {
        boolean ok;
        double fieldWidthCm;
        double fieldHeightCm;
        double distanceCm;
        double centerDistanceCm;
        double cmPerPixel;
        double incidenceDeg;
        double planeA;
        double planeB;
        double planeC;
        int sourceImageWidthPx;
        int sourceImageHeightPx;
        String note = "";

        void orientForPhoto(int rotationDegrees, int outputWidthPx, int outputHeightPx) {
            int normalized = ((rotationDegrees % 360) + 360) % 360;
            if (normalized == 90 || normalized == 270) {
                double tmp = fieldWidthCm;
                fieldWidthCm = fieldHeightCm;
                fieldHeightCm = tmp;
            }
            cmPerPixel = ok && outputWidthPx > 0 ? fieldWidthCm / outputWidthPx : 0;
            sourceImageWidthPx = outputWidthPx;
            sourceImageHeightPx = outputHeightPx;
        }
    }

    /**
     * Calcule le plan metrique vu par la camera a partir de la pose de la carte.
     * translation/quaternion sont ceux de cameraPose.inverse().compose(cardPose).
     * Le quaternion ARCore est ordonne x, y, z, w.
     */
    static Result measure(
            float[] translation, float[] quaternion,
            double fx, double fy, double cx, double cy,
            int imageWidthPx, int imageHeightPx) {
        Result out = new Result();
        if (!finiteVector(translation, 3) || !finiteVector(quaternion, 4)
                || !(fx > 0) || !(fy > 0) || imageWidthPx <= 0 || imageHeightPx <= 0
                || !Double.isFinite(cx) || !Double.isFinite(cy)) {
            out.note = "Pose ou intrinseques de carte invalides.";
            return out;
        }

        double qx = quaternion[0], qy = quaternion[1];
        double qz = quaternion[2], qw = quaternion[3];
        double qNorm = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
        if (!(qNorm > 1e-9) || !Double.isFinite(qNorm)) {
            out.note = "Rotation de carte invalide.";
            return out;
        }
        qx /= qNorm; qy /= qNorm; qz /= qNorm; qw /= qNorm;

        /* Deuxieme colonne de la matrice de rotation : normale locale +Y de
           l'AugmentedImage, convertie ensuite du repere OpenGL vers le repere
           image/profondeur (x, -y, -z). */
        double normalGlX = 2.0 * (qx * qy - qz * qw);
        double normalGlY = 1.0 - 2.0 * (qx * qx + qz * qz);
        double normalGlZ = 2.0 * (qy * qz + qx * qw);

        double px = translation[0];
        double py = -translation[1];
        double pz = -translation[2];
        double nx = normalGlX;
        double ny = -normalGlY;
        double nz = -normalGlZ;

        double centerDistance = Math.sqrt(px * px + py * py + pz * pz);
        if (!(centerDistance >= MIN_DISTANCE_M && centerDistance <= MAX_DISTANCE_M)) {
            out.note = "Recule a 50-75 cm en gardant la carte et le repas visibles.";
            return out;
        }
        if (Math.abs(nz) < 1e-4) {
            out.note = "Carte vue presque par la tranche.";
            return out;
        }

        double normalLength = Math.sqrt(nx * nx + ny * ny + nz * nz);
        double viewCos = Math.abs((nx * -px + ny * -py + nz * -pz)
                / (normalLength * centerDistance));
        viewCos = Math.max(0.0, Math.min(1.0, viewCos));
        double incidence = Math.toDegrees(Math.acos(viewCos));
        if (!Double.isFinite(incidence) || incidence > MAX_INCIDENCE_DEG) {
            out.note = "Carte trop inclinee dans l'image (" + Math.round(incidence) + " degres).";
            return out;
        }

        /* n.(X-P)=0, mis sous la forme z = a*x + b*y + c utilisee par
           DepthGeometry. Le signe de la normale est sans importance. */
        double a = -nx / nz;
        double b = -ny / nz;
        double c = (nx * px + ny * py + nz * pz) / nz;
        if (!Double.isFinite(a) || !Double.isFinite(b) || !Double.isFinite(c)
                || c < MIN_DISTANCE_M || c > MAX_DISTANCE_M) {
            out.note = "Plan de carte incoherent devant la camera.";
            return out;
        }

        DepthGeometry.Intrinsics intrinsics = new DepthGeometry.Intrinsics(
                fx, fy, cx, cy, imageWidthPx, imageHeightPx);
        DepthGeometry.Plane plane = new DepthGeometry.Plane(a, b, c, 0, 0);
        double[] field = DepthGeometry.fieldSizeOnPlane(intrinsics, plane);
        if (field == null || !Double.isFinite(field[0]) || !Double.isFinite(field[1])
                || field[0] < MIN_FIELD_M || field[1] < MIN_FIELD_M
                || field[0] > MAX_FIELD_M || field[1] > MAX_FIELD_M) {
            out.note = "Champ metrique deduit de la carte incoherent.";
            return out;
        }

        out.ok = true;
        out.fieldWidthCm = field[0] * 100.0;
        out.fieldHeightCm = field[1] * 100.0;
        out.distanceCm = c * 100.0;
        out.centerDistanceCm = centerDistance * 100.0;
        out.cmPerPixel = out.fieldWidthCm / imageWidthPx;
        out.incidenceDeg = incidence;
        out.planeA = a;
        out.planeB = b;
        out.planeC = c;
        out.sourceImageWidthPx = imageWidthPx;
        out.sourceImageHeightPx = imageHeightPx;
        out.note = "Carte suivie et plan metrique disponible.";
        return out;
    }

    /** Compare deux mesures independantes du meme plan avant toute rotation JPEG. */
    static boolean agreesWithDepth(
            Result card,
            double depthFieldWidthCm, double depthFieldHeightCm, double depthDistanceCm,
            double depthPlaneA, double depthPlaneB,
            double maxRelativeFieldError, double maxDistanceErrorCm,
            double maxNormalAngleDeg) {
        if (card == null || !card.ok
                || !(depthFieldWidthCm > 0) || !(depthFieldHeightCm > 0)
                || !(depthDistanceCm > 0)
                || !Double.isFinite(depthPlaneA) || !Double.isFinite(depthPlaneB)) return false;
        if (relativeError(card.fieldWidthCm, depthFieldWidthCm) > maxRelativeFieldError
                || relativeError(card.fieldHeightCm, depthFieldHeightCm) > maxRelativeFieldError
                || Math.abs(card.distanceCm - depthDistanceCm) > maxDistanceErrorCm) return false;

        double ax = card.planeA, ay = card.planeB, az = -1.0;
        double bx = depthPlaneA, by = depthPlaneB, bz = -1.0;
        double dot = Math.abs(ax * bx + ay * by + az * bz);
        double lengths = Math.sqrt(ax * ax + ay * ay + az * az)
                * Math.sqrt(bx * bx + by * by + bz * bz);
        if (!(lengths > 0) || !Double.isFinite(lengths)) return false;
        double cosine = Math.max(0.0, Math.min(1.0, dot / lengths));
        return Math.toDegrees(Math.acos(cosine)) <= maxNormalAngleDeg;
    }

    private static double relativeError(double a, double b) {
        return Math.abs(a - b) / Math.max(Math.min(a, b), 1e-9);
    }

    private static boolean finiteVector(float[] values, int minimumLength) {
        if (values == null || values.length < minimumLength) return false;
        for (int i = 0; i < minimumLength; i++) {
            if (!Float.isFinite(values[i])) return false;
        }
        return true;
    }
}
