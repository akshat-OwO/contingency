package dev.contingency.physicalfixture;

import android.os.Bundle;
import android.widget.LinearLayout;
import android.widget.TextView;

/** A second same-package screen, so Back has a reversible, observable outcome. */
public class AccountActivity extends FixtureActivity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(24, 120, 24, 24);
        TextView heading = new TextView(this);
        heading.setText("Account details");
        heading.setTextSize(24);
        content.addView(heading);
        setContentView(content);
    }
}
