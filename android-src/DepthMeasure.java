package io.github.rachid598.glucovision;

import android.media.Image;

import com.google.ar.core.CameraIntrinsics;
import com.google.ar.core.Frame;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;

/**
 * Transforme une carte de profondeur ARCore en mesures exploitables.
 *
 * Le plan d'appui est déduit de la carte de profondeur ELLE-MÊME, et non de la
 * détection de plans d'ARCore. C'est ce qui rend la mesure immédiate et fiable :
 *
 * - la détection de plans exige de promener le téléphone jusqu'à ce qu'ARCore
 *   accroche une surface, ce qui prend un temps indéterminé sur une table unie,
 *   sans texture à suivre ;
 * - et quand elle finit par accrocher quelque chose, rien ne garantit que c'est
 *   la table : le SOL est souvent détecté en premier. Toutes les hauteurs sont
 *   alors calculées par rapport à un plan situé 75 cm plus bas, et chaque point
 *   se retrouve rejeté comme « trop haut ». C'est exactement ce qui produisait
 *   un décompte de 0 point malgré une carte de profondeur valide.
 *
 * On ajuste donc un plan sur la COURONNE de l'image — l'anneau autour du centre,
 * qui montre la table à côté de l'assiette — puis on mesure le relief du centre
 * par rapport à ce plan. Aucune attente, et le plan est celui qu'on regarde.
 */
class DepthMeasure {

    /** Résultat brut, en unités affichables (cm, cm², cm³). */
    static class Result {
        boolean ok;
        double volumeCm3;
        double areaCm2;
        double heightMaxCm;
        double heightMeanCm;
        double distanceCm;
        double cmPerPixel;      // pour l'image JPEG rendue, à la distance médiane
        int samples;
        String note = "";

        /* Compteurs de diagnostic. Un simple « 0 point » ne dit pas si la carte
           de profondeur était vide, si tout était hors de portée, ou si le plan
           d'appui était faux — trois pannes différentes qui demandent trois
           corrections différentes. */
        int depthPixels;        // pixels de profondeur non nuls
        int inRange;            // ... et à une distance plausible
        int onPlane;            // ... utilisés pour ajuster le plan d'appui
    }

    private static final float MIN_HEIGHT_M = 0.004f;
    private static final float MAX_HEIGHT_M = 0.30f;

    /* Un repas se photographie de près. Large, car mieux vaut mesurer un plat
       tenu à 80 cm que refuser tout net. */
    private static final float MAX_DEPTH_M = 2.0f;
    private static final float MIN_DEPTH_M = 0.08f;

    private static final float CENTER_FRACTION = 0.55f;   // zone mesurée
    private static final float RING_FRACTION = 0.92f;     // zone servant au plan d'appui

    /* Seuil bas : une carte de profondeur est trouée, et exiger beaucoup de
       points revenait à refuser des mesures parfaitement exploitables. */
    private static final int MIN_SAMPLES = 60;
    private static final int MIN_PLANE_POINTS = 80;

