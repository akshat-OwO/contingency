package dev.contingency.physicalfixture;

import android.app.Activity;
import android.content.Intent;
import android.util.Log;

/** Signals actual focus for the proof's window transitions, without private text. */
public class FixtureActivity extends Activity {
    private void signalFocus() {
        String token = getIntent().getStringExtra("focus-token");
        if (token != null) Log.i("ContingencyFixture", getClass().getSimpleName() + " focused " + token);
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (getWindow().getDecorView().hasWindowFocus()) signalFocus();
    }

    @Override public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (focused) signalFocus();
    }
}
