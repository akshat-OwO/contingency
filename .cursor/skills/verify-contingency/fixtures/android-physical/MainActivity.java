package dev.contingency.physicalfixture;

import android.os.Bundle;
import android.content.pm.PackageManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

public class MainActivity extends FixtureActivity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(24, 120, 24, 24);
        TextView freshness = new TextView(this);
        freshness.setText(getPreferences(MODE_PRIVATE).getBoolean("dirty", false) ? "Existing fixture data" : "Fresh fixture data");
        content.addView(freshness);
        Button semantic = new Button(this);
        semantic.setAllCaps(false);
        semantic.setText("Verify semantic action");
        semantic.setOnClickListener(view -> semantic.setText("Semantic action passed"));
        content.addView(semantic);
        Button dirty = new Button(this);
        dirty.setAllCaps(false);
        dirty.setText("Store fixture data");
        dirty.setOnClickListener(view -> {
            getPreferences(MODE_PRIVATE).edit().putBoolean("dirty", true).commit();
            freshness.setText("Existing fixture data");
        });
        content.addView(dirty);
        setContentView(content);
        if (checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {"android.permission.POST_NOTIFICATIONS"}, 1);
        }
    }

}
