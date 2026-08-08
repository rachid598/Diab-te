package io.github.rachid598.glucovision;

import java.util.Arrays;

/** Tests JVM deterministes, sans appareil ni SDK Android. */
public final class DepthGeometryTest {
    private static int assertions;

    public static void main(String[] args) {
        testIndependentIntrinsicsScaling();
        testRansacRejectsOutliers();
        testPlaneFieldAndPixelArea();
        testOnlySmallEnclosedHolesAreFilled();
        testFourDistinctStableObservations();
        System.out.println("DepthGeometryTest: " + assertions + " assertions OK");
    }

    private static void testIndependentIntrinsicsScaling() {
        DepthGeometry.Intrinsics k = DepthGeometry.scaleIntrinsics(
                1200, 900, 960, 540, 1920, 1080, 160, 120);
        close(k.fx, 100.0, 1e-9, "fx suit la largeur");
        close(k.fy, 100.0, 1e-9, "fy suit la hauteur");
        close(k.cx, 80.0, 1e-9, "cx");
        close(k.cy, 60.0, 1e-9, "cy");
    }

    private static void testRansacRejectsOutliers() {
        int width = 24, height = 16, count = width * height;
        double[] x = new double[count];
        double[] y = new double[count];
        double[] z = new double[count];
        int n = 0;
        for (int j = 0; j < height; j++) {
            for (int i = 0; i < width; i++) {
                x[n] = (i - width / 2.0) * 0.012;
                y[n] = (j - height / 2.0) * 0.012;
                double noise = ((n * 37) % 11 - 5) * 0.00008;
                z[n] = 0.62 + 0.025 * x[n] - 0.015 * y[n] + noise;
                if (n % 4 == 0) z[n] += (n % 8 == 0 ? 0.09 : -0.07);
                n++;
            }
        }
        DepthGeometry.Plane p = DepthGeometry.fitPlaneRansac(
                x, y, z, count, 0.003, 180, 0.65, 123456789L);
        truth(p != null, "RANSAC trouve le plan");
        close(p.a, 0.025, 0.002, "pente x");
        close(p.b, -0.015, 0.002, "pente y");
        close(p.c, 0.62, 0.001, "distance centrale");
        truth(p.inliers >= count * 0.70, "les vrais points restent majoritaires");
        truth(p.rmsM < 0.001, "RMS submillimetrique sur la scene propre");
    }

    private static void testPlaneFieldAndPixelArea() {
        DepthGeometry.Intrinsics k = new DepthGeometry.Intrinsics(
                100, 120, 80, 60, 160, 120);
        DepthGeometry.Plane p = new DepthGeometry.Plane(0, 0, 0.60, 100, 0);
        double[] field = DepthGeometry.fieldSizeOnPlane(k, p);
        close(field[0], 0.96, 1e-9, "largeur du champ");
        close(field[1], 0.60, 1e-9, "hauteur du champ");
        close(DepthGeometry.tablePixelArea(80, 60, k, p),
                0.60 * 0.60 / (100 * 120), 1e-12, "aire exacte d'un pixel horizontal");

        DepthGeometry.Plane tilted = new DepthGeometry.Plane(0.08, -0.04, 0.60, 100, 0);
        double area = DepthGeometry.tablePixelArea(100, 70, k, tilted);
        truth(Double.isFinite(area) && area > 0, "aire positive sur plan incline");
    }

    private static void testOnlySmallEnclosedHolesAreFilled() {
        int width = 5, height = 5;
        boolean[] candidate = new boolean[width * height];
        boolean[] trusted = new boolean[width * height];
        Arrays.fill(candidate, true);
        Arrays.fill(trusted, true);
        trusted[2 * width + 2] = false;
        boolean[] filled = DepthGeometry.fillSmallEnclosedHoles(
                candidate, trusted, width, height, 1);
        truth(filled[2 * width + 2], "trou isole rempli");

        trusted[2 * width + 1] = false;
        filled = DepthGeometry.fillSmallEnclosedHoles(candidate, trusted, width, height, 1);
        truth(!filled[2 * width + 1] && !filled[2 * width + 2], "grand trou refuse");

        Arrays.fill(trusted, true);
        trusted[0] = false;
        filled = DepthGeometry.fillSmallEnclosedHoles(candidate, trusted, width, height, 2);
        truth(!filled[0], "interpolation au bord refusee");
    }

    private static void testFourDistinctStableObservations() {
        double[] distance = { 0.60, 0.61, 0.595, 0.605 };
        double[] field = { 0.72, 0.725, 0.718, 0.721 };
        truth(DepthGeometry.observationsStable(distance, field, 4, 0.025, 0.05),
                "quatre observations coherentes acceptees");
        distance[3] = 0.66;
        truth(!DepthGeometry.observationsStable(distance, field, 4, 0.025, 0.05),
                "distance instable refusee");
        distance[3] = 0.605;
        field[3] = 0.80;
        truth(!DepthGeometry.observationsStable(distance, field, 4, 0.025, 0.05),
                "echelle instable refusee");
        truth(!DepthGeometry.observationsStable(distance, field, 3, 0.025, 0.05),
                "moins de quatre observations refusees");
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
