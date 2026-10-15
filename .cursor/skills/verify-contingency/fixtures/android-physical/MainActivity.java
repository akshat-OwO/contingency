package dev.contingency.physicalfixture;

import android.os.Bundle;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.text.InputType;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

public class MainActivity extends FixtureActivity {
    private PasswordRemovalReceiver removal;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(24, 120, 24, 24);
        TextView freshness = new TextView(this);
        freshness.setText(getPreferences(MODE_PRIVATE).getBoolean("dirty", false) ? "Existing fixture data" : "Fresh fixture data");
        content.addView(freshness);
        EditText password = new EditText(this);
        password.setId(1001);
        password.setHint("Fixture password");
        password.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        password.setShowSoftInputOnFocus(false);
        content.addView(password);
        removal = PasswordRemovalReceiver.register(this, password);
        EditText ordinary = new EditText(this);
        ordinary.setId(1002);
        ordinary.setHint("Public fixture field");
        ordinary.setShowSoftInputOnFocus(false);
        content.addView(ordinary);
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
        Button remove = new Button(this);
        remove.setAllCaps(false);
        remove.setText("Remove password field");
        remove.setOnClickListener(view -> content.removeView(password));
        content.addView(remove);
        Button replace = new Button(this);
        replace.setAllCaps(false);
        replace.setText("Replace fixture window");
        replace.setOnClickListener(view -> startActivity(new Intent(this, ReplacementActivity.class)));
        content.addView(replace);
        setContentView(content);
        if (checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {"android.permission.POST_NOTIFICATIONS"}, 1);
        }
    }

    @Override protected void onDestroy() {
        unregisterReceiver(removal);
        super.onDestroy();
    }
}
