package io.github.rachid598.glucovision;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.ImageFormat;
import android.graphics.Matrix;
import android.graphics.Rect;
import android.graphics.YuvImage;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.media.Image;
import android.opengl.GLES20;
import android.opengl.GLSurfaceView;
import android.os.Bundle;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.google.ar.core.ArCoreApk;
import com.google.ar.core.Config;
import com.google.ar.core.Frame;
import com.google.ar.core.Session;
import com.google.ar.core.TrackingState;
import com.google.ar.core.exceptions.CameraNotAvailableException;
import com.google.ar.core.exceptions.UnavailableException;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

import javax.microedition.khronos.egl.EGLConfig;
import javax.microedition.khronos.opengles.GL10;

/**
 * Écran de visée : aperçu caméra ARCore, mesure du relief EN DIRECT, et capture.
 *
 * La mesure tourne à chaque image et son résultat s'affiche immédiatement. C'est
 * ce qui rend l'écran utilisable : on voit le volume apparaître et se stabiliser,
 * on capture quand il est bon. La version précédente exigeait d'attendre qu'ARCore
 * détecte un plan avant même d'autoriser la capture — une attente indéterminée
 * sur une table unie, pour un plan qui pouvait de toute façon être le sol.
 *
 * L'interface est construite en code plutôt qu'en XML : le projet Android est
 * régénéré à chaque compilation par « cap add android », donc tout fichier de
 * ressources devrait être réinjecté par le workflow.
 */
public class DepthScanActivity extends AppCompatActivity implements GLSurfaceView.Renderer {

    private static final int CAMERA_REQUEST = 4711;
    private static final int JPEG_QUALITY = 88;

    /* La capture retient la MÉDIANE de plusieurs images consécutives. Une carte
       de profondeur isolée est bruitée ; la médiane écarte l'image aberrante
       sans rien coûter à l'utilisateur, qui appuie une seule fois. */
    private static final int CAPTURE_FRAMES = 7;

    /* Le relief n'est proposé qu'après STABLE_WINDOW mesures consécutives dont
       les volumes ne s'écartent pas de plus de STABLE_TOLERANCE. */
    private static final int STABLE_WINDOW = 4;
    private static final double STABLE_TOLERANCE = 0.25;

    private GLSurfaceView surfaceView;
    private TextView status;
    private Button shoot;

