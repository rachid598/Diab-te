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
 * détection de plans d'ARCore : sur une table unie celle-ci met un temps
 * indéterminé à accrocher, et ce qu'elle accroche est souvent le SOL, ce qui
 * décale toutes les hauteurs de la hauteur de la table. On ajuste donc un plan
 * sur la COURONNE de l'image — l'anneau de table autour de l'assiette — puis on
 * mesure le relief du centre par rapport à ce plan.
 *
 * Ce fichier refuse plus qu'il n'accepte, et c'est délibéré. La documentation
 * d'ARCore situe la plage précise entre 0,5 m et 5 m : plus près, la carte de
 * profondeur devient franchement fausse sans jamais le signaler. Un volume
 * absurde présenté comme une mesure serait pire que pas de mesure du tout, parce
 * qu'il est ensuite transmis au modèle comme une donnée physique fiable.
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
        double cmPerPixel;
        int samples;
        String note = "";

        /* Compteurs de diagnostic. « 0 point » ne dit pas si la carte était
           vide, si tout était hors de portée, ou si le plan d'appui était faux —
           trois pannes qui demandent trois corrections différentes. */
        int depthPixels;
        int inRange;
        int onPlane;
        double planeRmsCm;      // planéité de la couronne : le juge du plan d'appui
        double tiltDeg;         // inclinaison du téléphone par rapport à la table
        String diag = "";       // résumé technique, affiché en cas de refus
    }

    /* Resume technique. « champ » est la largeur reelle couverte par l'image a la
       distance mesuree : c'est le seul nombre qui permette de trancher entre une
       distance fausse et une focale fausse, puisqu'on peut le comparer a ce que
       montre l'ecran. Si l'ecran cadre 35 cm de table et que le champ annonce
       120 cm, ce sont les intrinseques qui mentent ; s'il annonce 35 cm alors
       que la distance dit 1 m, c'est la profondeur. */
    private static String diag(Result r, int dw, int dh, float fx, float fy) {
        double fovCm = fx > 0 ? r.distanceCm * dw / fx : 0;
        return "carte " + dw + "x" + dh + " f=" + Math.round(fx) + "/" + Math.round(fy) +
               " dist " + Math.round(r.distanceCm) + "cm champ " + Math.round(fovCm) + "cm" +
               " px " + r.depthPixels + " plan " + r.onPlane +
               " ecart " + String.format("%.1f", r.planeRmsCm) + "cm" +
               " incl " + Math.round(r.tiltDeg) + "deg";
    }

    private static final float MIN_HEIGHT_M = 0.004f;
    private static final float MAX_HEIGHT_M = 0.22f;

    /* Plage utile documentée par ARCore : 0,5 à 5 m. En dessous de 35 cm la
       carte est inexploitable, et c'est précisément là qu'on tenait le téléphone
       en croyant bien faire. */
    private static final float MIN_DEPTH_M = 0.35f;
    private static final float MAX_DEPTH_M = 2.5f;
    private static final float BEST_DEPTH_MIN_M = 0.45f;

    private static final float CENTER_FRACTION = 0.50f;
    private static final float RING_FRACTION = 0.94f;

    private static final int MIN_SAMPLES = 60;
    private static final int MIN_PLANE_POINTS = 150;

    /* Une table est plane. Si l'ajustement laisse plus de 1,2 cm d'écart-type,
       c'est que la couronne ne montre pas une table : assiette débordante, objets
       autour, ou carte de profondeur trop bruitée pour être exploitée. */
    private static final double MAX_PLANE_RMS_M = 0.012;
    private static final double OUTLIER_M = 0.02;

    /* La méthode intègre une CARTE D'ALTITUDE : elle suppose un point de mesure
       par unité de surface de table, donc une vue de dessus. Prise de biais, la
       face verticale d'un objet occupe beaucoup de pixels dont la surface au sol
       est minuscule ; la correction 1/cos les fait alors exploser et le volume
       avec eux. C'est ce qui donnait 3638 cm³ pour une brique de lait debout,
       photographiée de trois quarts.

       Deux garde-fous : l'inclinaison globale du téléphone, et le rejet des
       pixels rasants — ceux-là décrivent des flancs, pas une épaisseur. */
    private static final double MAX_TILT_DEG = 35;
    private static final double MIN_COS = 0.5;

    /* Bornes de vraisemblance d'un repas. Ce sont elles qui auraient arrêté les
       « 5500 cm³ » avant qu'ils n'atteignent l'écran. */
    private static final double MIN_AREA_CM2 = 30, MAX_AREA_CM2 = 1800;
    private static final double MIN_VOLUME_CM3 = 15, MAX_VOLUME_CM3 = 2500;

    static Result measure(Frame frame, Image depth, int photoWidthPx) {
        Result r = new Result();

        int dw = depth.getWidth();
        int dh = depth.getHeight();
        Image.Plane p0 = depth.getPlanes()[0];
        ByteBuffer raw = p0.getBuffer().order(ByteOrder.nativeOrder());
        int rowStride = p0.getRowStride();

        /* getImageIntrinsics et NON getTextureIntrinsics. Les premières décrivent
           l'image CPU de la caméra, à laquelle la carte de profondeur est
           alignée ; les secondes décrivent la texture GPU, typiquement en 16:9
           quand l'image CPU et la profondeur sont en 4:3. Les utiliser donnait
           une distance focale et un rapport d'aspect faux, donc des surfaces
           gonflées d'un facteur voisin de 2,5 — d'où les 5118 cm² annoncés pour
           une assiette, et le volume absurde qui en découlait. */
        CameraIntrinsics intr = frame.getCamera().getImageIntrinsics();
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

        // ---- Couronne : les points qui serviront de table ----
        int cap = (rx1 - rx0) * (ry1 - ry0);
        double[] px = new double[cap], py = new double[cap], pz = new double[cap];
        int n = 0;
        for (int y = ry0; y < ry1; y++) {
            for (int x = rx0; x < rx1; x++) {
                if (x >= cx0 && x < cx1 && y >= cy0 && y < cy1) continue;
                float z = depthAt(raw, rowStride, x, y);
                if (z <= 0) continue;
                r.depthPixels++;
                if (z < MIN_DEPTH_M || z > MAX_DEPTH_M) continue;
                r.inRange++;
                px[n] = (x - cx) * z / fx;
                py[n] = (y - cy) * z / fy;
                pz[n] = z;
                n++;
            }
        }
        r.onPlane = n;
        if (n > 0) {
            float[] ringDepths = new float[n];
            for (int i = 0; i < n; i++) ringDepths[i] = (float) pz[i];
            r.distanceCm = median(ringDepths, n) * 100;
        }

        if (n < MIN_PLANE_POINTS) {
            r.note = r.depthPixels == 0
                ? "Aucune profondeur mesurée : éloigne-toi à 50-60 cm et fais un léger mouvement latéral."
                : "Table peu visible autour de l'assiette (" + n + " points) : recule à 50-60 cm.";
            r.diag = diag(r, dw, dh, fx, fy);
            return r;
        }

        /* Ajustement en deux temps : un premier plan sur tous les points, puis un
           second sur les seuls points qui en sont proches. Sans cette reprise, un
           bord d'assiette ou un verre attrapé par la couronne bascule le plan
           entier — et toutes les hauteurs avec lui. */
        double[] plane = fit(px, py, pz, n, null);
        if (plane == null) {
            r.note = "Plan d'appui indéterminé : recule pour voir plus de table.";
            return r;
        }
        boolean[] keep = new boolean[n];
        int kept = 0;
        double nrm = Math.sqrt(plane[0] * plane[0] + plane[1] * plane[1] + 1);
        for (int i = 0; i < n; i++) {
            double d = Math.abs(plane[0] * px[i] + plane[1] * py[i] + plane[2] - pz[i]) / nrm;
            keep[i] = d < OUTLIER_M;
            if (keep[i]) kept++;
        }
        if (kept >= MIN_PLANE_POINTS) {
            double[] refined = fit(px, py, pz, n, keep);
            if (refined != null) plane = refined;
        }

        double a = plane[0], b = plane[1], c = plane[2];
        nrm = Math.sqrt(a * a + b * b + 1);

        double sq = 0; int used = 0;
        for (int i = 0; i < n; i++) {
            if (!keep[i]) continue;
            double d = (a * px[i] + b * py[i] + c - pz[i]) / nrm;
            sq += d * d; used++;
        }
        r.planeRmsCm = used > 0 ? Math.sqrt(sq / used) * 100 : 999;
        if (used == 0 || r.planeRmsCm > MAX_PLANE_RMS_M * 100) {
            r.note = "Surface d'appui non plane (±" + String.format("%.1f", r.planeRmsCm) +
                     " cm) : pose l'assiette sur une table dégagée et recule un peu.";
            r.diag = diag(r, dw, dh, fx, fy);
            return r;
        }

        /* Inclinaison du téléphone par rapport à la table : la normale du plan
           ajusté fait cet angle avec l'axe optique. À plat au-dessus de
           l'assiette, elle vaut zéro. */
        r.tiltDeg = Math.toDegrees(Math.acos(Math.min(1, 1 / nrm)));
        if (r.tiltDeg > MAX_TILT_DEG) {
            r.note = "Téléphone trop incliné (" + Math.round(r.tiltDeg) + "°) : tiens-le " +
                     "à plat, écran horizontal, juste au-dessus de l'assiette.";
            r.diag = diag(r, dw, dh, fx, fy);
            return r;
        }

        // ---- Centre : le relief au-dessus de ce plan ----
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

                double qx = (x - cx) * z / fx;
                double qy = (y - cy) * z / fy;
                // Un point PLUS PRÈS de l'objectif que la table est au-dessus d'elle.
                double h = (a * qx + b * qy + c - z) / nrm;
                if (h < MIN_HEIGHT_M || h > MAX_HEIGHT_M) continue;

                double pixelArea = (z / fx) * (z / fy);
                double len = Math.sqrt(qx * qx + qy * qy + z * z);
                double cos = len > 0 ? Math.abs((-a * qx - b * qy + z) / (nrm * len)) : 1;
                if (cos < MIN_COS) continue;

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
            r.note = "Aucun relief au centre (" + count + " points) : centre l'assiette dans le cadre.";
            r.diag = diag(r, dw, dh, fx, fy);
            return r;
        }

        float median = median(depths, depthCount);
        double volumeCm3 = volume * 1e6;
        double areaCm2 = area * 1e4;

        /* Dernier filtre : la vraisemblance. Une assiette de repas tient dans
           quelques centaines de cm³ ; au-delà, ce n'est pas un plat copieux,
           c'est un plan d'appui faux. */
        if (areaCm2 < MIN_AREA_CM2 || areaCm2 > MAX_AREA_CM2 ||
            volumeCm3 < MIN_VOLUME_CM3 || volumeCm3 > MAX_VOLUME_CM3) {
            r.samples = count;
            r.note = "Mesure invraisemblable (" + Math.round(volumeCm3) + " cm³ sur " +
                     Math.round(areaCm2) + " cm²) : recule à 50-60 cm et recadre sur l'assiette seule.";
            r.diag = diag(r, dw, dh, fx, fy);
            return r;
        }

        r.ok = true;
        r.samples = count;
        r.volumeCm3 = volumeCm3;
        r.areaCm2 = areaCm2;
        r.heightMaxCm = maxHeight * 100;
        r.heightMeanCm = (heightSum / count) * 100;
        r.distanceCm = median * 100;
        float fxPhoto = focal[0] * ((float) photoWidthPx / dim[0]);
        r.cmPerPixel = fxPhoto > 0 ? (median / fxPhoto) * 100 : 0;
        r.diag = diag(r, dw, dh, fx, fy);
        if (median < BEST_DEPTH_MIN_M) {
            r.note = "Un peu près (" + Math.round(median * 100) + " cm) : à 50-60 cm la mesure est plus sûre.";
        }
        return r;
    }

    /**
     * Profondeur en mètres, ou 0 si le pixel n'a pas de mesure.
     *
     * Aucun masquage de bits : contrairement au format DEPTH16 d'Android, où les
     * trois bits de poids fort portent une confiance, l'image d'ARCore contient
     * la distance en millimètres sur les seize bits.
     */
    private static float depthAt(ByteBuffer raw, int rowStride, int x, int y) {
        int offset = y * rowStride + x * 2;
        if (offset < 0 || offset + 1 >= raw.limit()) return 0;
        int mm = (raw.get(offset) & 0xFF) | ((raw.get(offset + 1) & 0xFF) << 8);
        return mm <= 0 ? 0 : mm / 1000f;
    }

    /** Plan z = a·x + b·y + c par moindres carrés, éventuellement restreint. */
    private static double[] fit(double[] px, double[] py, double[] pz, int n, boolean[] keep) {
        double s11 = 0, s12 = 0, s13 = 0, s22 = 0, s23 = 0, s33 = 0, sz = 0, sxz = 0, syz = 0;
        for (int i = 0; i < n; i++) {
            if (keep != null && !keep[i]) continue;
            double x = px[i], y = py[i], z = pz[i];
            s11 += x * x; s12 += x * y; s13 += x;
            s22 += y * y; s23 += y; s33 += 1;
            sxz += x * z; syz += y * z; sz += z;
        }
        if (s33 < 3) return null;
        return solve3(s11, s12, s13, s12, s22, s23, s13, s23, s33, sxz, syz, sz);
    }

    /** Résolution d'un système 3×3 par élimination de Gauss avec pivot partiel. */
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
