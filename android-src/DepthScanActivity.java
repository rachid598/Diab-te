package io.github.rachid598.glucovision;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ImageFormat;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.YuvImage;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.media.Image;
import android.opengl.GLES20;
import android.opengl.GLSurfaceView;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.Surface;
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
import com.google.ar.core.AugmentedImage;
import com.google.ar.core.AugmentedImageDatabase;
import com.google.ar.core.CameraIntrinsics;
import com.google.ar.core.CameraConfig;
import com.google.ar.core.CameraConfigFilter;
import com.google.ar.core.Config;
import com.google.ar.core.Frame;
import com.google.ar.core.Pose;
import com.google.ar.core.Session;
import com.google.ar.core.TrackingState;
import com.google.ar.core.exceptions.CameraNotAvailableException;
import com.google.ar.core.exceptions.NotYetAvailableException;
import com.google.ar.core.exceptions.UnavailableException;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

import javax.microedition.khronos.egl.EGLConfig;
import javax.microedition.khronos.opengles.GL10;

/**
 * Viseur ARCore. Il cherche d'abord une echelle reproductible ; l'absence de
 * profondeur ne bloque jamais la photo normale.
 */
public final class DepthScanActivity extends AppCompatActivity implements GLSurfaceView.Renderer {
    private static final int CAMERA_PERMISSION_REQUEST = 4711;
    private static final int JPEG_QUALITY = 88;
    private static final int MAX_PHOTO_EDGE = 1600;

    private static final double MIN_BASELINE_M = 0.20;
    private static final double MIN_OBSERVATION_SEPARATION_M = 0.025;
    private static final int REQUIRED_OBSERVATIONS = 4;
    private static final int MAX_OBSERVATIONS = 8;
    private static final long OBSERVATION_MAX_AGE_MS = 8000;
    private static final long LIVE_MEASURE_PERIOD_MS = 180;
    private static final long READY_MAX_AGE_MS = 1200;
    private static final long DEPTH_CAPTURE_WAIT_MS = 3500;
    private static final long PHOTO_CAPTURE_WAIT_MS = 1500;
    private static final long PHOTO_GIVE_UP_EXTRA_MS = 3000;

    private static final String CARD_ASSET = "glucovision-card.png";
    /** Identité signée de l'image réellement embarquée dans cet APK. */
    private static final String CARD_NAME = "glucovision-card-v2";
    private static final String CARD_SCHEMA = "glucovision-card-v2";
    private static final double CARD_DEPTH_MAX_RELATIVE_FIELD_ERROR = 0.08;
    private static final double CARD_DEPTH_MAX_DISTANCE_ERROR_CM = 5.0;
    private static final double CARD_DEPTH_MAX_NORMAL_ANGLE_DEG = 8.0;

    private GLSurfaceView surfaceView;
    private TextView statusView;
    private TextView debugView;
    private Button captureButton;
    private final CameraQuadRenderer background = new CameraQuadRenderer();

    private Session session;
    private boolean cardMode;
    private boolean depthModeSupported;
    private int cardImageIndex = -1;
    private String cardSetupError = "";
    private final CardTrackingGate cardTracking = new CardTrackingGate();
    private CardGeometry.Result currentCardMeasurement;
    private long currentCardFrameTimestamp = Long.MIN_VALUE;
    private String currentCardTrackingMethod = "NOT_TRACKING";
    private String currentCardNote = "Carte non detectee.";
    private volatile boolean activityResumed;
    private volatile boolean sessionResumed;
    private boolean surfaceResumed;
    private boolean permissionRequested;
    private boolean availabilityPending;
    private int availabilityRetries;
    private ArCoreApk.Availability availability;
    private boolean userRequestedInstall = true;
    private volatile int surfaceWidth;
    private volatile int surfaceHeight;
    private volatile int displayRotation;
    private int sensorOrientation = 90;
    private int lensFacing = CameraCharacteristics.LENS_FACING_BACK;

    private boolean trackingPreviously;
    private float[] baselineOrigin;
    private volatile double maxBaselineM;
    private long lastProcessedDepthTimestamp = Long.MIN_VALUE;
    private long lastLiveMeasurementAt;
    private String rawCenter = "-";
    private final Object observationLock = new Object();
    private final List<Observation> observations = new ArrayList<>();
    private long lastValidObservationAt;
    private DepthMeasure.Result lastFailure;

    private volatile boolean capturePending;
    private volatile boolean captureWantsScale;
    private volatile long captureDeadline;
    private volatile long captureGiveUp;
    private final AtomicBoolean finishing = new AtomicBoolean(false);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        cardMode = getIntent() != null && getIntent().getBooleanExtra("cardMode", false);
        setContentView(buildUi());
        ensureCameraPermission();
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
        root.addView(surfaceView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        root.addView(new GuideOverlay(this), new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER_HORIZONTAL);
        panel.setPadding(42, 42, 42, 56);

        statusView = new TextView(this);
        statusView.setTextColor(Color.WHITE);
        statusView.setTextSize(15f);
        statusView.setGravity(Gravity.CENTER);
        statusView.setShadowLayer(6f, 0f, 2f, Color.BLACK);
        statusView.setText(cardMode
                ? "Place la carte GlucoVision a plat a cote de l'assiette et garde-la visible."
                : "Place l'assiette dans le cadre, laisse de la table autour, puis balaye de 20 cm.");
        panel.addView(statusView);

        debugView = new TextView(this);
        debugView.setTextColor(Color.argb(220, 255, 255, 255));
        debugView.setTextSize(10.5f);
        debugView.setGravity(Gravity.CENTER);
        debugView.setShadowLayer(5f, 0f, 1f, Color.BLACK);
        LinearLayout.LayoutParams debugParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        debugParams.topMargin = 10;
        debugView.setLayoutParams(debugParams);
        panel.addView(debugView);

        captureButton = new Button(this);
        captureButton.setText("Capturer la photo seule");
        captureButton.setAllCaps(false);
        captureButton.setTextSize(17f);
        LinearLayout.LayoutParams buttonParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        buttonParams.topMargin = 28;
        captureButton.setLayoutParams(buttonParams);
        captureButton.setOnClickListener(v -> requestCapture());
        panel.addView(captureButton);

        FrameLayout.LayoutParams panelParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        panelParams.gravity = Gravity.BOTTOM;
        root.addView(panel, panelParams);
        return root;
    }