    static Result measure(Frame frame, Image depth, int photoWidthPx) {
        Result r = new Result();

        int dw = depth.getWidth();
        int dh = depth.getHeight();
        Image.Plane p0 = depth.getPlanes()[0];
        ByteBuffer raw = p0.getBuffer().order(ByteOrder.nativeOrder());
        int rowStride = p0.getRowStride();

        /* Les intrinsèques décrivent l'image caméra pleine résolution ; la carte
           de profondeur est beaucoup plus petite. Sans cette mise à l'échelle,
           la reprojection est fausse d'un facteur 5 à 10. */
        CameraIntrinsics intr = frame.getCamera().getTextureIntrinsics();
        int[] dim = intr.getImageDimensions();
        float[] focal = intr.getFocalLength();
        float[] principal = intr.getPrincipalPoint();
        if (dim[0] <= 0 || dim[1] <= 0 || focal[0] <= 0 || focal[1] <= 0) {
            r.note = "Paramètres optiques indisponibles.";
            return r;
        }
        float fx = focal[0] * dw / dim[0];
        float fy = focal[1] * dh / dim[1];
        float cx = principal[0] * dw / dim[0];
        float cy = principal[1] * dh / dim[1];

        int cx0 = (int) (dw * (1 - CENTER_FRACTION) / 2), cx1 = dw - cx0;
        int cy0 = (int) (dh * (1 - CENTER_FRACTION) / 2), cy1 = dh - cy0;
        int rx0 = (int) (dw * (1 - RING_FRACTION) / 2), rx1 = dw - rx0;
        int ry0 = (int) (dh * (1 - RING_FRACTION) / 2), ry1 = dh - ry0;

        /* Ajustement du plan d'appui : z = a·x + b·y + c, par moindres carrés sur
           la couronne. Un plan incliné est parfaitement admis — c'est le cas dès
           que le téléphone n'est pas rigoureusement à la verticale. */
        double s11 = 0, s12 = 0, s13 = 0, s22 = 0, s23 = 0, s33 = 0, sz = 0, sxz = 0, syz = 0;
        int planeCount = 0;

        for (int y = ry0; y < ry1; y++) {
            for (int x = rx0; x < rx1; x++) {
                if (x >= cx0 && x < cx1 && y >= cy0 && y < cy1) continue;   // centre = assiette
                float z = depthAt(raw, rowStride, x, y);
                if (z <= 0) continue;
                r.depthPixels++;
                if (z < MIN_DEPTH_M || z > MAX_DEPTH_M) continue;
                r.inRange++;
                double px = (x - cx) * z / fx;
                double py = (y - cy) * z / fy;
                s11 += px * px; s12 += px * py; s13 += px;
                s22 += py * py; s23 += py; s33 += 1;
                sz += z; sxz += px * z; syz += py * z;
                planeCount++;
            }
        }
        r.onPlane = planeCount;

        if (planeCount < MIN_PLANE_POINTS) {
            r.note = r.depthPixels == 0
                ? "La carte de profondeur est vide : recule un peu et fais un léger mouvement latéral."
                : "Pas assez de table visible autour de l'assiette (" + planeCount + " points) : recule un peu.";
            return r;
        }

        double[] plane = solve3(s11, s12, s13, s12, s22, s23, s13, s23, s33, sxz, syz, sz);
        if (plane == null) {
            r.note = "Plan d'appui indéterminé : recule un peu pour voir plus de table.";
            return r;
        }
        double a = plane[0], b = plane[1], c = plane[2];
        double nrm = Math.sqrt(a * a + b * b + 1);

        double volume = 0, area = 0, heightSum = 0, maxHeight = 0;
        int count = 0;
        float[] depths = new float[(cx1 - cx0) * (cy1 - cy0)];
        int depthCount = 0;

        for (int y = cy0; y < cy1; y++) {
            for (int x = cx0; x < cx1; x++) {
                float z = depthAt(raw, rowStride, x, y);
                if (z <= 0) continue;
                r.depthPixels++;
                if (z < MIN_DEPTH_M || z > MAX_DEPTH_M) continue;
                r.inRange++;

                double px = (x - cx) * z / fx;
                double py = (y - cy) * z / fy;
                double zPlane = a * px + b * py + c;

                /* Hauteur = distance perpendiculaire au plan. Un point PLUS PRÈS
                   de l'objectif que la table est au-dessus d'elle : d'où la
                   soustraction dans ce sens. */
                double h = (zPlane - z) / nrm;
                if (h < MIN_HEIGHT_M || h > MAX_HEIGHT_M) continue;

                /* Surface couverte par ce pixel, ramenée au plan de la table :
                   un plat vu de biais serait sinon sous-compté. */
                double pixelArea = (z / fx) * (z / fy);
                double len = Math.sqrt(px * px + py * py + z * z);
                double cos = len > 0 ? Math.abs((-a * px - b * py + z) / (nrm * len)) : 1;
                if (cos < 0.10) continue;
                double flatArea = pixelArea / cos;

                volume += h * flatArea;
                area += flatArea;
                heightSum += h;
                if (h > maxHeight) maxHeight = h;
                depths[depthCount++] = z;
                count++;
            }
        }

        if (count < MIN_SAMPLES) {
            r.samples = count;
            r.note = "Aucun relief détecté au centre (" + count + " points sur " + r.inRange +
                     " mesurés) : centre bien l'assiette dans l'image.";
            return r;
        }

        float median = median(depths, depthCount);
        r.ok = true;
        r.samples = count;
        r.volumeCm3 = volume * 1e6;
        r.areaCm2 = area * 1e4;
        r.heightMaxCm = maxHeight * 100;
        r.heightMeanCm = (heightSum / count) * 100;
        r.distanceCm = median * 100;
        float fxPhoto = focal[0] * ((float) photoWidthPx / dim[0]);
        r.cmPerPixel = fxPhoto > 0 ? (median / fxPhoto) * 100 : 0;
        return r;
    }

    /**
     * Profondeur en mètres, ou 0 si le pixel n'a pas de mesure.
     *
     * Aucun masquage de bits : contrairement au format DEPTH16 d'Android, où les
     * trois bits de poids fort portent une confiance, l'image rendue par
     * acquireDepthImage16Bits() d'ARCore contient la distance en millimètres sur
     * les seize bits. Masquer sur treize bits plafonnerait la mesure à 8,19 m et
     * corromprait toute valeur au-delà.
     */
    private static float depthAt(ByteBuffer raw, int rowStride, int x, int y) {
        int offset = y * rowStride + x * 2;
        if (offset < 0 || offset + 1 >= raw.limit()) return 0;
        int mm = (raw.get(offset) & 0xFF) | ((raw.get(offset + 1) & 0xFF) << 8);
        return mm <= 0 ? 0 : mm / 1000f;
    }

    /** Résolution d'un système 3×3 symétrique par élimination de Gauss. */
    private static double[] solve3(double m11, double m12, double m13,
                                   double m21, double m22, double m23,
                                   double m31, double m32, double m33,
                                   double r1, double r2, double r3) {
        double[][] m = { { m11, m12, m13, r1 }, { m21, m22, m23, r2 }, { m31, m32, m33, r3 } };
        for (int col = 0; col < 3; col++) {
            int pivot = col;
            for (int row = col + 1; row < 3; row++) {
                if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
            }
            if (Math.abs(m[pivot][col]) < 1e-9) return null;
            double[] tmp = m[col]; m[col] = m[pivot]; m[pivot] = tmp;
            for (int row = 0; row < 3; row++) {
                if (row == col) continue;
                double f = m[row][col] / m[col][col];
                for (int k = col; k < 4; k++) m[row][k] -= f * m[col][k];
            }
        }
        return new double[] { m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2] };
    }

    private static float median(float[] values, int count) {
        float[] copy = Arrays.copyOf(values, count);
        Arrays.sort(copy);
        return copy[count / 2];
    }
}
