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
import com.google.ar.core.Plane;
import com.google.ar.core.Session;
import com.google.ar.core.TrackingState;
import com.google.ar.core.exceptions.CameraNotAvailableException;
import com.google.ar.core.exceptions.UnavailableException;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.Collection;
import java.util.concurrent.atomic.AtomicBoolean;

import javax.microedition.khronos.egl.EGLConfig;
import javax.microedition.khronos.opengles.GL10;

/**
 * Écran de visée : aperçu caméra ARCore, état de la mesure en direct, et un
 * bouton qui fige une image avec sa carte de profondeur.
 *
 * L'interface est construite en code plutôt qu'en XML : le projet Android est
 * régénéré à chaque compilation par « cap add android », donc tout fichier de
 * ressources devrait être réinjecté par le workflow. Une activité autonome
 * réduit d'autant ce qu'il y a à recopier — et à oublier de recopier.
 */
public class DepthScanActivity extends AppCompatActivity implements GLSurfaceView.Renderer {

    private static final int CAMERA_REQUEST = 4711;
    private static final int JPEG_QUALITY = 88;

    private GLSurfaceView surfaceView;
    private TextView status;
    private Button shoot;

    private Session session;
    private final CameraQuadRenderer background = new CameraQuadRenderer();
    private final AtomicBoolean captureRequested = new AtomicBoolean(false);
    private boolean sessionResumed = false;
    private int sensorOrientation = 90;

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
        status.setText("Vise l'assiette d'en haut, à environ 30 cm, et bouge très légèrement le téléphone.");
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
        config.setPlaneFindingMode(Config.PlaneFindingMode.HORIZONTAL);
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

        boolean tracking = frame.getCamera().getTrackingState() == TrackingState.TRACKING;
        Collection<Plane> planes = session.getAllTrackables(Plane.class);
        int horizontal = 0;
        for (Plane p : planes) {
            if (p.getTrackingState() == TrackingState.TRACKING
                    && p.getType() == Plane.Type.HORIZONTAL_UPWARD_FACING
                    && p.getSubsumedBy() == null) horizontal++;
        }
        final boolean ready = tracking && horizontal > 0;
        final String message = !tracking
                ? "Initialisation… bouge doucement le téléphone."
                : horizontal == 0
                    ? "Cherche la table : incline légèrement le téléphone au-dessus du plateau."
                    : "Table détectée. Vise l'assiette d'en haut, puis capture.";
        runOnUiThread(() -> {
            status.setText(message);
            if (!captureRequested.get()) shoot.setEnabled(ready);
        });

        if (captureRequested.getAndSet(false)) {
            doCapture(frame, planes);
        }
    }

    private void doCapture(Frame frame, Collection<Plane> planes) {
        Image depth = null;
        Image rgb = null;
        try {
            rgb = frame.acquireCameraImage();
            byte[] jpeg = toJpeg(rgb, sensorOrientation);
            if (jpeg == null) { failOnUi("Image caméra illisible."); return; }

            int width = decodedWidth(jpeg);

            DepthMeasure.Result r;
            try {
                depth = frame.acquireDepthImage16Bits();
                r = DepthMeasure.measure(frame, depth, planes, width);
            } catch (Exception e) {
                r = new DepthMeasure.Result();
                r.note = "Carte de profondeur indisponible sur cette image.";
            }

            /* La photo est renvoyée même quand la profondeur échoue : elle reste
               parfaitement utilisable par le chemin normal, et jeter la prise de
               vue obligerait à tout recommencer pour rien. */
            Intent out = new Intent();
            out.putExtra("jpegBase64", Base64.encodeToString(jpeg, Base64.NO_WRAP));
            out.putExtra("depthOk", r.ok);
            out.putExtra("volumeCm3", r.volumeCm3);
            out.putExtra("areaCm2", r.areaCm2);
            out.putExtra("heightMaxCm", r.heightMaxCm);
            out.putExtra("heightMeanCm", r.heightMeanCm);
            out.putExtra("distanceCm", r.distanceCm);
            out.putExtra("cmPerPixel", r.cmPerPixel);
            out.putExtra("samples", r.samples);
            out.putExtra("note", r.note);
            setResult(RESULT_OK, out);
            finish();
        } catch (Exception e) {
            failOnUi("Capture impossible : " + e.getMessage());
        } finally {
            if (depth != null) depth.close();
            if (rgb != null) rgb.close();
        }
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
