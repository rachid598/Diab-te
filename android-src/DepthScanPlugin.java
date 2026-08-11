package io.github.rachid598.glucovision;

import android.app.Activity;
import android.content.Intent;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.ar.core.ArCoreApk;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;

/** Pont Capacitor vers l'ecran ARCore, entierement facultatif. */
@CapacitorPlugin(name = "DepthScan")
public class DepthScanPlugin extends Plugin {
    private static final long MAX_JPEG_BYTES = 12L * 1024L * 1024L;

    /**
     * La verification synchrone peut interroger un service distant. Elle ne doit
     * jamais bloquer le thread principal de la WebView : ARCore garantit ici un
     * callback asynchrone, lui-meme rappele sur le thread principal.
     */
    @PluginMethod
    public void available(final PluginCall call) {
        try {
            ArCoreApk.getInstance().checkAvailabilityAsync(getContext(), availability -> {
                /* checkAvailabilityAsync ne renvoie jamais UNKNOWN_CHECKING, mais
                   UNKNOWN_ERROR/TIMED_OUT restent retentables. Les rejeter permet
                   au cache JS d'oublier la promesse et de refaire un essai. */
                if (availability.isUnknown() || availability.isTransient()) {
                    call.reject("Disponibilite ARCore temporairement inconnue ("
                            + availability.name() + ").");
                    return;
                }
                JSObject ret = new JSObject();
                ret.put("supported", availability.isSupported());
                ret.put("installed", availability == ArCoreApk.Availability.SUPPORTED_INSTALLED);
                ret.put("reason", availability.name());
                call.resolve(ret);
            });
        } catch (RuntimeException e) {
            call.reject("Verification ARCore impossible : "
                    + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
        }
    }

    @PluginMethod
    public void capture(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activite Android indisponible.");
            return;
        }
        Intent intent = new Intent(activity, DepthScanActivity.class);
        /* Le mode carte est une intention native explicite. L'activite ne le
           deduit jamais d'un prompt ni du contenu renvoye par un modele. */
        intent.putExtra("cardMode", Boolean.TRUE.equals(call.getBoolean("cardMode", false)));
        startActivityForResult(call, intent, "captureResult");
    }

