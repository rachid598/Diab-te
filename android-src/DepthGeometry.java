package io.github.rachid598.glucovision;

import java.util.ArrayDeque;
import java.util.Arrays;

/**
 * Geometrie pure de la mesure ARCore.
 *
 * Cette classe ne depend ni d'Android ni d'ARCore. Les calculs critiques peuvent
 * donc etre executes de facon deterministe sur la JVM de la CI, avec des scenes
 * synthetiques dont la verite terrain est connue.
 */
final class DepthGeometry {
    private DepthGeometry() {}

    static final class Intrinsics {
        final double fx, fy, cx, cy;
        final int width, height;

        Intrinsics(double fx, double fy, double cx, double cy, int width, int height) {
            this.fx = fx;
            this.fy = fy;
            this.cx = cx;
            this.cy = cy;
            this.width = width;
            this.height = height;
        }
    }

    /** Plan sous la forme z = a*x + b*y + c, dans le repere camera. */
    static final class Plane {
        final double a, b, c;
        final int inliers;
        final double rmsM;

        Plane(double a, double b, double c, int inliers, double rmsM) {
            this.a = a;
            this.b = b;
            this.c = c;
            this.inliers = inliers;
            this.rmsM = rmsM;
        }

        double normalLength() {
            return Math.sqrt(a * a + b * b + 1.0);
        }

        double heightAbove(double x, double y, double z) {
            return (a * x + b * y + c - z) / normalLength();
        }

        double tiltDeg() {
            return Math.toDegrees(Math.acos(Math.min(1.0, 1.0 / normalLength())));
        }
    }

    static final class Point3 {
        final double x, y, z;

        Point3(double x, double y, double z) {
            this.x = x;
            this.y = y;
            this.z = z;
        }
    }

    /**
     * Redimensionne les intrinseques sur chaque axe independamment.
     *
     * Une carte Depth peut avoir un autre rapport d'aspect que l'image CPU. Un
     * facteur unique base sur la largeur deforme alors fy et toutes les surfaces.
     */
    static Intrinsics scaleIntrinsics(
            double fx, double fy, double cx, double cy,
            int sourceWidth, int sourceHeight, int targetWidth, int targetHeight) {
        if (sourceWidth <= 0 || sourceHeight <= 0 || targetWidth <= 0 || targetHeight <= 0
                || fx <= 0 || fy <= 0) {
            throw new IllegalArgumentException("intrinseques invalides");
        }
        double sx = (double) targetWidth / sourceWidth;
        double sy = (double) targetHeight / sourceHeight;
        return new Intrinsics(
                fx * sx, fy * sy, cx * sx, cy * sy, targetWidth, targetHeight);
    }

    static Point3 unproject(double pixelX, double pixelY, double depthM, Intrinsics k) {
        return new Point3(
                (pixelX - k.cx) * depthM / k.fx,
                (pixelY - k.cy) * depthM / k.fy,
                depthM);
    }

    /** Intersection d'un rayon de pixel avec le plan. */
    static Point3 intersectPixelWithPlane(double pixelX, double pixelY, Intrinsics k, Plane p) {
        double rx = (pixelX - k.cx) / k.fx;
        double ry = (pixelY - k.cy) / k.fy;
        double denominator = 1.0 - p.a * rx - p.b * ry;
        if (Math.abs(denominator) < 1e-9) return null;
        double z = p.c / denominator;
        if (!Double.isFinite(z) || z <= 0) return null;
        return new Point3(rx * z, ry * z, z);
    }

    /**
     * Largeur et hauteur reelles du champ de l'image, sur le plan de la table.
     * Les deux valeurs sont dans l'orientation native du capteur.
     */
    static double[] fieldSizeOnPlane(Intrinsics k, Plane p) {
        Point3 left = intersectPixelWithPlane(0.0, k.cy, k, p);
        Point3 right = intersectPixelWithPlane(k.width, k.cy, k, p);
        Point3 top = intersectPixelWithPlane(k.cx, 0.0, k, p);
        Point3 bottom = intersectPixelWithPlane(k.cx, k.height, k, p);
        if (left == null || right == null || top == null || bottom == null) return null;
        return new double[] { distance(left, right), distance(top, bottom) };
    }

