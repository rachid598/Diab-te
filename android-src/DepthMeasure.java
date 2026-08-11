package io.github.rachid598.glucovision;

import android.media.Image;

import com.google.ar.core.CameraIntrinsics;
import com.google.ar.core.Frame;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;

/**
 * Mesure fail-closed d'une image ARCore.
 *
 * L'echelle et le volume sont volontairement separes. L'echelle repose sur un
 * plan de table robuste construit avec Raw Depth + confiance. Le volume reste
 * experimental : la profondeur dense n'est jamais crue seule, et n'est integree
 * que la ou elle est controlee par la profondeur brute.
 */
final class DepthMeasure {
    static final int MIN_CONFIDENCE = 128;
    static final double MIN_DEPTH_M = 0.50;
    static final double MAX_DEPTH_M = 0.85;

    private static final double CENTER_FRACTION = 0.58;
    private static final double RING_FRACTION = 0.96;
    private static final double PLANE_INLIER_M = 0.008;
    private static final double MAX_PLANE_RMS_M = 0.008;
    private static final double MIN_PLANE_INLIER_RATIO = 0.62;
    private static final int RANSAC_ITERATIONS = 160;
    private static final int GRID_COLS = 8;
    private static final int GRID_ROWS = 6;
    private static final int MIN_GRID_CELLS = 18;
    private static final double MAX_TILT_DEG = 30.0;

    private static final double MIN_HEIGHT_M = 0.004;
    private static final double MAX_HEIGHT_M = 0.18;
    private static final double RAW_DENSE_ABS_M = 0.025;
    private static final double RAW_DENSE_REL = 0.05;
    private static final int MAX_LOCAL_HOLE_PIXELS = 4;
    private static final double MIN_DENSE_CONTROL_RATIO = 0.65;
    private static final double MIN_AREA_CM2 = 20.0;
    private static final double MAX_AREA_CM2 = 1800.0;
    private static final double MIN_VOLUME_CM3 = 10.0;
    private static final double MAX_VOLUME_CM3 = 2500.0;

    private DepthMeasure() {}

    static final class Result {
        boolean scaleOk;
        boolean ok; // volume experimental disponible
        double volumeCm3;
        double areaCm2;
        double heightMaxCm;
        double heightMeanCm;
        double distanceCm;
        double fieldWidthCm;
        double fieldHeightCm;
        double cmPerPixel;
        int samples;
        int rawPixels;
        int confidentPixels;
        int planePoints;
        int planeInliers;
        int occupiedCells;
        int denseCandidates;
        int denseControlled;
        int observations;
        int sourceImageWidthPx;
        int sourceImageHeightPx;
        double planeRmsCm;
        double tiltDeg;
        double planeA;
        double planeB;
        double coverage;
        double parallaxCm;
        long depthTimestamp;
        boolean fresh;
        String note = "";
        String diag = "";

        /*
         * La photo JPEG est tournee pour l'affichage. Si elle pivote de 90/270
         * degres, sa largeur correspond a la hauteur native du capteur.
         */
        void orientForPhoto(int rotationDegrees, int outputWidthPx, int outputHeightPx) {
            int normalized = ((rotationDegrees % 360) + 360) % 360;
            if (normalized == 90 || normalized == 270) {
                double tmp = fieldWidthCm;
                fieldWidthCm = fieldHeightCm;
                fieldHeightCm = tmp;
            }
            cmPerPixel = scaleOk && outputWidthPx > 0 ? fieldWidthCm / outputWidthPx : 0;
        }
    }