    private Session session;
    private final CameraQuadRenderer background = new CameraQuadRenderer();
    private final AtomicBoolean captureRequested = new AtomicBoolean(false);
    private final List<DepthMeasure.Result> burst = new ArrayList<>();
    private final List<Double> recent = new ArrayList<>();
    private boolean sessionResumed = false;
    private boolean capturing = false;
    private int sensorOrientation = 90;
    private long lastLiveMeasure = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(buildUi());

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{ Manifest.permission.CAMERA }, CAMERA_REQUEST);
        }
    }

    private View buildUi() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        surfaceView = new GLSurfaceView(this);
        surfaceView.setPreserveEGLContextOnPause(true);
        surfaceView.setEGLContextClientVersion(2);
        surfaceView.setEGLConfigChooser(8, 8, 8, 8, 16, 0);
        surfaceView.setRenderer(this);
        surfaceView.setRenderMode(GLSurfaceView.RENDERMODE_CONTINUOUSLY);
        surfaceView.setWillNotDraw(false);
        root.addView(surfaceView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(48, 48, 48, 64);
        panel.setGravity(Gravity.CENTER_HORIZONTAL);

        status = new TextView(this);
        status.setTextColor(Color.WHITE);
        status.setTextSize(15f);
        status.setGravity(Gravity.CENTER);
        status.setShadowLayer(6f, 0f, 2f, Color.BLACK);
        status.setText("Vise l'assiette d'en haut, à 50-60 cm.\nBouge doucement le téléphone.");
        panel.addView(status);

        shoot = new Button(this);
        shoot.setText("Capturer");
        shoot.setAllCaps(false);
        shoot.setTextSize(17f);
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        bp.topMargin = 32;
        shoot.setLayoutParams(bp);
        shoot.setOnClickListener(v -> {
            shoot.setEnabled(false);
            shoot.setText("Mesure…");
            synchronized (burst) { burst.clear(); }
            capturing = true;
            captureRequested.set(true);
        });
        panel.addView(shoot);

        FrameLayout.LayoutParams pl = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        pl.gravity = Gravity.BOTTOM;
        root.addView(panel, pl);
        return root;
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            return; // on attend la réponse à la demande de permission
        }
        if (session == null && !openSession()) return;
        try {
            session.resume();
            sessionResumed = true;
        } catch (CameraNotAvailableException e) {
            fail("Caméra indisponible : " + e.getMessage());
            return;
        }
        surfaceView.onResume();
    }

    private boolean openSession() {
        try {
            if (ArCoreApk.getInstance().requestInstall(this, true)
                    == ArCoreApk.InstallStatus.INSTALL_REQUESTED) {
                return false; // onResume sera rappelé après l'installation
            }
            session = new Session(this);
        } catch (UnavailableException e) {
            fail("ARCore indisponible sur cet appareil : " + e.getMessage());
            return false;
        }

        Config config = session.getConfig();
        if (!session.isDepthModeSupported(Config.DepthMode.AUTOMATIC)) {
            fail("Cet appareil est compatible ARCore mais pas l'API Depth.");
            return false;
        }
        config.setDepthMode(Config.DepthMode.AUTOMATIC);
        /* Détection de plans désactivée : le plan d'appui est déduit de la carte
           de profondeur (voir DepthMeasure). La laisser active ne ferait que
           consommer du calcul pour un résultat qu'on n'utilise plus. */
        config.setPlaneFindingMode(Config.PlaneFindingMode.DISABLED);
        config.setFocusMode(Config.FocusMode.AUTO);
        config.setUpdateMode(Config.UpdateMode.LATEST_CAMERA_IMAGE);
        session.configure(config);

        /* L'image caméra sort dans l'orientation du capteur, pas de l'écran :
           sans cette rotation, le modèle recevrait une assiette couchée. */
        try {
            CameraManager cm = (CameraManager) getSystemService(Context.CAMERA_SERVICE);
            String id = session.getCameraConfig().getCameraId();
            Integer o = cm.getCameraCharacteristics(id).get(CameraCharacteristics.SENSOR_ORIENTATION);
            if (o != null) sensorOrientation = o;
        } catch (Exception ignored) { /* 90° reste un défaut raisonnable */ }
        return true;
    }

    @Override
    protected void onPause() {
        if (session != null && sessionResumed) {
            surfaceView.onPause();
            session.pause();
            sessionResumed = false;
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (session != null) { session.close(); session = null; }
        super.onDestroy();
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        if (code != CAMERA_REQUEST) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
            onResume();
        } else {
            fail("Autorisation caméra refusée.");
        }
    }

    // ---------- Rendu ----------

    @Override
    public void onSurfaceCreated(GL10 gl, EGLConfig config) {
        GLES20.glClearColor(0f, 0f, 0f, 1f);
        int texture = background.createTexture();
        if (session != null) session.setCameraTextureName(texture);
    }

    @Override
    public void onSurfaceChanged(GL10 gl, int width, int height) {
        GLES20.glViewport(0, 0, width, height);
        if (session != null) {
            session.setDisplayGeometry(getWindowManager().getDefaultDisplay().getRotation(), width, height);
        }
    }

    @Override
    public void onDrawFrame(GL10 gl) {
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT | GLES20.GL_DEPTH_BUFFER_BIT);
        if (session == null || !sessionResumed) return;

        Frame frame;
        try {
            frame = session.update();
        } catch (CameraNotAvailableException e) {
            return;
        }
        background.draw(frame);

        if (frame.getCamera().getTrackingState() != TrackingState.TRACKING) {
            setStatus("Initialisation de la caméra…", false);
            return;
        }

        if (capturing) {
            collectBurst(frame);
            return;
        }

        // Aperçu de la mesure, limité à ~4 fois par seconde : inutile de la
        // recalculer 60 fois, et ça garde l'aperçu parfaitement fluide.
        long now = System.currentTimeMillis();
        if (now - lastLiveMeasure < 250) return;
        lastLiveMeasure = now;

        DepthMeasure.Result r = measureOnce(frame);
        if (r == null) {
            recent.clear();
            setStatus("Carte de profondeur en préparation… fais un petit mouvement latéral.", false);
            return;
        }
        if (!r.ok) {
            recent.clear();
            setStatus(r.note, false);
            return;
        }

        recent.add(r.volumeCm3);
        while (recent.size() > STABLE_WINDOW) recent.remove(0);

        if (!stable()) {
            setStatus("Mesure en cours : " + Math.round(r.volumeCm3) + " cm³ à "
                    + Math.round(r.distanceCm) + " cm.\nTiens le téléphone immobile, le chiffre doit se stabiliser.", false);
            return;
        }
        setStatus("✓ Relief stable : " + Math.round(r.volumeCm3) + " cm³, hauteur "
                + String.format("%.1f", r.heightMaxCm) + " cm, à " + Math.round(r.distanceCm) + " cm.", true);
    }

    /* Le relief n'est proposé que si plusieurs mesures d'affilée se rejoignent.
       C'est ce garde-fou qui manquait : des valeurs sautant de 1500 à 5500 cm³
       étaient offertes à la capture comme si elles voulaient dire quelque chose,
       alors que leur seule information est qu'il ne faut PAS les utiliser. */
    private boolean stable() {
        if (recent.size() < STABLE_WINDOW) return false;
        double min = Double.MAX_VALUE, max = 0;
        for (double v : recent) { min = Math.min(min, v); max = Math.max(max, v); }
        return min > 0 && (max - min) / min <= STABLE_TOLERANCE;
    }

    /** Mesure sur une image, ou null si la profondeur n'est pas encore là. */
    private DepthMeasure.Result measureOnce(Frame frame) {
        Image depth = null;
        try {
            depth = frame.acquireDepthImage16Bits();
            return DepthMeasure.measure(frame, depth, 640);
        } catch (Exception e) {
            return null;
        } finally {
            if (depth != null) depth.close();
        }
    }

    /** Accumule quelques mesures, puis fige l'image et rend la main. */
    private void collectBurst(Frame frame) {
        DepthMeasure.Result r = measureOnce(frame);
        int size;
        synchronized (burst) {
            if (r != null) burst.add(r);
            size = burst.size();
        }
        setStatus("Mesure… " + size + "/" + CAPTURE_FRAMES, false);
        if (size < CAPTURE_FRAMES) return;

        capturing = false;
        captureRequested.set(false);
        finishCapture(frame);
    }

    private void finishCapture(Frame frame) {
        Image rgb = null;
        try {
            rgb = frame.acquireCameraImage();
            byte[] jpeg = toJpeg(rgb, sensorOrientation);
            if (jpeg == null) { failOnUi("Image caméra illisible."); return; }
            int width = decodedWidth(jpeg);

            DepthMeasure.Result best = medianResult(width, frame);

            /* La photo est renvoyée même quand la profondeur échoue : elle reste
               parfaitement utilisable par le chemin normal, et jeter la prise de
               vue obligerait à tout recommencer pour rien. */
            Intent out = new Intent();
            out.putExtra("jpegBase64", Base64.encodeToString(jpeg, Base64.NO_WRAP));
            out.putExtra("depthOk", best != null && best.ok);
            out.putExtra("volumeCm3", best != null ? best.volumeCm3 : 0);
            out.putExtra("areaCm2", best != null ? best.areaCm2 : 0);
            out.putExtra("heightMaxCm", best != null ? best.heightMaxCm : 0);
            out.putExtra("heightMeanCm", best != null ? best.heightMeanCm : 0);
            out.putExtra("distanceCm", best != null ? best.distanceCm : 0);
            out.putExtra("cmPerPixel", best != null ? best.cmPerPixel : 0);
            out.putExtra("samples", best != null ? best.samples : 0);
            out.putExtra("note", best != null ? best.note : "Aucune mesure de profondeur exploitable.");
            out.putExtra("diag", best != null ? best.diag : "");
            setResult(RESULT_OK, out);
            finish();
        } catch (Exception e) {
            failOnUi("Capture impossible : " + e.getMessage());
        } finally {
            if (rgb != null) rgb.close();
        }
    }

    /**
     * Mesure retenue : celle dont le volume est médian parmi les images réussies.
     * On garde un objet complet plutôt que des moyennes champ par champ, pour que
     * volume, hauteur et échelle restent cohérents entre eux — ils décrivent
     * alors tous la même image, et non un mélange de plusieurs.
     */
    private DepthMeasure.Result medianResult(int photoWidthPx, Frame frame) {
        List<DepthMeasure.Result> ok = new ArrayList<>();
        DepthMeasure.Result lastFailure = null;
        synchronized (burst) {
            for (DepthMeasure.Result r : burst) {
                if (r.ok) ok.add(r); else lastFailure = r;
            }
        }
        if (ok.isEmpty()) return lastFailure;
        Collections.sort(ok, (p, q) -> Double.compare(p.volumeCm3, q.volumeCm3));
        DepthMeasure.Result chosen = ok.get(ok.size() / 2);

        /* Les mesures d'aperçu ont été calculées avec une largeur de photo par
           défaut : l'échelle est rapportée ici à la vraie largeur du JPEG. */
        Image depth = null;
        try {
            depth = frame.acquireDepthImage16Bits();
            DepthMeasure.Result exact = DepthMeasure.measure(frame, depth, photoWidthPx);
            if (exact.ok) chosen.cmPerPixel = exact.cmPerPixel;
        } catch (Exception ignored) {
        } finally {
            if (depth != null) depth.close();
        }
        return chosen;
    }

    /* Le bouton reste TOUJOURS actif dès que la caméra suit : l'écran ne doit
       jamais être un cul-de-sac. Si le relief n'est pas mesurable, la capture
       renvoie quand même la photo, qui suffit au chemin normal — le désactiver
       obligerait à ressortir et à tout reprendre. */
    private void setStatus(String message, boolean depthReady) {
        runOnUiThread(() -> {
            status.setText(message);
            if (!capturing) {
                shoot.setEnabled(true);
                shoot.setText(depthReady ? "Capturer avec le relief" : "Capturer la photo seule");
            }
        });
    }

    private static int decodedWidth(byte[] jpeg) {
        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length, opts);
        return opts.outWidth > 0 ? opts.outWidth : 640;
    }

    /** YUV_420_888 → NV21 → JPEG, puis rotation dans le sens de l'écran. */
    private static byte[] toJpeg(Image image, int rotationDegrees) {
        if (image.getFormat() != ImageFormat.YUV_420_888) return null;
        int w = image.getWidth(), h = image.getHeight();

        ByteBuffer yBuf = image.getPlanes()[0].getBuffer();
        ByteBuffer uBuf = image.getPlanes()[1].getBuffer();
        ByteBuffer vBuf = image.getPlanes()[2].getBuffer();
        int ySize = yBuf.remaining(), uSize = uBuf.remaining(), vSize = vBuf.remaining();

        byte[] nv21 = new byte[ySize + uSize + vSize];
        yBuf.get(nv21, 0, ySize);
        // NV21 attend V avant U ; l'ordre inverse donnerait une image aux couleurs permutées.
        vBuf.get(nv21, ySize, vSize);
        uBuf.get(nv21, ySize + vSize, uSize);

        ByteArrayOutputStream out = new ByteArrayOutputStream();
        new YuvImage(nv21, ImageFormat.NV21, w, h, null)
                .compressToJpeg(new Rect(0, 0, w, h), JPEG_QUALITY, out);
        byte[] jpeg = out.toByteArray();
        if (rotationDegrees % 360 == 0) return jpeg;

        Bitmap bmp = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length);
        if (bmp == null) return jpeg;
        Matrix m = new Matrix();
        m.postRotate(rotationDegrees);
        Bitmap rotated = Bitmap.createBitmap(bmp, 0, 0, bmp.getWidth(), bmp.getHeight(), m, true);
        ByteArrayOutputStream ro = new ByteArrayOutputStream();
        rotated.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, ro);
        bmp.recycle();
        rotated.recycle();
        return ro.toByteArray();
    }

    private void failOnUi(String message) {
        runOnUiThread(() -> fail(message));
    }

    private void fail(String message) {
        Intent out = new Intent();
        out.putExtra("error", message);
        setResult(RESULT_CANCELED, out);
        finish();
    }
}
