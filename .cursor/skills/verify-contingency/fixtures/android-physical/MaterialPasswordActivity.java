package dev.contingency.physicalfixture;

import android.os.Bundle;
import android.text.InputFilter;
import android.text.InputType;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import com.google.android.material.textfield.TextInputEditText;
import com.google.android.material.textfield.TextInputLayout;

/** Stock Material password widgets; the helper reads the field, without a fixture API. */
public class MaterialPasswordActivity extends FixtureActivity {
    private PasswordRemovalReceiver removal;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(24, 120, 24, 24);
        TextInputLayout layout = new TextInputLayout(this);
        layout.setHint("Material fixture password");
        TextInputEditText password = new TextInputEditText(layout.getContext());
        password.setId(1003);
        password.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        password.setShowSoftInputOnFocus(false);
        if (getIntent().getBooleanExtra("filter", false)) {
            // Same-length mutation proves readback compares content, not length or the request.
            password.setFilters(new InputFilter[] { (source, start, end, dest, dstart, dend) ->
                    "x".repeat(end - start) });
        }
        layout.addView(password);
        removal = PasswordRemovalReceiver.register(this, password);
        content.addView(layout);
        EditText ordinary = new EditText(this);
        ordinary.setHint("Public fixture field");
        ordinary.setShowSoftInputOnFocus(false);
        content.addView(ordinary);
        Button semantic = new Button(this);
        semantic.setAllCaps(false);
        semantic.setText("Verify semantic action");
        semantic.setOnClickListener(view -> semantic.setText("Semantic action passed"));
        content.addView(semantic);
        setContentView(content);
    }

    @Override protected void onDestroy() {
        unregisterReceiver(removal);
        super.onDestroy();
    }
}