    static Result measure(Frame frame, Image rawDepth, Image confidence, Image denseDepth) {
        Result r = new Result();
        if (frame == null || rawDepth == null || confidence == null) {
            r.note = "Profondeur brute et carte de confiance indispensables.";
            return r;
        }
        r.depthTimestamp = rawDepth.getTimestamp();
        if (r.depthTimestamp <= 0 || r.depthTimestamp != frame.getTimestamp()) {
            r.note = "Carte de profondeur ancienne : continue a balayer.";
            return r;
        }
        if (confidence.getTimestamp() != r.depthTimestamp
                || confidence.getWidth() != rawDepth.getWidth()
                || confidence.getHeight() != rawDepth.getHeight()) {
            r.note = "Carte de confiance desynchronisee.";
            return r;
        }

        int width = rawDepth.getWidth();
        int height = rawDepth.getHeight();
        if (width < 16 || height < 12) {
            r.note = "Carte de profondeur trop petite.";
            return r;
        }

        SamplePlane raw = SamplePlane.of(rawDepth);
        SamplePlane conf = SamplePlane.of(confidence);
        if (raw == null || conf == null) {
            r.note = "Plans de profondeur illisibles.";
            return r;
        }

        CameraIntrinsics textureIntrinsics = frame.getCamera().getTextureIntrinsics();
        DepthGeometry.Intrinsics depthK = scaled(textureIntrinsics, width, height);
        if (depthK == null) {
            r.note = "Intrinseques de profondeur indisponibles.";
            return r;
        }

        int centerX0 = fractionStart(width, CENTER_FRACTION);
        int centerX1 = width - centerX0;
        int centerY0 = fractionStart(height, CENTER_FRACTION);
        int centerY1 = height - centerY0;
        int ringX0 = fractionStart(width, RING_FRACTION);
        int ringX1 = width - ringX0;
        int ringY0 = fractionStart(height, RING_FRACTION);
        int ringY1 = height - ringY0;

        int capacity = Math.max(1, (ringX1 - ringX0) * (ringY1 - ringY0));
        double[] xs = new double[capacity];
        double[] ys = new double[capacity];
        double[] zs = new double[capacity];
        boolean[] spatialMask = new boolean[width * height];
        int[] sidePoints = new int[4]; // haut, droite, bas, gauche
        int count = 0;

        for (int y = ringY0; y < ringY1; y++) {
            for (int x = ringX0; x < ringX1; x++) {
                if (x >= centerX0 && x < centerX1 && y >= centerY0 && y < centerY1) continue;
                int mm = depthMm(raw, x, y);
                if (mm <= 0) continue;
                r.rawPixels++;
                int confidenceValue = unsignedByte(conf, x, y);
                if (confidenceValue < MIN_CONFIDENCE) continue;
                r.confidentPixels++;
                double z = mm / 1000.0;
                if (z < MIN_DEPTH_M || z > MAX_DEPTH_M) continue;
                DepthGeometry.Point3 p = DepthGeometry.unproject(x, y, z, depthK);
                xs[count] = p.x;
                ys[count] = p.y;
                zs[count] = p.z;
                spatialMask[y * width + x] = true;
                if (y < centerY0) sidePoints[0]++;
                else if (y >= centerY1) sidePoints[2]++;
                else if (x >= centerX1) sidePoints[1]++;
                else sidePoints[3]++;
                count++;
            }
        }
        r.planePoints = count;
        r.occupiedCells = DepthGeometry.occupiedCells(
                spatialMask, width, height, GRID_COLS, GRID_ROWS);
        int ringPixels = capacity - (centerX1 - centerX0) * (centerY1 - centerY0);
        r.coverage = ringPixels > 0 ? (double) count / ringPixels : 0;
        int minimumPoints = Math.max(80, Math.min(400, ringPixels / 100));
        boolean allSidesCovered = true;
        for (int side : sidePoints) allSidesCovered &= side >= 8;
        if (count < minimumPoints || r.occupiedCells < MIN_GRID_CELLS || !allSidesCovered) {
            r.note = count == 0
                    ? "Aucun point fiable sur la table : ajoute de la lumiere et balaye lentement."
                    : "Table insuffisamment couverte (" + count + " points, "
                      + r.occupiedCells + "/" + (GRID_COLS * GRID_ROWS)
                      + " zones, table requise sur les quatre cotes).";
            r.diag = diagnostic(r, width, height);
            return r;
        }

        DepthGeometry.Plane plane = DepthGeometry.fitPlaneRansac(
                xs, ys, zs, count, PLANE_INLIER_M, RANSAC_ITERATIONS,
                MIN_PLANE_INLIER_RATIO, 0x474c55434f564953L);
        if (plane == null) {
            r.note = "Plan de table indetermine : laisse davantage de table visible autour de l'assiette.";
            r.diag = diagnostic(r, width, height);
            return r;
        }
        r.planeInliers = plane.inliers;
        r.planeRmsCm = plane.rmsM * 100.0;
        r.tiltDeg = plane.tiltDeg();
        r.planeA = plane.a;
        r.planeB = plane.b;
        r.distanceCm = plane.c * 100.0;

        if (plane.rmsM > MAX_PLANE_RMS_M) {
            r.note = "Table trop irreguliere (ecart " + oneDecimal(r.planeRmsCm) + " cm).";
            r.diag = diagnostic(r, width, height);
            return r;
        }
        if (r.tiltDeg > MAX_TILT_DEG) {
            r.note = "Telephone trop incline (" + Math.round(r.tiltDeg) + " degres).";
            r.diag = diagnostic(r, width, height);
            return r;
        }
        if (plane.c < MIN_DEPTH_M || plane.c > MAX_DEPTH_M) {
            r.note = "Place le telephone entre 50 et 85 cm de la table (mesure : "
                    + Math.round(r.distanceCm) + " cm).";
            r.diag = diagnostic(r, width, height);
            return r;
        }

        CameraIntrinsics imageIntrinsics = frame.getCamera().getImageIntrinsics();
        int[] imageDim = imageIntrinsics.getImageDimensions();
        r.sourceImageWidthPx = imageDim[0];
        r.sourceImageHeightPx = imageDim[1];
        DepthGeometry.Intrinsics imageK = scaled(imageIntrinsics, imageDim[0], imageDim[1]);
        double[] field = imageK == null ? null : DepthGeometry.fieldSizeOnPlane(imageK, plane);
        if (field == null || field[0] <= 0 || field[1] <= 0
                || field[0] > 2.0 || field[1] > 2.0) {
            r.note = "Champ reel de la photo incoherent.";
            r.diag = diagnostic(r, width, height);
            return r;
        }

        r.scaleOk = true;
        r.fieldWidthCm = field[0] * 100.0;
        r.fieldHeightCm = field[1] * 100.0;
        r.cmPerPixel = imageDim[0] > 0 ? r.fieldWidthCm / imageDim[0] : 0;
        r.note = "Echelle mesuree. Volume experimental indisponible.";

        if (denseDepth != null
                && denseDepth.getTimestamp() == frame.getTimestamp()
                && denseDepth.getWidth() == width && denseDepth.getHeight() == height) {
            integrateControlledDense(
                    r, raw, conf, SamplePlane.of(denseDepth), depthK, plane,
                    centerX0, centerX1, centerY0, centerY1);
        }
        r.diag = diagnostic(r, width, height);
        return r;
    }