    @ActivityCallback
    private void captureResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null) {
            JSObject ret = new JSObject();
            String error = data == null ? null : data.getStringExtra("error");
            ret.put("cancelled", error == null);
            if (error != null) ret.put("error", error);
            call.resolve(ret);
            return;
        }

        File jpeg = null;
        try {
            jpeg = validatedResultFile(data.getStringExtra("jpegPath"));
            byte[] bytes = readBounded(jpeg);
            JSObject ret = new JSObject();
            ret.put("cancelled", false);
            ret.put("jpegBase64", Base64.encodeToString(bytes, Base64.NO_WRAP));
            ret.put("photoWidthPx", data.getIntExtra("photoWidthPx", 0));
            ret.put("photoHeightPx", data.getIntExtra("photoHeightPx", 0));
            ret.put("depthOk", data.getBooleanExtra("depthOk", false));
            ret.put("volumeOk", data.getBooleanExtra("volumeOk", false));
            ret.put("scaleOk", data.getBooleanExtra("scaleOk", false));
            ret.put("volumeCm3", data.getDoubleExtra("volumeCm3", 0));
            ret.put("areaCm2", data.getDoubleExtra("areaCm2", 0));
            ret.put("heightMaxCm", data.getDoubleExtra("heightMaxCm", 0));
            ret.put("heightMeanCm", data.getDoubleExtra("heightMeanCm", 0));
            ret.put("distanceCm", data.getDoubleExtra("distanceCm", 0));
            ret.put("fieldWidthCm", data.getDoubleExtra("fieldWidthCm", 0));
            ret.put("fieldHeightCm", data.getDoubleExtra("fieldHeightCm", 0));
            ret.put("cmPerPixel", data.getDoubleExtra("cmPerPixel", 0));
            ret.put("samples", data.getIntExtra("samples", 0));
            ret.put("confidentPixels", data.getIntExtra("confidentPixels", 0));
            ret.put("coverage", data.getDoubleExtra("coverage", 0));
            ret.put("observations", data.getIntExtra("observations", 0));
            ret.put("parallaxCm", data.getDoubleExtra("parallaxCm", 0));
            ret.put("fresh", data.getBooleanExtra("fresh", false));
            ret.put("scaleSource", data.getStringExtra("scaleSource"));
            ret.put("cardRequested", data.getBooleanExtra("cardRequested", false));
            ret.put("cardVerified", data.getBooleanExtra("cardVerified", false));
            ret.put("cardFresh", data.getBooleanExtra("cardFresh", false));
            ret.put("cardName", data.getStringExtra("cardName"));
            ret.put("cardSchema", data.getStringExtra("cardSchema"));
            ret.put("cardWidthCm", data.getDoubleExtra("cardWidthCm", 0));
            ret.put("cardHeightCm", data.getDoubleExtra("cardHeightCm", 0));
            ret.put("cardDistanceCm", data.getDoubleExtra("cardDistanceCm", 0));
            ret.put("cardFieldWidthCm", data.getDoubleExtra("cardFieldWidthCm", 0));
            ret.put("cardFieldHeightCm", data.getDoubleExtra("cardFieldHeightCm", 0));
            ret.put("cardCmPerPixel", data.getDoubleExtra("cardCmPerPixel", 0));
            ret.put("cardIncidenceDeg", data.getDoubleExtra("cardIncidenceDeg", 0));
            ret.put("cardTrackingMethod", data.getStringExtra("cardTrackingMethod"));
            ret.put("cardObservations", data.getIntExtra("cardObservations", 0));
            ret.put("cardDepthCompared", data.getBooleanExtra("cardDepthCompared", false));
            ret.put("cardDepthAgrees", data.getBooleanExtra("cardDepthAgrees", false));
            ret.put("cardNote", data.getStringExtra("cardNote"));
            ret.put("note", data.getStringExtra("note"));
            ret.put("diag", data.getStringExtra("diag"));
            call.resolve(ret);
        } catch (IOException | SecurityException e) {
            JSObject ret = new JSObject();
            ret.put("cancelled", false);
            ret.put("error", "Photo mesuree illisible : " + e.getMessage());
            call.resolve(ret);
        } finally {
            if (jpeg != null && jpeg.exists()) {
                // Le fichier n'est qu'un passage hors du Binder Android.
                //noinspection ResultOfMethodCallIgnored
                jpeg.delete();
            }
        }
    }

    /**
     * L'Intent d'un resultat d'activite transite par Binder (limite proche de
     * 1 Mo). Seul un petit chemin y voyage ; le JPEG reste dans le cache prive.
     */
    private File validatedResultFile(String path) throws IOException {
        if (path == null || path.isEmpty()) throw new IOException("chemin absent");
        File root = new File(getContext().getCacheDir(), "depth-scan").getCanonicalFile();
        File file = new File(path).getCanonicalFile();
        if (!root.equals(file.getParentFile()) || !file.getName().endsWith(".jpg")) {
            throw new SecurityException("chemin refuse");
        }
        long size = file.length();
        if (!file.isFile() || size <= 0 || size > MAX_JPEG_BYTES) {
            throw new IOException("taille JPEG invalide");
        }
        return file;
    }

    private static byte[] readBounded(File file) throws IOException {
        try (FileInputStream in = new FileInputStream(file);
             ByteArrayOutputStream out = new ByteArrayOutputStream((int) file.length())) {
            byte[] buffer = new byte[32 * 1024];
            int total = 0;
            int n;
            while ((n = in.read(buffer)) != -1) {
                total += n;
                if (total > MAX_JPEG_BYTES) throw new IOException("JPEG trop volumineux");
                out.write(buffer, 0, n);
            }
            return out.toByteArray();
        }
    }
}
