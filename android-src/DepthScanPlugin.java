package io.github.rachid598.glucovision;

import android.content.Intent;
import android.app.Activity;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.ar.core.ArCoreApk;

/**
 * Pont vers la mesure de profondeur ARCore.
 *
 * Pourquoi ce plugin existe : sur une photo unique vue de dessus, la hauteur des
 * aliments n'est pas visible. C'est, de l'aveu même du prompt de l'application,
 * la principale inconnue géométrique — et donc la principale source d'erreur sur
 * une portion. L'API Depth d'ARCore la mesure, ce qui donne en prime l'échelle
 * absolue : plus besoin d'un objet-repère dans le cadre.
 *
 * Tout est facultatif. Si ARCore manque, si l'appareil n'est pas certifié, ou si
 * la mesure échoue, l'appelant retombe sur la prise de photo normale.
 */
@CapacitorPlugin(name = "DepthScan")
public class DepthScanPlugin extends Plugin {

    /**
     * ARCore est-il utilisable ici ? checkAvailability peut renvoyer un état
     * transitoire pendant que les services se réveillent : on laisse une courte
     * fenêtre plutôt que de conclure « non supporté » sur une réponse pas encore
     * arrêtée, ce qui masquerait la fonctionnalité sur un appareil compatible.
     */
    @PluginMethod
    public void available(final PluginCall call) {
        ArCoreApk.Availability av = ArCoreApk.getInstance().checkAvailability(getContext());
        long deadline = System.currentTimeMillis() + 800;
        while (av.isTransient() && System.currentTimeMillis() < deadline) {
            try { Thread.sleep(150); } catch (InterruptedException e) { break; }
            av = ArCoreApk.getInstance().checkAvailability(getContext());
        }
        JSObject ret = new JSObject();
        ret.put("supported", av.isSupported());
        ret.put("installed", av == ArCoreApk.Availability.SUPPORTED_INSTALLED);
        ret.put("reason", av.name());
        call.resolve(ret);
    }

    /** Ouvre l'écran de visée, rend la main quand l'utilisateur a capturé. */
    @PluginMethod
    public void capture(PluginCall call) {
        Intent intent = new Intent(getContext(), DepthScanActivity.class);
        startActivityForResult(call, intent, "captureResult");
    }

    @ActivityCallback
    private void captureResult(PluginCall call, ActivityResult result) {
        if (call == null) return;

        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null) {
            JSObject ret = new JSObject();
            ret.put("cancelled", true);
            // Une erreur technique doit remonter telle quelle : sans elle,
            // l'utilisateur ne voit qu'un écran qui se ferme sans rien dire.
            if (data != null && data.hasExtra("error")) {
                ret.put("error", data.getStringExtra("error"));
                ret.put("cancelled", false);
            }
            call.resolve(ret);
            return;
        }

        JSObject ret = new JSObject();
        ret.put("cancelled", false);
        ret.put("jpegBase64", data.getStringExtra("jpegBase64"));
        ret.put("depthOk", data.getBooleanExtra("depthOk", false));
        ret.put("volumeCm3", data.getDoubleExtra("volumeCm3", 0));
        ret.put("areaCm2", data.getDoubleExtra("areaCm2", 0));
        ret.put("heightMaxCm", data.getDoubleExtra("heightMaxCm", 0));
        ret.put("heightMeanCm", data.getDoubleExtra("heightMeanCm", 0));
        ret.put("distanceCm", data.getDoubleExtra("distanceCm", 0));
        ret.put("cmPerPixel", data.getDoubleExtra("cmPerPixel", 0));
        ret.put("samples", data.getIntExtra("samples", 0));
        ret.put("note", data.getStringExtra("note"));
        call.resolve(ret);
    }
}