    private void ensureCameraPermission() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                == PackageManager.PERMISSION_GRANTED) return;
        if (permissionRequested) return;
        permissionRequested = true;
        ActivityCompat.requestPermissions(
                this, new String[] { Manifest.permission.CAMERA }, CAMERA_PERMISSION_REQUEST);
    }

    @Override
    protected void onResume() {
        super.onResume();
        activityResumed = true;
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            ensureCameraPermission();
            return;
        }
        resumeArIfPossible();
    }

    /** Idempotent : permission, callback async et onResume peuvent arriver dans n'importe quel ordre. */
    private void resumeArIfPossible() {
        if (!activityResumed || isFinishing() || sessionResumed) return;
        if (availability == null) {
            if (availabilityPending) return;
            availabilityPending = true;
            try {
                ArCoreApk.getInstance().checkAvailabilityAsync(getApplicationContext(), result -> {
                    availabilityPending = false;
                    if (result.isUnknown() || result.isTransient()) {
                        availability = null;
                        if (++availabilityRetries <= 3 && activityResumed) {
                            surfaceView.postDelayed(this::resumeArIfPossible, 800);
                        } else {
                            fail("Disponibilite ARCore impossible a confirmer (" + result.name() + ").");
                        }
                        return;
                    }
                    availability = result;
                    availabilityRetries = 0;
                    if (!result.isSupported()) {
                        fail("ARCore n'est pas compatible avec cet appareil (" + result.name() + ").");
                        return;
                    }
                    resumeArIfPossible();
                });
            } catch (RuntimeException e) {
                availabilityPending = false;
                fail("Verification ARCore impossible : " + safeMessage(e));
            }
            return;
        }
        if (!availability.isSupported()) return;
        if (session == null && !createSessionOnce()) return;

        try {
            session.resume();
            sessionResumed = true;
            if (!surfaceResumed) {
                surfaceView.onResume();
                surfaceResumed = true;
            }
            bindGeometryOnGlThread();
            resetTrackingState();
        } catch (CameraNotAvailableException | IllegalStateException e) {
            fail("Camera ARCore indisponible : " + safeMessage(e));
        }
    }

    private boolean createSessionOnce() {
        try {
            ArCoreApk.InstallStatus install = ArCoreApk.getInstance()
                    .requestInstall(this, userRequestedInstall);
            if (install == ArCoreApk.InstallStatus.INSTALL_REQUESTED) {
                userRequestedInstall = false;
                return false;
            }
            userRequestedInstall = false;
            session = new Session(this);

            CameraConfigFilter filter = new CameraConfigFilter(session)
                    .setTargetFps(EnumSet.of(CameraConfig.TargetFps.TARGET_FPS_30));
            List<CameraConfig> configs = session.getSupportedCameraConfigs(filter);
            if (!configs.isEmpty()) session.setCameraConfig(configs.get(0));

            Config config = session.getConfig();
            depthModeSupported = session.isDepthModeSupported(Config.DepthMode.AUTOMATIC);
            if (!depthModeSupported && !cardMode) {
                session.close();
                session = null;
                fail("Cet appareil suit ARCore, mais ne fournit pas l'API Depth.");
                return false;
            }
            if (depthModeSupported) config.setDepthMode(Config.DepthMode.AUTOMATIC);
            config.setPlaneFindingMode(Config.PlaneFindingMode.DISABLED);
            config.setFocusMode(Config.FocusMode.AUTO);
            config.setUpdateMode(Config.UpdateMode.LATEST_CAMERA_IMAGE);
            if (cardMode) configureCardDatabase(config);
            session.configure(config);
            readCameraOrientation();
            bindGeometryOnGlThread();
            return true;
        } catch (UnavailableException | RuntimeException e) {
            if (session != null) {
                session.close();
                session = null;
            }
            fail("ARCore indisponible : " + safeMessage(e));
            return false;
        }
    }

    /** Cree la base a l'execution afin que la largeur physique fasse partie du contrat signe. */
    private void configureCardDatabase(Config config) {
        cardImageIndex = -1;
        cardSetupError = "";
        Bitmap bitmap = null;
        try (InputStream input = getAssets().open(CARD_ASSET)) {
            bitmap = BitmapFactory.decodeStream(input);
            if (bitmap == null || bitmap.getWidth() <= 0 || bitmap.getHeight() <= 0) {
                throw new IOException("asset carte illisible");
            }
            double expectedRatio = CardGeometry.CARD_WIDTH_M / CardGeometry.CARD_HEIGHT_M;
            double actualRatio = (double) bitmap.getWidth() / bitmap.getHeight();
            if (Math.abs(actualRatio - expectedRatio) / expectedRatio > 0.03) {
                throw new IOException("rapport largeur/hauteur de l'asset carte invalide");
            }
            AugmentedImageDatabase database = new AugmentedImageDatabase(session);
            cardImageIndex = database.addImage(CARD_NAME, bitmap, (float) CardGeometry.CARD_WIDTH_M);
            config.setAugmentedImageDatabase(database);
        } catch (IOException | RuntimeException error) {
            cardImageIndex = -1;
            cardSetupError = "Carte etalon indisponible : " + safeMessage(error);
        } finally {
            if (bitmap != null) bitmap.recycle();
        }
    }

    private void bindGeometryOnGlThread() {
        if (surfaceView == null) return;
        surfaceView.queueEvent(() -> {
            Session current = session;
            int texture = background.textureId();
            if (current == null || texture < 0) return;
            current.setCameraTextureName(texture);
            int w = surfaceWidth, h = surfaceHeight;
            if (w > 0 && h > 0) current.setDisplayGeometry(displayRotation, w, h);
        });
    }

    private void readCameraOrientation() {
        try {
            CameraManager manager = (CameraManager) getSystemService(Context.CAMERA_SERVICE);
            String id = session.getCameraConfig().getCameraId();
            CameraCharacteristics characteristics = manager.getCameraCharacteristics(id);
            Integer orientation = characteristics.get(CameraCharacteristics.SENSOR_ORIENTATION);
            Integer facing = characteristics.get(CameraCharacteristics.LENS_FACING);
            if (orientation != null) sensorOrientation = orientation;
            if (facing != null) lensFacing = facing;
        } catch (Exception ignored) {
            sensorOrientation = 90;
            lensFacing = CameraCharacteristics.LENS_FACING_BACK;
        }
    }

    @Override
    protected void onPause() {
        activityResumed = false;
        if (surfaceResumed) {
            surfaceView.onPause();
            surfaceResumed = false;
        }
        if (session != null && sessionResumed) {
            session.pause();
            sessionResumed = false;
        }
        resetTrackingState();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (session != null) {
            session.close();
            session = null;
        }
        super.onDestroy();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != CAMERA_PERMISSION_REQUEST) return;
        if (results.length == 0 || results[0] != PackageManager.PERMISSION_GRANTED) {
            fail("Autorisation camera refusee.");
            return;
        }
        resumeArIfPossible();
    }

    @Override
    public void onSurfaceCreated(GL10 gl, EGLConfig config) {
        GLES20.glClearColor(0f, 0f, 0f, 1f);
        int texture = background.createTexture();
        Session current = session;
        if (current != null) current.setCameraTextureName(texture);
    }

    @Override
    public void onSurfaceChanged(GL10 gl, int width, int height) {
        GLES20.glViewport(0, 0, width, height);
        surfaceWidth = width;
        surfaceHeight = height;
        displayRotation = getWindowManager().getDefaultDisplay().getRotation();
        Session current = session;
        if (current != null) current.setDisplayGeometry(displayRotation, width, height);
    }

    @Override
    public void onDrawFrame(GL10 gl) {
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT | GLES20.GL_DEPTH_BUFFER_BIT);
        Session current = session;
        if (current == null || !sessionResumed || finishing.get()) return;

        Frame frame;
        try {
            frame = current.update();
        } catch (CameraNotAvailableException e) {
            failOnUi("Camera perdue : " + safeMessage(e));
            return;
        }
        background.draw(frame);
        long now = SystemClock.elapsedRealtime();

        if (frame.getCamera().getTrackingState() != TrackingState.TRACKING) {
            if (trackingPreviously) resetTrackingState();
            trackingPreviously = false;
            if (capturePending && now >= captureDeadline) {
                tryFinishPhoto(frame, null, null, now);
            } else {
                setStatus("Initialisation du suivi ARCore... bouge doucement le telephone.", false, null);
            }
            return;
        }
        if (!trackingPreviously) {
            resetTrackingState();
            trackingPreviously = true;
        }

        float[] pose = frame.getCamera().getPose().getTranslation();
        updateBaseline(pose);
        CardGeometry.Result cardMeasurement = cardMode ? updateCardTracking(frame, now) : null;

        if (capturePending) {
            if (cardMode) {
                DepthMeasure.Result depthMeasurement = null;
                boolean cardCurrent = captureWantsScale && cardMeasurement != null
                        && currentCardFrameTimestamp == frame.getTimestamp()
                        && cardTracking.ready(now) && now < captureDeadline;
                if (cardCurrent && depthModeSupported && maxBaselineM >= MIN_BASELINE_M) {
                    MeasurePacket packet = measureOnce(frame);
                    if (packet != null && packet.result != null) {
                        if (packet.result.scaleOk) addObservation(packet.result, pose, now);
                        else lastFailure = packet.result;
                        if (packet.result.scaleOk && measurementReady(now)
                                && candidateCompatible(packet.result, now)) {
                            depthMeasurement = packet.result;
                        }
                    }
                }
                if (cardCurrent) {
                    tryFinishPhoto(frame, depthMeasurement, cardMeasurement, now);
                } else if (!captureWantsScale || now >= captureDeadline) {
                    // Carte jamais prete, ou perdue pendant la synchronisation :
                    // la photo reste possible mais aucune ancienne pose ne voyage.
                    tryFinishPhoto(frame, null, null, now);
                } else {
                    setStatus("Carte perdue : recadre-la pour une mesure, sinon la photo sera conservee seule.",
                            false, currentCardNote);
                }
                return;
            }

            DepthMeasure.Result measurement = null;
            if (captureWantsScale && depthModeSupported
                    && maxBaselineM >= MIN_BASELINE_M && now < captureDeadline) {
                MeasurePacket packet = measureOnce(frame);
                if (packet != null && packet.result != null) {
                    if (packet.result.scaleOk) addObservation(packet.result, pose, now);
                    else lastFailure = packet.result;
                    if (packet.result.scaleOk && measurementReady(now)
                            && candidateCompatible(packet.result, now)) {
                        measurement = packet.result;
                    }
                }
            }
            if (!captureWantsScale || measurement != null || now >= captureDeadline) {
                tryFinishPhoto(frame, measurement, null, now);
            } else {
                setStatus("Synchronisation de la photo et de la profondeur...", false,
                        stableDebug(now));
            }
            return;
        }

        MeasurePacket packet = null;
        boolean depthTick = false;
        if (depthModeSupported && now - lastLiveMeasurementAt >= LIVE_MEASURE_PERIOD_MS) {
            depthTick = true;
            lastLiveMeasurementAt = now;
            packet = measureOnce(frame);
        }

        if (packet != null && packet.result != null) {
            if (packet.result.scaleOk) addObservation(packet.result, pose, now);
            else lastFailure = packet.result;
        }

        if (cardMode) {
            renderCardStatus(now, packet);
            return;
        }

        if (!depthTick) return;

        if (maxBaselineM < MIN_BASELINE_M) {
            setStatus("Balaye lentement de gauche a droite : "
                            + Math.round(maxBaselineM * 100) + " / 20 cm.",
                    false, packet == null ? null : packet.debug);
            return;
        }
        if (packet == null) {
            setStatus("Profondeur en preparation : garde l'assiette cadree et continue a balayer.",
                    false, "aucune nouvelle carte brute");
            return;
        }
        if (packet.result == null || !packet.result.scaleOk) {
            String message = packet.result == null
                    ? "Carte de profondeur non synchronisee : continue a balayer."
                    : packet.result.note;
            setStatus(message, false, packet.debug);
            return;
        }
        if (!measurementReady(now)) {
            int n = observationCount(now);
            setStatus("Echelle en cours de stabilisation : " + n + " / "
                            + REQUIRED_OBSERVATIONS + " positions distinctes.",
                    false, packet.debug);
            return;
        }

        DepthMeasure.Result ready = stableResult(now);
        setStatus("Echelle stable : la photo couvre environ "
                        + Math.round(ready.fieldWidthCm) + " cm de large, a "
                        + Math.round(ready.distanceCm) + " cm.",
                true, packet.debug);
    }

    /**
     * Lit l'etat ACTUEL de l'AugmentedImage. LAST_KNOWN_POSE est volontairement
     * traite comme une perte : seule FULL_TRACKING prouve que la carte est encore
     * visible dans la Frame qui pourra etre photographiee.
     */
    private CardGeometry.Result updateCardTracking(Frame frame, long now) {
        if (cardImageIndex < 0 || session == null) {
            loseCard("NOT_TRACKING", cardSetupError.isEmpty()
                    ? "Carte etalon non configuree." : cardSetupError);
            return null;
        }

        AugmentedImage expected = null;
        try {
            for (AugmentedImage image : session.getAllTrackables(AugmentedImage.class)) {
                if (image.getIndex() == cardImageIndex && CARD_NAME.equals(image.getName())) {
                    expected = image;
                    if (image.getTrackingState() == TrackingState.TRACKING
                            && image.getTrackingMethod()
                            == AugmentedImage.TrackingMethod.FULL_TRACKING) break;
                }
            }
        } catch (RuntimeException error) {
            loseCard("NOT_TRACKING", "Lecture du suivi carte impossible : " + safeMessage(error));
            return null;
        }

        if (expected == null) {
            loseCard("NOT_TRACKING", "Carte non detectee dans l'image courante.");
            return null;
        }
        currentCardTrackingMethod = expected.getTrackingMethod().name();
        if (expected.getTrackingState() != TrackingState.TRACKING
                || expected.getTrackingMethod() != AugmentedImage.TrackingMethod.FULL_TRACKING) {
            loseCard(currentCardTrackingMethod,
                    "Carte non suivie par l'image courante (" + currentCardTrackingMethod + ").");
            return null;
        }

        float extentX = expected.getExtentX();
        float extentZ = expected.getExtentZ();
        if (!(extentX > 0) || Math.abs(extentX - CardGeometry.CARD_WIDTH_M)
                / CardGeometry.CARD_WIDTH_M > 0.20
                || !(extentZ > 0) || Math.abs(extentZ - CardGeometry.CARD_HEIGHT_M)
                / CardGeometry.CARD_HEIGHT_M > 0.25) {
            loseCard("FULL_TRACKING", "Dimensions ARCore de la carte incoherentes.");
            return null;
        }

        CameraIntrinsics intrinsics = frame.getCamera().getImageIntrinsics();
        int[] dimensions = intrinsics == null ? null : intrinsics.getImageDimensions();
        float[] focal = intrinsics == null ? null : intrinsics.getFocalLength();
        float[] principal = intrinsics == null ? null : intrinsics.getPrincipalPoint();
        if (dimensions == null || dimensions.length < 2 || focal == null || focal.length < 2
                || principal == null || principal.length < 2) {
            loseCard("FULL_TRACKING", "Intrinseques photo indisponibles pour la carte.");
            return null;
        }

        Pose cameraFromCard = frame.getCamera().getPose().inverse().compose(expected.getCenterPose());
        CardGeometry.Result measured = CardGeometry.measure(
                cameraFromCard.getTranslation(), cameraFromCard.getRotationQuaternion(),
                focal[0], focal[1], principal[0], principal[1],
                dimensions[0], dimensions[1]);
        if (!measured.ok) {
            loseCard("FULL_TRACKING", measured.note);
            return null;
        }

        currentCardTrackingMethod = "FULL_TRACKING";
        currentCardNote = measured.note;
        currentCardMeasurement = measured;
        currentCardFrameTimestamp = frame.getTimestamp();
        cardTracking.observe(measured, now);
        return measured;
    }

    private void loseCard(String method, String note) {
        cardTracking.lost();
        currentCardMeasurement = null;
        currentCardFrameTimestamp = Long.MIN_VALUE;
        currentCardTrackingMethod = method == null ? "NOT_TRACKING" : method;
        currentCardNote = note == null ? "Carte non detectee." : note;
    }

    private void renderCardStatus(long now, MeasurePacket packet) {
        String debug = packet == null ? null : packet.debug;
        if (!cardSetupError.isEmpty()) {
            setStatus(cardSetupError + " La photo seule reste disponible.", false, debug);
            return;
        }
        if (currentCardMeasurement == null) {
            String guide = "NOT_TRACKING".equals(currentCardTrackingMethod)
                    ? " Approche jusqu'a ce qu'elle occupe environ 1/4 du cadre, puis recule sans la perdre."
                    : " Garde toute la carte visible, a plat sur la table.";
            setStatus(currentCardNote + guide,
                    false, debug);
            return;
        }
        int count = cardTracking.observations(now);
        if (!cardTracking.ready(now)) {
            setStatus("Carte detectee : stabilisation " + count + " / "
                            + CardTrackingGate.REQUIRED_OBSERVATIONS + ". Ne la masque pas.",
                    false, debug);
            return;
        }
        String depth = depthModeSupported && measurementReady(now)
                ? " La profondeur est aussi stable et sera recoupee a la capture."
                : " L'echelle carte fonctionne meme sans profondeur fiable.";
        setStatus("Carte stable : champ estime a "
                        + Math.round(currentCardMeasurement.fieldWidthCm) + " x "
                        + Math.round(currentCardMeasurement.fieldHeightCm)
                        + " cm. Garde 50-75 cm de recul avec carte et repas visibles."
                        + depth,
                true, debug);
    }

    /** Raw, confiance et dense sont acquis depuis le meme Frame et toujours fermes ensemble. */
    private MeasurePacket measureOnce(Frame frame) {
        Image raw = null;
        Image confidence = null;
        Image dense = null;
        try {
            raw = frame.acquireRawDepthImage16Bits();
            confidence = frame.acquireRawDepthConfidenceImage();
            long timestamp = raw.getTimestamp();
            if (timestamp != frame.getTimestamp()
                    || confidence.getTimestamp() != timestamp
                    || timestamp == lastProcessedDepthTimestamp) {
                return new MeasurePacket(null, "carte brute ancienne/desynchronisee");
            }
            lastProcessedDepthTimestamp = timestamp;
            try {
                dense = frame.acquireDepthImage16Bits();
                if (dense.getTimestamp() != frame.getTimestamp()) {
                    dense.close();
                    dense = null;
                }
            } catch (NotYetAvailableException ignored) {
                dense = null;
            }

            rawCenter = DepthMeasure.rawCenter(raw, confidence);
            DepthMeasure.Result result = DepthMeasure.measure(frame, raw, confidence, dense);
            return new MeasurePacket(result, "centre " + rawCenter + " | " + result.diag);
        } catch (NotYetAvailableException e) {
            return null;
        } catch (RuntimeException e) {
            return new MeasurePacket(null, "profondeur refusee : " + safeMessage(e));
        } finally {
            if (dense != null) dense.close();
            if (confidence != null) confidence.close();
            if (raw != null) raw.close();
        }
    }

    private void updateBaseline(float[] pose) {
        if (pose == null || pose.length < 3) return;
        if (baselineOrigin == null) {
            baselineOrigin = pose.clone();
            return;
        }
        maxBaselineM = Math.max(maxBaselineM, distance(baselineOrigin, pose));
    }

    private void addObservation(DepthMeasure.Result result, float[] pose, long now) {
        if (result == null || !result.scaleOk || pose == null || pose.length < 3) return;
        synchronized (observationLock) {
            pruneObservations(now);
            for (Observation observation : observations) {
                if (distance(observation.pose, pose) < MIN_OBSERVATION_SEPARATION_M) return;
            }
            observations.add(new Observation(result, pose.clone(), now));
            while (observations.size() > MAX_OBSERVATIONS) observations.remove(0);
            lastValidObservationAt = now;
        }
    }

    private boolean measurementReady(long now) {
        if (maxBaselineM < MIN_BASELINE_M) return false;
        synchronized (observationLock) {
            pruneObservations(now);
            if (observations.size() < REQUIRED_OBSERVATIONS
                    || now - lastValidObservationAt > READY_MAX_AGE_MS) return false;
            int count = observations.size();
            double[] distances = new double[count];
            double[] fields = new double[count];
            for (int i = 0; i < count; i++) {
                distances[i] = observations.get(i).result.distanceCm / 100.0;
                fields[i] = observations.get(i).result.fieldWidthCm / 100.0;
            }
            return DepthGeometry.observationsStable(distances, fields, count, 0.025, 0.05);
        }
    }

    private DepthMeasure.Result stableResult(long now) {
        synchronized (observationLock) {
            pruneObservations(now);
            return observations.isEmpty() ? lastFailure : observations.get(observations.size() - 1).result;
        }
    }

    /** La mesure du Frame photographie doit rejoindre les quatre observations stables. */
    private boolean candidateCompatible(DepthMeasure.Result candidate, long now) {
        if (candidate == null || !candidate.scaleOk) return false;
        synchronized (observationLock) {
            pruneObservations(now);
            if (observations.size() < REQUIRED_OBSERVATIONS) return false;
            int start = observations.size() - REQUIRED_OBSERVATIONS;
            double[] distances = new double[REQUIRED_OBSERVATIONS];
            double[] fields = new double[REQUIRED_OBSERVATIONS];
            for (int i = 0; i < REQUIRED_OBSERVATIONS; i++) {
                DepthMeasure.Result result = observations.get(start + i).result;
                distances[i] = result.distanceCm / 100.0;
                fields[i] = result.fieldWidthCm / 100.0;
            }
            java.util.Arrays.sort(distances);
            java.util.Arrays.sort(fields);
            double distanceMedian = (distances[1] + distances[2]) / 2.0;
            double fieldMedian = (fields[1] + fields[2]) / 2.0;
            return Math.abs(candidate.distanceCm / 100.0 - distanceMedian) <= 0.025
                    && Math.abs(candidate.fieldWidthCm / 100.0 - fieldMedian) / fieldMedian <= 0.05;
        }
    }

    private int observationCount(long now) {
        synchronized (observationLock) {
            pruneObservations(now);
            return Math.min(REQUIRED_OBSERVATIONS, observations.size());
        }
    }

    private String stableDebug(long now) {
        DepthMeasure.Result result = stableResult(now);
        return result == null ? null : result.diag;
    }

    private void pruneObservations(long now) {
        while (!observations.isEmpty()
                && now - observations.get(0).atMs > OBSERVATION_MAX_AGE_MS) {
            observations.remove(0);
        }
    }

    private void resetTrackingState() {
        baselineOrigin = null;
        maxBaselineM = 0;
        lastProcessedDepthTimestamp = Long.MIN_VALUE;
        lastValidObservationAt = 0;
        lastFailure = null;
        synchronized (observationLock) {
            observations.clear();
        }
        resetCardTracking("Carte non detectee.");
    }

    private void resetCardTracking(String note) {
        cardTracking.lost();
        currentCardMeasurement = null;
        currentCardFrameTimestamp = Long.MIN_VALUE;
        currentCardTrackingMethod = "NOT_TRACKING";
        currentCardNote = note == null ? "Carte non detectee." : note;
    }

    private void requestCapture() {
        if (capturePending || finishing.get()) return;
        long now = SystemClock.elapsedRealtime();
        captureWantsScale = cardMode ? cardTracking.ready(now) : measurementReady(now);
        capturePending = true;
        captureDeadline = now + (captureWantsScale ? DEPTH_CAPTURE_WAIT_MS : PHOTO_CAPTURE_WAIT_MS);
        captureGiveUp = captureDeadline + PHOTO_GIVE_UP_EXTRA_MS;
        captureButton.setEnabled(false);
        captureButton.setText(captureWantsScale
                ? (cardMode ? "Verification carte..." : "Synchronisation...")
                : "Photo...");
    }

    /** Capture la photo du meme Frame que la mesure retenue, sinon une photo seule. */
    private boolean tryFinishPhoto(
            Frame frame, DepthMeasure.Result measurement,
            CardGeometry.Result cardMeasurement, long now) {
        Image camera = null;
        try {
            camera = frame.acquireCameraImage();
            if (camera.getTimestamp() != frame.getAndroidCameraTimestamp()) {
                if (now >= captureGiveUp) failOnUi("Photo camera desynchronisee du Frame ARCore.");
                return false;
            }
            Rect crop = camera.getCropRect();
            boolean fullCrop = crop.left == 0 && crop.top == 0
                    && crop.width() == camera.getWidth() && crop.height() == camera.getHeight();
            if (measurement != null && (camera.getWidth() != measurement.sourceImageWidthPx
                    || camera.getHeight() != measurement.sourceImageHeightPx || !fullCrop)) {
                // La photo reste valable, mais l'echelle calculee pour un autre
                // cadrage ne doit pas voyager avec elle.
                measurement = null;
            }
            boolean cardVerified = cardMode && cardMeasurement != null
                    && currentCardFrameTimestamp == frame.getTimestamp()
                    && cardTracking.ready(now)
                    && camera.getWidth() == cardMeasurement.sourceImageWidthPx
                    && camera.getHeight() == cardMeasurement.sourceImageHeightPx
                    && fullCrop;
            if (cardMode && !cardVerified) {
                cardMeasurement = null;
                // En mode carte, une profondeur seule n'est jamais promue si la
                // carte demandee n'est plus visible sur CETTE photo.
                measurement = null;
            }

            boolean depthCompared = cardVerified && measurement != null && measurement.scaleOk;
            boolean depthAgrees = depthCompared && CardGeometry.agreesWithDepth(
                    cardMeasurement,
                    measurement.fieldWidthCm, measurement.fieldHeightCm, measurement.distanceCm,
                    measurement.planeA, measurement.planeB,
                    CARD_DEPTH_MAX_RELATIVE_FIELD_ERROR,
                    CARD_DEPTH_MAX_DISTANCE_ERROR_CM,
                    CARD_DEPTH_MAX_NORMAL_ANGLE_DEG);
            int cardObservations = cardVerified ? cardTracking.observations(now) : 0;
            int rotation = jpegRotationDegrees();
            JpegData jpeg = toJpeg(camera, rotation);
            if (jpeg == null || jpeg.bytes.length == 0) throw new IOException("image YUV illisible");
            File path = writeTemporaryJpeg(jpeg.bytes);

            DepthMeasure.Result output;
            CardCaptureInfo cardInfo;
            if (cardMode && cardVerified) {
                cardMeasurement.orientForPhoto(rotation, jpeg.width, jpeg.height);
                if (measurement != null && measurement.scaleOk) {
                    measurement.orientForPhoto(rotation, jpeg.width, jpeg.height);
                }
                output = buildCardScale(
                        cardMeasurement, measurement, depthCompared, depthAgrees, cardObservations);
                cardInfo = CardCaptureInfo.verified(
                        cardMeasurement, cardObservations, depthCompared, depthAgrees, output.note);
            } else {
                if (measurement != null && measurement.scaleOk) {
                    measurement.observations = observationCount(now);
                    measurement.parallaxCm = maxBaselineM * 100.0;
                    measurement.fresh = true;
                    measurement.orientForPhoto(rotation, jpeg.width, jpeg.height);
                }
                output = measurement;
                cardInfo = CardCaptureInfo.unverified(
                        cardMode, currentCardTrackingMethod,
                        cardSetupError.isEmpty() ? currentCardNote : cardSetupError);
            }
            if (!finishing.compareAndSet(false, true)) {
                //noinspection ResultOfMethodCallIgnored
                path.delete();
                return true;
            }
            capturePending = false;
            runOnUiThread(() -> deliver(path, output, cardInfo, jpeg.width, jpeg.height));
            return true;
        } catch (NotYetAvailableException e) {
            if (now >= captureGiveUp) failOnUi("La camera n'a pas fourni de photo a temps.");
            return false;
        } catch (Exception e) {
            failOnUi("Capture impossible : " + safeMessage(e));
            return true;
        } finally {
            if (camera != null) camera.close();
        }
    }

    private DepthMeasure.Result buildCardScale(
            CardGeometry.Result card, DepthMeasure.Result depth,
            boolean depthCompared, boolean depthAgrees, int cardObservations) {
        DepthMeasure.Result out = new DepthMeasure.Result();
        out.scaleOk = true;
        out.fresh = true;
        out.fieldWidthCm = card.fieldWidthCm;
        out.fieldHeightCm = card.fieldHeightCm;
        out.distanceCm = card.distanceCm;
        out.cmPerPixel = card.cmPerPixel;
        out.planeA = card.planeA;
        out.planeB = card.planeB;
        out.sourceImageWidthPx = card.sourceImageWidthPx;
        out.sourceImageHeightPx = card.sourceImageHeightPx;
        out.observations = cardObservations;

        if (depthCompared && depthAgrees && depth != null) {
            out.ok = depth.ok;
            out.volumeCm3 = depth.volumeCm3;
            out.areaCm2 = depth.areaCm2;
            out.heightMaxCm = depth.heightMaxCm;
            out.heightMeanCm = depth.heightMeanCm;
            out.samples = depth.samples;
            out.confidentPixels = depth.confidentPixels;
            out.coverage = depth.coverage;
            out.parallaxCm = depth.parallaxCm > 0 ? depth.parallaxCm : maxBaselineM * 100.0;
            out.diag = "carte+depth | " + depth.diag;
            out.note = depth.ok
                    ? "Echelle carte verifiee. Profondeur concordante ; relief experimental disponible."
                    : "Echelle carte verifiee. Profondeur concordante, relief non retenu.";
        } else if (depthCompared) {
            // L'echelle carte reste valide, mais aucune valeur Depth en desaccord
            // ne peut activer le relief ni remplacer cette echelle.
            out.ok = false;
            out.diag = "carte valide | depth en desaccord";
            out.note = "Echelle carte verifiee. Profondeur en desaccord, donc relief refuse.";
        } else {
            out.ok = false;
            out.diag = "carte valide | depth indisponible";
            out.note = "Echelle carte verifiee. Profondeur indisponible ou non stabilisee.";
        }
        return out;
    }

    private void deliver(
            File jpeg, DepthMeasure.Result result, CardCaptureInfo card,
            int photoWidthPx, int photoHeightPx) {
        Intent out = new Intent();
        out.putExtra("jpegPath", jpeg.getAbsolutePath());
        out.putExtra("photoWidthPx", photoWidthPx);
        out.putExtra("photoHeightPx", photoHeightPx);
        boolean scaleOk = result != null && result.scaleOk;
        boolean volumeOk = result != null && result.ok;
        out.putExtra("scaleOk", scaleOk);
        out.putExtra("depthOk", volumeOk);
        out.putExtra("volumeOk", volumeOk);
        out.putExtra("volumeCm3", volumeOk ? result.volumeCm3 : 0);
        out.putExtra("areaCm2", volumeOk ? result.areaCm2 : 0);
        out.putExtra("heightMaxCm", volumeOk ? result.heightMaxCm : 0);
        out.putExtra("heightMeanCm", volumeOk ? result.heightMeanCm : 0);
        out.putExtra("distanceCm", scaleOk ? result.distanceCm : 0);
        out.putExtra("fieldWidthCm", scaleOk ? result.fieldWidthCm : 0);
        out.putExtra("fieldHeightCm", scaleOk ? result.fieldHeightCm : 0);
        out.putExtra("cmPerPixel", scaleOk ? result.cmPerPixel : 0);
        out.putExtra("samples", result == null ? 0 : result.samples);
        out.putExtra("confidentPixels", result == null ? 0 : result.confidentPixels);
        out.putExtra("coverage", result == null ? 0 : result.coverage);
        out.putExtra("observations", result == null ? 0 : result.observations);
        out.putExtra("parallaxCm", result == null ? 0 : result.parallaxCm);
        out.putExtra("fresh", result != null && result.fresh);
        out.putExtra("scaleSource", scaleOk
                ? (card.verified
                    ? (card.depthCompared && card.depthAgrees ? "card+depth" : "card")
                    : "depth")
                : "none");
        out.putExtra("cardRequested", card.requested);
        out.putExtra("cardVerified", card.verified);
        out.putExtra("cardFresh", card.fresh);
        out.putExtra("cardName", CARD_NAME);
        out.putExtra("cardSchema", CARD_SCHEMA);
        out.putExtra("cardWidthCm", card.verified ? CardGeometry.CARD_WIDTH_M * 100.0 : 0);
        out.putExtra("cardHeightCm", card.verified ? CardGeometry.CARD_HEIGHT_M * 100.0 : 0);
        out.putExtra("cardDistanceCm", card.verified ? card.distanceCm : 0);
        out.putExtra("cardFieldWidthCm", card.verified ? card.fieldWidthCm : 0);
        out.putExtra("cardFieldHeightCm", card.verified ? card.fieldHeightCm : 0);
        out.putExtra("cardCmPerPixel", card.verified ? card.cmPerPixel : 0);
        out.putExtra("cardIncidenceDeg", card.verified ? card.incidenceDeg : 0);
        out.putExtra("cardTrackingMethod", card.trackingMethod);
        out.putExtra("cardObservations", card.verified ? card.observations : 0);
        out.putExtra("cardDepthCompared", card.depthCompared);
        out.putExtra("cardDepthAgrees", card.depthAgrees);
        out.putExtra("cardNote", card.note);
        out.putExtra("note", result == null
                ? (card.requested
                    ? "Photo conservee sans mesure : carte non verifiee sur la Frame capturee."
                    : "Photo conservee sans mesure de profondeur.")
                : result.note);
        out.putExtra("diag", result == null ? "" : result.diag);
        setResult(RESULT_OK, out);
        finish();
    }

    private int jpegRotationDegrees() {
        int displayDegrees;
        switch (displayRotation) {
            case Surface.ROTATION_90: displayDegrees = 90; break;
            case Surface.ROTATION_180: displayDegrees = 180; break;
            case Surface.ROTATION_270: displayDegrees = 270; break;
            default: displayDegrees = 0;
        }
        if (lensFacing == CameraCharacteristics.LENS_FACING_FRONT) {
            return (sensorOrientation + displayDegrees) % 360;
        }
        return (sensorOrientation - displayDegrees + 360) % 360;
    }

    /** YUV_420_888 vers NV21 en respectant rowStride ET pixelStride de chaque plan. */
    private static JpegData toJpeg(Image image, int rotationDegrees) throws IOException {
        if (image.getFormat() != ImageFormat.YUV_420_888 || image.getPlanes().length < 3) return null;
        Rect crop = image.getCropRect();
        int width = crop.width();
        int height = crop.height();
        if (width <= 0 || height <= 0 || (width & 1) != 0 || (height & 1) != 0
                || (crop.left & 1) != 0 || (crop.top & 1) != 0) return null;
        byte[] nv21 = new byte[width * height * 3 / 2];

        copyLuma(image.getPlanes()[0], crop, width, height, nv21);
        copyChroma(image.getPlanes()[1], image.getPlanes()[2], crop, width, height, nv21);

        ByteArrayOutputStream encoded = new ByteArrayOutputStream();
        boolean compressed = new YuvImage(nv21, ImageFormat.NV21, width, height, null)
                .compressToJpeg(new Rect(0, 0, width, height), JPEG_QUALITY, encoded);
        if (!compressed) throw new IOException("compression JPEG refusee");
        byte[] original = encoded.toByteArray();

        int normalized = ((rotationDegrees % 360) + 360) % 360;
        int rotatedWidth = (normalized == 90 || normalized == 270) ? height : width;
        int rotatedHeight = (normalized == 90 || normalized == 270) ? width : height;
        if (normalized == 0 && Math.max(width, height) <= MAX_PHOTO_EDGE) {
            return new JpegData(original, width, height);
        }

        Bitmap source = BitmapFactory.decodeByteArray(original, 0, original.length);
        if (source == null) throw new IOException("decodage JPEG impossible");
        Bitmap rotated = source;
        if (normalized != 0) {
            Matrix matrix = new Matrix();
            matrix.postRotate(normalized);
            rotated = Bitmap.createBitmap(source, 0, 0, source.getWidth(), source.getHeight(), matrix, true);
        }
        Bitmap output = rotated;
        int largest = Math.max(rotated.getWidth(), rotated.getHeight());
        if (largest > MAX_PHOTO_EDGE) {
            double scale = (double) MAX_PHOTO_EDGE / largest;
            output = Bitmap.createScaledBitmap(rotated,
                    Math.max(1, (int) Math.round(rotated.getWidth() * scale)),
                    Math.max(1, (int) Math.round(rotated.getHeight() * scale)), true);
        }

        ByteArrayOutputStream finalBytes = new ByteArrayOutputStream();
        if (!output.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, finalBytes)) {
            recycleDistinct(source, rotated, output);
            throw new IOException("compression finale impossible");
        }
        int outputWidth = output.getWidth();
        int outputHeight = output.getHeight();
        byte[] bytes = finalBytes.toByteArray();
        recycleDistinct(source, rotated, output);
        if (outputWidth <= 0 || outputHeight <= 0) {
            outputWidth = rotatedWidth;
            outputHeight = rotatedHeight;
        }
        return new JpegData(bytes, outputWidth, outputHeight);
    }

    private static void copyLuma(Image.Plane yPlane, Rect crop, int width, int height, byte[] out)
            throws IOException {
        ByteBuffer buffer = yPlane.getBuffer().duplicate();
        int base = buffer.position();
        int rowStride = yPlane.getRowStride();
        int pixelStride = yPlane.getPixelStride();
        int target = 0;
        for (int y = 0; y < height; y++) {
            int row = base + (crop.top + y) * rowStride + crop.left * pixelStride;
            for (int x = 0; x < width; x++) {
                out[target++] = getByte(buffer, row + x * pixelStride);
            }
        }
    }

    private static void copyChroma(
            Image.Plane uPlane, Image.Plane vPlane, Rect crop,
            int width, int height, byte[] out) throws IOException {
        ByteBuffer u = uPlane.getBuffer().duplicate();
        ByteBuffer v = vPlane.getBuffer().duplicate();
        int uBase = u.position(), vBase = v.position();
        int target = width * height;
        int chromaLeft = crop.left / 2;
        int chromaTop = crop.top / 2;
        for (int y = 0; y < height / 2; y++) {
            int uRow = uBase + (chromaTop + y) * uPlane.getRowStride()
                    + chromaLeft * uPlane.getPixelStride();
            int vRow = vBase + (chromaTop + y) * vPlane.getRowStride()
                    + chromaLeft * vPlane.getPixelStride();
            for (int x = 0; x < width / 2; x++) {
                out[target++] = getByte(v, vRow + x * vPlane.getPixelStride());
                out[target++] = getByte(u, uRow + x * uPlane.getPixelStride());
            }
        }
    }

    private static byte getByte(ByteBuffer buffer, int index) throws IOException {
        if (index < buffer.position() || index >= buffer.limit()) {
            throw new IOException("stride YUV hors limites");
        }
        return buffer.get(index);
    }

    private static void recycleDistinct(Bitmap a, Bitmap b, Bitmap c) {
        if (c != null && c != b && c != a) c.recycle();
        if (b != null && b != a) b.recycle();
        if (a != null) a.recycle();
    }

    private File writeTemporaryJpeg(byte[] bytes) throws IOException {
        File dir = new File(getCacheDir(), "depth-scan");
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("cache photo inaccessible");
        File file = File.createTempFile("scan-", ".jpg", dir);
        boolean written = false;
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(bytes);
            out.flush();
            written = true;
            return file;
        } finally {
            if (!written) {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
            }
        }
    }

    private void setStatus(String message, boolean ready, String debug) {
        runOnUiThread(() -> {
            if (isFinishing()) return;
            statusView.setText(message);
            if (debug != null) debugView.setText(debug);
            if (!capturePending) {
                captureButton.setEnabled(true);
                captureButton.setText(ready
                        ? (cardMode ? "Capturer avec la carte" : "Capturer avec l'echelle")
                        : "Capturer la photo seule");
            }
        });
    }

    private void failOnUi(String message) {
        runOnUiThread(() -> fail(message));
    }

    private void fail(String message) {
        if (!finishing.compareAndSet(false, true)) return;
        Intent out = new Intent();
        out.putExtra("error", message);
        setResult(RESULT_CANCELED, out);
        finish();
    }

    private static String safeMessage(Throwable error) {
        String message = error == null ? null : error.getMessage();
        return message == null || message.trim().isEmpty()
                ? (error == null ? "erreur inconnue" : error.getClass().getSimpleName())
                : message;
    }

    private static double distance(float[] a, float[] b) {
        double dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    private static final class Observation {
        final DepthMeasure.Result result;
        final float[] pose;
        final long atMs;

        Observation(DepthMeasure.Result result, float[] pose, long atMs) {
            this.result = result;
            this.pose = pose;
            this.atMs = atMs;
        }
    }

    private static final class MeasurePacket {
        final DepthMeasure.Result result;
        final String debug;

        MeasurePacket(DepthMeasure.Result result, String debug) {
            this.result = result;
            this.debug = debug;
        }
    }

    private static final class CardCaptureInfo {
        final boolean requested;
        final boolean verified;
        final boolean fresh;
        final double distanceCm;
        final double fieldWidthCm;
        final double fieldHeightCm;
        final double cmPerPixel;
        final double incidenceDeg;
        final String trackingMethod;
        final int observations;
        final boolean depthCompared;
        final boolean depthAgrees;
        final String note;

        private CardCaptureInfo(
                boolean requested, boolean verified, boolean fresh,
                double distanceCm, double fieldWidthCm, double fieldHeightCm,
                double cmPerPixel, double incidenceDeg, String trackingMethod,
                int observations, boolean depthCompared, boolean depthAgrees,
                String note) {
            this.requested = requested;
            this.verified = verified;
            this.fresh = fresh;
            this.distanceCm = distanceCm;
            this.fieldWidthCm = fieldWidthCm;
            this.fieldHeightCm = fieldHeightCm;
            this.cmPerPixel = cmPerPixel;
            this.incidenceDeg = incidenceDeg;
            this.trackingMethod = trackingMethod;
            this.observations = observations;
            this.depthCompared = depthCompared;
            this.depthAgrees = depthAgrees;
            this.note = note == null ? "" : note;
        }

        static CardCaptureInfo verified(
                CardGeometry.Result card, int observations,
                boolean depthCompared, boolean depthAgrees, String note) {
            return new CardCaptureInfo(
                    true, true, true,
                    card.centerDistanceCm, card.fieldWidthCm, card.fieldHeightCm,
                    card.cmPerPixel, card.incidenceDeg, "FULL_TRACKING",
                    observations, depthCompared, depthAgrees, note);
        }

        static CardCaptureInfo unverified(boolean requested, String method, String note) {
            return new CardCaptureInfo(
                    requested, false, false, 0, 0, 0, 0, 0,
                    method == null ? "NOT_TRACKING" : method,
                    0, false, false, note);
        }
    }

    private static final class JpegData {
        final byte[] bytes;
        final int width;
        final int height;

        JpegData(byte[] bytes, int width, int height) {
            this.bytes = bytes;
            this.width = width;
            this.height = height;
        }
    }

    /** Repere visible correspondant aux zones centre/table utilisees par la mesure. */
    private static final class GuideOverlay extends View {
        private final Paint outer = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint center = new Paint(Paint.ANTI_ALIAS_FLAG);

        GuideOverlay(Context context) {
            super(context);
            setClickable(false);
            outer.setStyle(Paint.Style.STROKE);
            outer.setStrokeWidth(3f);
            outer.setColor(Color.argb(190, 255, 255, 255));
            center.setStyle(Paint.Style.STROKE);
            center.setStrokeWidth(4f);
            center.setColor(Color.argb(220, 20, 184, 166));
        }

        @Override
        protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            float w = getWidth(), h = getHeight();
            float side = Math.min(w * 0.90f, h * 0.58f);
            float left = (w - side) / 2f;
            float top = (h - side) / 2f - h * 0.04f;
            canvas.drawRect(left, top, left + side, top + side, outer);
            float inner = side * 0.58f;
            float il = (w - inner) / 2f;
            float it = top + (side - inner) / 2f;
            canvas.drawRect(il, it, il + inner, it + inner, center);
        }
    }
}