    /** Aire sur le plan de table couverte par un pixel, via quatre rayons. */
    static double tablePixelArea(int x, int y, Intrinsics k, Plane p) {
        Point3 p00 = intersectPixelWithPlane(x - 0.5, y - 0.5, k, p);
        Point3 p10 = intersectPixelWithPlane(x + 0.5, y - 0.5, k, p);
        Point3 p11 = intersectPixelWithPlane(x + 0.5, y + 0.5, k, p);
        Point3 p01 = intersectPixelWithPlane(x - 0.5, y + 0.5, k, p);
        if (p00 == null || p10 == null || p11 == null || p01 == null) return 0;
        return triangleArea(p00, p10, p11) + triangleArea(p00, p11, p01);
    }

    /**
     * RANSAC deterministe, puis moindres carres sur les seuls points coherents.
     * Un premier ajustement sur tous les points n'est pas robuste : le bord de
     * l'assiette peut faire basculer le plan avant meme le rejet des aberrants.
     */
    static Plane fitPlaneRansac(
            double[] xs, double[] ys, double[] zs, int count,
            double thresholdM, int iterations, double minInlierRatio, long seed) {
        if (xs == null || ys == null || zs == null || count < 3
                || count > xs.length || count > ys.length || count > zs.length
                || thresholdM <= 0 || iterations <= 0) {
            return null;
        }

        long state = seed == 0 ? 0x6a09e667f3bcc909L : seed;
        double[] best = null;
        int bestCount = 0;
        double bestSq = Double.POSITIVE_INFINITY;

        for (int it = 0; it < iterations; it++) {
            state = next(state); int i = positiveMod(state, count);
            state = next(state); int j = positiveMod(state, count);
            state = next(state); int k = positiveMod(state, count);
            if (i == j || i == k || j == k) continue;

            double[] candidate = planeFromThree(
                    xs[i], ys[i], zs[i], xs[j], ys[j], zs[j], xs[k], ys[k], zs[k]);
            if (candidate == null) continue;
            double normal = Math.sqrt(candidate[0] * candidate[0]
                    + candidate[1] * candidate[1] + 1.0);
            int inliers = 0;
            double sq = 0;
            for (int n = 0; n < count; n++) {
                double d = Math.abs(candidate[0] * xs[n] + candidate[1] * ys[n]
                        + candidate[2] - zs[n]) / normal;
                if (d <= thresholdM) {
                    inliers++;
                    sq += d * d;
                }
            }
            if (inliers > bestCount || (inliers == bestCount && sq < bestSq)) {
                best = candidate;
                bestCount = inliers;
                bestSq = sq;
            }
        }

        int minimum = Math.max(3, (int) Math.ceil(count * minInlierRatio));
        if (best == null || bestCount < minimum) return null;

        boolean[] keep = inlierMask(xs, ys, zs, count, best, thresholdM);
        double[] refined = leastSquares(xs, ys, zs, count, keep);
        if (refined == null) return null;

        keep = inlierMask(xs, ys, zs, count, refined, thresholdM);
        int inliers = 0;
        double sq = 0;
        double normal = Math.sqrt(refined[0] * refined[0] + refined[1] * refined[1] + 1.0);
        for (int n = 0; n < count; n++) {
            if (!keep[n]) continue;
            double d = (refined[0] * xs[n] + refined[1] * ys[n] + refined[2] - zs[n]) / normal;
            sq += d * d;
            inliers++;
        }
        if (inliers < minimum) return null;
        return new Plane(refined[0], refined[1], refined[2], inliers,
                Math.sqrt(sq / inliers));
    }

