package io.github.rachid598.glucovision;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

/** Enregistre le plugin local avant la creation du pont Capacitor. */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DepthScanPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