    static String rawCenter(Image rawDepth, Image confidence) {
        if (rawDepth == null || confidence == null) return "-";
        try {
            SamplePlane raw = SamplePlane.of(rawDepth);
            SamplePlane conf = SamplePlane.of(confidence);
            if (raw == null || conf == null) return "-";
            int x = rawDepth.getWidth() / 2;
            int y = rawDepth.getHeight() / 2;
            int mm = depthMm(raw, x, y);
            int c = unsignedByte(conf, x, y);
            return (mm > 0 ? Math.round(mm / 10.0) + " cm" : "vide")
                    + " (conf " + c + "/255)";
        } catch (RuntimeException e) {
            return "-";
        }
    }

    private static void integrateControlledDense(
            Result r, SamplePlane raw, SamplePlane conf, SamplePlane dense,
            DepthGeometry.Intrinsics k, DepthGeometry.Plane plane,
            int x0, int x1, int y0, int y1) {
        if (dense == null) return;
        int width = x1 - x0;
        int height = y1 - y0;
        boolean[] candidate = new boolean[width * height];
        boolean[] trusted = new boolean[width * height];
        double[] heights = new double[width * height];

        for (int y = y0; y < y1; y++) {
            for (int x = x0; x < x1; x++) {
                int local = (y - y0) * width + (x - x0);
                int denseMm = depthMm(dense, x, y);
                if (denseMm <= 0) continue;
                double denseZ = denseMm / 1000.0;
                if (denseZ < MIN_DEPTH_M - MAX_HEIGHT_M || denseZ > MAX_DEPTH_M) continue;
                DepthGeometry.Point3 densePoint = DepthGeometry.unproject(x, y, denseZ, k);
                double denseHeight = plane.heightAbove(densePoint.x, densePoint.y, densePoint.z);
                if (denseHeight < MIN_HEIGHT_M || denseHeight > MAX_HEIGHT_M) continue;
                candidate[local] = true;
                heights[local] = denseHeight;
                r.denseCandidates++;

                int rawMm = depthMm(raw, x, y);
                if (rawMm <= 0 || unsignedByte(conf, x, y) < MIN_CONFIDENCE) continue;
                double rawZ = rawMm / 1000.0;
                double tolerance = Math.max(RAW_DENSE_ABS_M, rawZ * RAW_DENSE_REL);
                if (Math.abs(rawZ - denseZ) > tolerance) continue;
                DepthGeometry.Point3 rawPoint = DepthGeometry.unproject(x, y, rawZ, k);
                double rawHeight = plane.heightAbove(rawPoint.x, rawPoint.y, rawPoint.z);
                if (rawHeight < MIN_HEIGHT_M || rawHeight > MAX_HEIGHT_M) continue;
                trusted[local] = true;
                r.denseControlled++;
            }
        }

        if (r.denseCandidates < 80 || r.denseControlled < 60
                || (double) r.denseControlled / r.denseCandidates < MIN_DENSE_CONTROL_RATIO) {
            r.note = "Echelle mesuree. Volume refuse : profondeur dense insuffisamment controlee par le brut.";
            return;
        }

        boolean[] accepted = DepthGeometry.fillSmallEnclosedHoles(
                candidate, trusted, width, height, MAX_LOCAL_HOLE_PIXELS);
        double areaM2 = 0;
        double volumeM3 = 0;
        double[] acceptedHeights = new double[r.denseCandidates];
        int acceptedCount = 0;
        for (int y = y0; y < y1; y++) {
            for (int x = x0; x < x1; x++) {
                int local = (y - y0) * width + (x - x0);
                if (!accepted[local] || !candidate[local]) continue;
                double pixelArea = DepthGeometry.tablePixelArea(x, y, k, plane);
                if (!Double.isFinite(pixelArea) || pixelArea <= 0) continue;
                double h = heights[local];
                areaM2 += pixelArea;
                volumeM3 += pixelArea * h;
                acceptedHeights[acceptedCount++] = h;
            }
        }

        if (acceptedCount < 60) {
            r.note = "Echelle mesuree. Volume refuse : trop peu de surface directement controlee.";
            return;
        }
        double areaCm2 = areaM2 * 1e4;
        double volumeCm3 = volumeM3 * 1e6;
        if (areaCm2 < MIN_AREA_CM2 || areaCm2 > MAX_AREA_CM2
                || volumeCm3 < MIN_VOLUME_CM3 || volumeCm3 > MAX_VOLUME_CM3) {
            r.note = "Echelle mesuree. Volume experimental invraisemblable, donc refuse.";
            return;
        }

        Arrays.sort(acceptedHeights, 0, acceptedCount);
        int p95 = Math.min(acceptedCount - 1, (int) Math.floor((acceptedCount - 1) * 0.95));
        r.ok = true;
        r.samples = acceptedCount;
        r.areaCm2 = areaCm2;
        r.volumeCm3 = volumeCm3;
        r.heightMeanCm = areaM2 > 0 ? (volumeM3 / areaM2) * 100.0 : 0;
        r.heightMaxCm = acceptedHeights[p95] * 100.0;
        r.note = "Echelle mesuree. Volume experimental affiche seulement, jamais utilise pour les glucides.";
    }

