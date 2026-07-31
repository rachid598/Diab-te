package io.github.rachid598.glucovision;

import android.media.Image;

import com.google.ar.core.CameraIntrinsics;
import com.google.ar.core.Frame;
import com.google.ar.core.Plane;
import com.google.ar.core.Pose;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.ShortBuffer;
import java.util.Arrays;
import java.util.Collection;

/**
 * Transforme une carte de profondeur ARCore en mesures exploitables.
 *
 * Principe : la table est un plan détecté par ARCore. Chaque pixel de la carte
 * de profondeur est reprojeté en 3D, et sa hauteur au-dessus de ce plan donne
 * l'épaisseur des aliments à cet endroit. La somme (hauteur × surface couverte
 * par le pixel) est le volume au-dessus de la table.
 *
 * Ce que la mesure vaut, et ce qu'elle ne vaut pas :
 * - L'échelle (cm par pixel) est fiable : c'est de la géométrie, pas une
 *   estimation. C'est elle qui rend l'objet-repère inutile.
 * - Le volume est un MAJORANT : le capteur voit le relief, donc l'assiette et
 *   son rebord comptent dans le total. Il faut le dire au modèle plutôt que de
 *   présenter le chiffre comme le volume des seuls aliments.
 * - Ce qui est caché ne se mesure pas. Un riz noyé sous une sauce, un féculent
 *   sous une escalope : la profondeur n'en dit pas plus qu'une photo.
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
    }

    /* Un aliment posé sur une table dépasse de quelques millimètres au moins, et
       jamais de plus de 30 cm. Hors de ces bornes, c'est la table elle-même
       (bruit de mesure) ou un objet qui n'a rien à voir — une main, une bouteille
       en arrière-plan, le dossier d'une chaise. */
    private static final float MIN_HEIGHT_M = 0.005f;
    private static final float MAX_HEIGHT_M = 0.30f;

    /* Un repas se photographie de près. Au-delà, on regarde la pièce. */
    private static final float MAX_DEPTH_M = 1.6f;
    private static final float MIN_DEPTH_M = 0.10f;

    /* On n'intègre que la zone centrale : les bords de l'image attrapent le
       reste de la table, le bord de la nappe, ce qu'il y a derrière. */
    private static final float CENTER_FRACTION = 0.62f;

    /* En dessous, la carte de profondeur est trop trouée pour qu'une somme ait
       un sens — mieux vaut ne rien annoncer que d'annoncer un volume faux. */
    private static final int MIN_SAMPLES = 400;

    /**
     * @param photoWidthPx largeur en pixels du JPEG effectivement transmis au
     *                     modèle, pour que l'échelle rendue s'y rapporte.
     */
    static Result measure(Frame frame, Image depth, Collection<Plane> planes, int photoWidthPx) {
        Result r = new Result();

        Plane table = pickTable(planes, frame.getCamera().getPose());
        if (table == null) {
            r.note = "Aucun plan horizontal détecté : bouge légèrement le téléphone au-dessus de la table.";
            return r;
        }

        int dw = depth.getWidth();
        int dh = depth.getHeight();
        Image.Plane p0 = depth.getPlanes()[0];
        ByteBuffer raw = p0.getBuffer().order(ByteOrder.nativeOrder());
        int rowStrideBytes = p0.getRowStride();

        /* Les intrinsèques décrivent l'image caméra pleine résolution ; la carte
           de profondeur est beaucoup plus petite. Sans cette mise à l'échelle,
           la reprojection est fausse d'un facteur 5 à 10. */
        CameraIntrinsics intr = frame.getCamera().getTextureIntrinsics();
        int[] dim = intr.getImageDimensions();
        float[] focal = intr.getFocalLength();
        float[] principal = intr.getPrincipalPoint();
        float sx = (float) dw / dim[0];
        float sy = (float) dh / dim[1];
        float fx = focal[0] * sx, fy = focal[1] * sy;
        float cx = principal[0] * sx, cy = principal[1] * sy;
        if (fx <= 0 || fy <= 0) {
            r.note = "Paramètres optiques indisponibles.";
            return r;
        }

        Pose camPose = frame.getCamera().getPose();
        Pose planePose = table.getCenterPose();
        float[] n = planePose.getYAxis();               // normale du plan, vers le haut
        float[] o = planePose.getTranslation();

        int x0 = (int) (dw * (1 - CENTER_FRACTION) / 2);
        int x1 = dw - x0;
        int y0 = (int) (dh * (1 - CENTER_FRACTION) / 2);
        int y1 = dh - y0;

        double volume = 0, area = 0, heightSum = 0, maxHeight = 0;
        int count = 0;
        float[] depths = new float[(x1 - x0) * (y1 - y0)];
        int depthCount = 0;
        float[] pt = new float[3];

        for (int y = y0; y < y1; y++) {
            for (int x = x0; x < x1; x++) {
                int offset = y * rowStrideBytes + x * 2;
                if (offset < 0 || offset + 1 >= raw.limit()) continue;
                int value = (raw.get(offset) & 0xFF) | ((raw.get(offset + 1) & 0xFF) << 8);
                /* DEPTH16 : les 13 bits de poids faible portent la distance en
                   millimètres, les 3 bits hauts un indice de confiance. */
                int mm = value & 0x1FFF;
                if (mm == 0) continue;
                float z = mm / 1000f;
                if (z < MIN_DEPTH_M || z > MAX_DEPTH_M) continue;

                // Repère caméra ARCore : X à droite, Y en haut, -Z vers l'avant.
                pt[0] = (x - cx) * z / fx;
                pt[1] = -(y - cy) * z / fy;
                pt[2] = -z;
                float[] world = camPose.transformPoint(pt);

                float h = (world[0] - o[0]) * n[0]
                        + (world[1] - o[1]) * n[1]
                        + (world[2] - o[2]) * n[2];
                if (h < MIN_HEIGHT_M || h > MAX_HEIGHT_M) continue;

                /* Surface couverte par ce pixel à cette distance. Le rayon frappe
                   la table de biais : on ramène la surface au plan horizontal,
                   sinon un plat vu de côté serait sous-compté. */
                double pixelArea = (z / fx) * (z / fy);
                float[] camPos = camPose.getTranslation();
                double rx = world[0] - camPos[0], ry = world[1] - camPos[1], rz = world[2] - camPos[2];
                double len = Math.sqrt(rx * rx + ry * ry + rz * rz);
                double cos = len > 0 ? Math.abs((rx * n[0] + ry * n[1] + rz * n[2]) / len) : 1;
                if (cos < 0.15) continue;               // rasant : trop imprécis
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
            r.note = "Trop peu de points de profondeur (" + count + ") : rapproche-toi un peu " +
                     "et bouge doucement le téléphone pour que le relief se construise.";
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
        /* Échelle rapportée au JPEG transmis : la largeur du champ à la distance
           médiane, divisée par le nombre de pixels de l'image. */
        float fxPhoto = focal[0] * ((float) photoWidthPx / dim[0]);
        r.cmPerPixel = fxPhoto > 0 ? (median / fxPhoto) * 100 : 0;
        return r;
    }

    private static float median(float[] values, int count) {
        float[] copy = Arrays.copyOf(values, count);
        Arrays.sort(copy);
        return copy[count / 2];
    }

    /**
     * Retient le plan horizontal tourné vers le haut le plus proche devant la
     * caméra. Le plus grand ne conviendrait pas : le sol est souvent mieux
     * détecté que la table, et il fausserait toutes les hauteurs.
     */
    private static Plane pickTable(Collection<Plane> planes, Pose camPose) {
        Plane best = null;
        double bestScore = Double.MAX_VALUE;
        float[] cam = camPose.getTranslation();
        for (Plane plane : planes) {
            if (plane.getTrackingState() != com.google.ar.core.TrackingState.TRACKING) continue;
            if (plane.getType() != Plane.Type.HORIZONTAL_UPWARD_FACING) continue;
            if (plane.getSubsumedBy() != null) continue;
            float[] c = plane.getCenterPose().getTranslation();
            double dx = c[0] - cam[0], dy = c[1] - cam[1], dz = c[2] - cam[2];
            double dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (dist > 2.0) continue;
            if (dist < bestScore) { bestScore = dist; best = plane; }
        }
        return best;
    }
}
