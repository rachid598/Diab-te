package io.github.rachid598.glucovision;

/** Tests deterministes de la carte etalon, sans Android ni ARCore. */
public final class CardGeometryTest {
    private static int assertions;

    public static void main(String[] args) {
        testFaceOnMetricField();
        testPhotoRotation();
        testImplausiblePoseIsRejected();
        testDepthAgreementIsFailClosed();
        testTrackingMustBeFreshAndStable();
        System.out.println("CardGeometryTest: " + assertions + " assertions OK");
    }

    private static void testFaceOnMetricField() {
        double half = Math.sqrt(0.5);
        CardGeometry.Result result = CardGeometry.measure(
                new float[] { 0, 0, -0.60f },
                new float[] { (float) half, 0, 0, (float) half },
                1000, 1000, 960, 540, 1920, 1080);
        truth(result.ok, "pose face camera acceptee");
        close(result.fieldWidthCm, 115.2, 1e-4, "largeur metrique du champ");
        close(result.fieldHeightCm, 64.8, 1e-4, "hauteur metrique du champ");
        close(result.distanceCm, 60.0, 1e-4, "distance au plan");
        close(result.centerDistanceCm, 60.0, 1e-4, "distance au centre");
        close(result.cmPerPixel, 0.06, 1e-6, "echelle pixel");
        close(result.incidenceDeg, 0.0, 1e-5, "incidence face camera");
    }

    private static void testPhotoRotation() {
        double half = Math.sqrt(0.5);
        CardGeometry.Result result = CardGeometry.measure(
                new float[] { 0, 0, -0.60f },
                new float[] { (float) half, 0, 0, (float) half },
                1000, 1000, 960, 540, 1920, 1080);
        result.orientForPhoto(90, 1080, 1920);
        close(result.fieldWidthCm, 64.8, 1e-4, "rotation echange la largeur");
        close(result.fieldHeightCm, 115.2, 1e-4, "rotation echange la hauteur");
        close(result.cmPerPixel, 0.06, 1e-6, "echelle du JPEG tourne");
    }

    private static void testImplausiblePoseIsRejected() {
        CardGeometry.Result tooClose = CardGeometry.measure(
                new float[] { 0, 0, -0.20f },
                new float[] { 0.70710677f, 0, 0, 0.70710677f },
                1000, 1000, 960, 540, 1920, 1080);
        truth(!tooClose.ok, "carte trop proche refusee");

        /* Rotation X de 20 degres : le plan est vu a environ 70 degres,
           pratiquement par la tranche. */
        double a = Math.toRadians(20) / 2.0;
        CardGeometry.Result edgeOn = CardGeometry.measure(
                new float[] { 0, 0, -0.60f },
                new float[] { (float) Math.sin(a), 0, 0, (float) Math.cos(a) },
                1000, 1000, 960, 540, 1920, 1080);
        truth(!edgeOn.ok, "incidence extreme refusee");
    }

    private static void testDepthAgreementIsFailClosed() {
        CardGeometry.Result card = faceOn();
        truth(CardGeometry.agreesWithDepth(
                        card, card.fieldWidthCm, card.fieldHeightCm, card.distanceCm,
                        card.planeA, card.planeB, 0.08, 5.0, 8.0),
                "deux plans identiques concordent");
        truth(!CardGeometry.agreesWithDepth(
                        card, card.fieldWidthCm * 1.20, card.fieldHeightCm, card.distanceCm,
                        card.planeA, card.planeB, 0.08, 5.0, 8.0),
                "echelle Depth divergente refusee");
        truth(!CardGeometry.agreesWithDepth(
                        card, card.fieldWidthCm, card.fieldHeightCm, card.distanceCm + 8,
                        card.planeA, card.planeB, 0.08, 5.0, 8.0),
                "distance Depth divergente refusee");
        truth(!CardGeometry.agreesWithDepth(
                        card, card.fieldWidthCm, card.fieldHeightCm, card.distanceCm,
                        Math.tan(Math.toRadians(15)), 0, 0.08, 5.0, 8.0),
                "normale Depth divergente refusee");
    }

    private static void testTrackingMustBeFreshAndStable() {
        CardTrackingGate gate = new CardTrackingGate();
        gate.observe(sample(60.0, 80.0), 0);
        gate.observe(sample(60.4, 80.5), 100);
        gate.observe(sample(59.8, 79.8), 200);
        truth(!gate.ready(200), "trois observations insuffisantes");
        gate.observe(sample(60.1, 80.2), 300);
        truth(gate.ready(300), "quatre observations sur 300 ms acceptees");
        truth(gate.observations(300) == 4, "compteur borne a quatre");
        truth(!gate.ready(551), "pose ancienne refusee");

        gate.observe(sample(60.0, 80.0), 600);
        gate.observe(sample(60.0, 80.0), 700);
        gate.observe(sample(60.0, 80.0), 800);
        gate.observe(sample(60.0, 95.0), 900);
        truth(!gate.ready(900), "echelle instable refusee");
        gate.lost();
        truth(!gate.ready(900) && gate.observations(900) == 0,
                "perte de carte vide immediatement la fenetre");
    }

    private static CardGeometry.Result faceOn() {
        return CardGeometry.measure(
                new float[] { 0, 0, -0.60f },
                new float[] { 0.70710677f, 0, 0, 0.70710677f },
                1000, 1000, 960, 540, 1920, 1080);
    }

    private static CardGeometry.Result sample(double distanceCm, double widthCm) {
        CardGeometry.Result result = new CardGeometry.Result();
        result.ok = true;
        result.distanceCm = distanceCm;
        result.fieldWidthCm = widthCm;
        result.fieldHeightCm = widthCm * 0.60;
        result.incidenceDeg = 12.0;
        return result;
    }

    private static void truth(boolean condition, String message) {
        assertions++;
        if (!condition) throw new AssertionError(message);
    }

    private static void close(double actual, double expected, double tolerance, String message) {
        assertions++;
        if (!Double.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
            throw new AssertionError(message + " : attendu " + expected + ", obtenu " + actual);
        }
    }
}
