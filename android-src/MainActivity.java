package io.github.rachid598.glucovision;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

/**
 * Remplace le MainActivity généré par Capacitor, à seule fin d'enregistrer le
 * plugin DepthScan. Les plugins déclarés dans le projet de l'application ne sont
 * pas découverts automatiquement — contrairement à ceux installés via npm — et
 * l'appel doit précéder super.onCreate(), sinon le pont JavaScript est déjà
 * construit quand le plugin arrive et l'appel côté web échoue à l'exécution.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DepthScanPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