    /** Nombre de cases d'une grille contenant au moins un echantillon fiable. */
    static int occupiedCells(boolean[] valid, int width, int height, int cols, int rows) {
        if (valid == null || valid.length < width * height || width <= 0 || height <= 0
                || cols <= 0 || rows <= 0) return 0;
        boolean[] occupied = new boolean[cols * rows];
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                if (!valid[y * width + x]) continue;
                int gx = Math.min(cols - 1, x * cols / width);
                int gy = Math.min(rows - 1, y * rows / height);
                occupied[gy * cols + gx] = true;
            }
        }
        int n = 0;
        for (boolean b : occupied) if (b) n++;
        return n;
    }

    /**
     * Autorise uniquement de petits trous totalement entoures de pixels controles.
     * Les grandes zones interpolees par la profondeur dense restent refusees.
     */
    static boolean[] fillSmallEnclosedHoles(
            boolean[] candidate, boolean[] trusted, int width, int height, int maxHolePixels) {
        if (candidate == null || trusted == null || candidate.length < width * height
                || trusted.length < width * height || width <= 0 || height <= 0) {
            throw new IllegalArgumentException("masque invalide");
        }
        boolean[] accepted = Arrays.copyOf(trusted, width * height);
        boolean[] seen = new boolean[width * height];
        int[] component = new int[Math.max(1, maxHolePixels + 1)];
        int[] dx = { 1, -1, 0, 0 };
        int[] dy = { 0, 0, 1, -1 };

        for (int start = 0; start < width * height; start++) {
            if (!candidate[start] || trusted[start] || seen[start]) continue;
            ArrayDeque<Integer> queue = new ArrayDeque<>();
            queue.add(start);
            seen[start] = true;
            int size = 0;
            boolean touchesBoundary = false;
            boolean touchesTrusted = false;
            boolean fullyEnclosed = true;
            boolean tooLarge = false;

            while (!queue.isEmpty()) {
                int p = queue.removeFirst();
                int x = p % width, y = p / width;
                if (size < component.length) component[size] = p;
                size++;
                if (size > maxHolePixels) tooLarge = true;
                if (x == 0 || y == 0 || x == width - 1 || y == height - 1) {
                    touchesBoundary = true;
                }
                for (int d = 0; d < 4; d++) {
                    int nx = x + dx[d], ny = y + dy[d];
                    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                    int q = ny * width + nx;
                    if (trusted[q]) {
                        touchesTrusted = true;
                    } else if (candidate[q] && !seen[q]) {
                        seen[q] = true;
                        queue.add(q);
                    } else if (!candidate[q]) {
                        // Un trou au bord de la silhouette dense n'est pas
                        // "entoure" : le remplir agrandirait artificiellement
                        // l'objet. Seules les lacunes internes sont admises.
                        fullyEnclosed = false;
                    }
                }
            }

            if (!tooLarge && size <= maxHolePixels && !touchesBoundary
                    && touchesTrusted && fullyEnclosed) {
                for (int i = 0; i < size; i++) accepted[component[i]] = true;
            }
        }
        return accepted;
    }

    /** Stabilite de quatre observations independantes de distance et de champ. */
    static boolean observationsStable(
            double[] distancesM, double[] fieldWidthsM, int count,
            double maxDistanceSpreadM, double maxRelativeFieldSpread) {
        if (count < 4 || distancesM == null || fieldWidthsM == null
                || count > distancesM.length || count > fieldWidthsM.length) return false;
        double dMin = Double.POSITIVE_INFINITY, dMax = 0;
        double fMin = Double.POSITIVE_INFINITY, fMax = 0;
        for (int i = count - 4; i < count; i++) {
            double d = distancesM[i], f = fieldWidthsM[i];
            if (!Double.isFinite(d) || !Double.isFinite(f) || d <= 0 || f <= 0) return false;
            dMin = Math.min(dMin, d); dMax = Math.max(dMax, d);
            fMin = Math.min(fMin, f); fMax = Math.max(fMax, f);
        }
        return dMax - dMin <= maxDistanceSpreadM
                && (fMax - fMin) / fMin <= maxRelativeFieldSpread;
    }

    private static long next(long state) {
        return state * 6364136223846793005L + 1442695040888963407L;
    }

    private static int positiveMod(long value, int modulus) {
        return (int) ((value & Long.MAX_VALUE) % modulus);
    }

    private static boolean[] inlierMask(
            double[] xs, double[] ys, double[] zs, int count, double[] p, double thresholdM) {
        boolean[] keep = new boolean[count];
        double normal = Math.sqrt(p[0] * p[0] + p[1] * p[1] + 1.0);
        for (int i = 0; i < count; i++) {
            double d = Math.abs(p[0] * xs[i] + p[1] * ys[i] + p[2] - zs[i]) / normal;
            keep[i] = d <= thresholdM;
        }
        return keep;
    }

    private static double[] planeFromThree(
            double x1, double y1, double z1,
            double x2, double y2, double z2,
            double x3, double y3, double z3) {
        double det = x1 * (y2 - y3) - y1 * (x2 - x3) + x2 * y3 - x3 * y2;
        if (Math.abs(det) < 1e-10) return null;
        double a = (z1 * (y2 - y3) - y1 * (z2 - z3) + z2 * y3 - z3 * y2) / det;
        double b = (x1 * (z2 - z3) - z1 * (x2 - x3) + x2 * z3 - x3 * z2) / det;
        double c = (x1 * (y2 * z3 - z2 * y3)
                - y1 * (x2 * z3 - z2 * x3) + z1 * (x2 * y3 - y2 * x3)) / det;
        if (!Double.isFinite(a) || !Double.isFinite(b) || !Double.isFinite(c)) return null;
        return new double[] { a, b, c };
    }

    private static double[] leastSquares(
            double[] xs, double[] ys, double[] zs, int count, boolean[] keep) {
        double xx = 0, xy = 0, x1 = 0, yy = 0, y1 = 0, one = 0;
        double xz = 0, yz = 0, z1 = 0;
        for (int i = 0; i < count; i++) {
            if (keep != null && !keep[i]) continue;
            double x = xs[i], y = ys[i], z = zs[i];
            xx += x * x; xy += x * y; x1 += x;
            yy += y * y; y1 += y; one += 1;
            xz += x * z; yz += y * z; z1 += z;
        }
        if (one < 3) return null;
        return solve3(
                xx, xy, x1,
                xy, yy, y1,
                x1, y1, one,
                xz, yz, z1);
    }

    private static double[] solve3(
            double m11, double m12, double m13,
            double m21, double m22, double m23,
            double m31, double m32, double m33,
            double r1, double r2, double r3) {
        double[][] m = {
            { m11, m12, m13, r1 },
            { m21, m22, m23, r2 },
            { m31, m32, m33, r3 }
        };
        for (int col = 0; col < 3; col++) {
            int pivot = col;
            for (int row = col + 1; row < 3; row++) {
                if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
            }
            if (Math.abs(m[pivot][col]) < 1e-12) return null;
            double[] tmp = m[col]; m[col] = m[pivot]; m[pivot] = tmp;
            for (int row = 0; row < 3; row++) {
                if (row == col) continue;
                double factor = m[row][col] / m[col][col];
                for (int k = col; k < 4; k++) m[row][k] -= factor * m[col][k];
            }
        }
        return new double[] {
            m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]
        };
    }

    private static double distance(Point3 p, Point3 q) {
        double dx = p.x - q.x, dy = p.y - q.y, dz = p.z - q.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    private static double triangleArea(Point3 a, Point3 b, Point3 c) {
        double ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
        double vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
        double cx = uy * vz - uz * vy;
        double cy = uz * vx - ux * vz;
        double cz = ux * vy - uy * vx;
        return 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
    }
}