    private static DepthGeometry.Intrinsics scaled(CameraIntrinsics intrinsics, int width, int height) {
        if (intrinsics == null) return null;
        int[] source = intrinsics.getImageDimensions();
        float[] focal = intrinsics.getFocalLength();
        float[] principal = intrinsics.getPrincipalPoint();
        if (source == null || focal == null || principal == null
                || source.length < 2 || focal.length < 2 || principal.length < 2) return null;
        try {
            return DepthGeometry.scaleIntrinsics(
                    focal[0], focal[1], principal[0], principal[1],
                    source[0], source[1], width, height);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static int fractionStart(int size, double fraction) {
        return Math.max(0, Math.min(size / 2, (int) Math.floor(size * (1.0 - fraction) / 2.0)));
    }

    private static int depthMm(SamplePlane plane, int x, int y) {
        if (plane == null) return 0;
        int offset = plane.baseOffset + y * plane.rowStride + x * plane.pixelStride;
        if (offset < plane.baseOffset || offset + 1 >= plane.buffer.limit()) return 0;
        return Short.toUnsignedInt(plane.buffer.getShort(offset));
    }

    private static int unsignedByte(SamplePlane plane, int x, int y) {
        if (plane == null) return 0;
        int offset = plane.baseOffset + y * plane.rowStride + x * plane.pixelStride;
        if (offset < plane.baseOffset || offset >= plane.buffer.limit()) return 0;
        return plane.buffer.get(offset) & 0xff;
    }

    private static String diagnostic(Result r, int width, int height) {
        return "raw " + width + "x" + height
                + " px " + r.rawPixels + "/" + r.confidentPixels
                + " plan " + r.planeInliers + "/" + r.planePoints
                + " zones " + r.occupiedCells + "/" + (GRID_COLS * GRID_ROWS)
                + " rms " + oneDecimal(r.planeRmsCm) + "cm"
                + " dist " + Math.round(r.distanceCm) + "cm"
                + " incl " + Math.round(r.tiltDeg) + "deg"
                + " dense " + r.denseControlled + "/" + r.denseCandidates;
    }

    private static String oneDecimal(double value) {
        return String.format(java.util.Locale.US, "%.1f", value);
    }

    private static final class SamplePlane {
        final ByteBuffer buffer;
        final int baseOffset;
        final int rowStride;
        final int pixelStride;

        private SamplePlane(ByteBuffer buffer, int baseOffset, int rowStride, int pixelStride) {
            this.buffer = buffer;
            this.baseOffset = baseOffset;
            this.rowStride = rowStride;
            this.pixelStride = pixelStride;
        }

        static SamplePlane of(Image image) {
            if (image == null || image.getPlanes() == null || image.getPlanes().length == 0) return null;
            Image.Plane p = image.getPlanes()[0];
            if (p == null || p.getBuffer() == null || p.getRowStride() <= 0 || p.getPixelStride() <= 0) {
                return null;
            }
            ByteBuffer view = p.getBuffer().duplicate().order(ByteOrder.LITTLE_ENDIAN);
            return new SamplePlane(view, view.position(), p.getRowStride(), p.getPixelStride());
        }
    }
}
