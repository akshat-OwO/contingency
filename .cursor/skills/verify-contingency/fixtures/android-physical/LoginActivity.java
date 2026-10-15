package dev.contingency.physicalfixture;

import android.content.Intent;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.google.android.material.textfield.TextInputEditText;
import com.google.android.material.textfield.TextInputLayout;

/**
 * Disposable login journey. Never logs, persists, or reflects the password.
 * The public login name is reflected so a public fill has a visible outcome.
 */
public class LoginActivity extends FixtureActivity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        if (getIntent().getBooleanExtra("secure", false)) getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(24, 120, 24, 24);
        TextView heading = new TextView(this);
        heading.setText("Private login fixture");
        heading.setTextSize(24);
        content.addView(heading);
        TextInputLayout nameLayout = new TextInputLayout(this);
        nameLayout.setHint("Login name");
        TextInputEditText loginName = new TextInputEditText(nameLayout.getContext());
        loginName.setId(1005);
        loginName.setShowSoftInputOnFocus(false);
        nameLayout.addView(loginName);
        content.addView(nameLayout);
        TextInputLayout layout = new TextInputLayout(this);
        layout.setHint("Login password");
        TextInputEditText password = new TextInputEditText(layout.getContext());
        password.setId(1004);
        password.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        password.setShowSoftInputOnFocus(false);
        layout.addView(password);
        content.addView(layout);
        TextView account = new TextView(this);
        Button openAccount = new Button(this);
        openAccount.setAllCaps(false);
        openAccount.setText("Open account");
        openAccount.setOnClickListener(view -> startActivity(new Intent(this, AccountActivity.class)));
        Button signIn = new Button(this);
        signIn.setAllCaps(false);
        signIn.setText("Sign in privately");
        signIn.setOnClickListener(view -> {
            if (password.getText() != null && password.getText().length() > 0) {
                password.setText("");
                content.removeView(nameLayout);
                content.removeView(layout);
                content.removeView(signIn);
                heading.setText("Signed in privately");
                if (loginName.getText() != null && loginName.getText().length() > 0) {
                    account.setText("Signed in as " + loginName.getText());
                    content.addView(account, 1);
                }
                content.addView(openAccount, account.getParent() == null ? 1 : 2);
            }
        });
        content.addView(signIn);
        Button secure = new Button(this);
        secure.setAllCaps(false);
        secure.setText("Show secure login window");
        secure.setOnClickListener(view -> {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
            secure.setText("Secure login window");
        });
        content.addView(secure);
        // Documented-limit probes: a system permission dialog and another app's window.
        Button dialog = new Button(this);
        dialog.setAllCaps(false);
        dialog.setText("Request camera permission");
        dialog.setOnClickListener(view -> requestPermissions(new String[] {"android.permission.CAMERA"}, 2));
        content.addView(dialog);
        Button outside = new Button(this);
        outside.setAllCaps(false);
        outside.setText("Open device settings");
        outside.setOnClickListener(view -> startActivity(new Intent(Settings.ACTION_SETTINGS)));
        content.addView(outside);
        setContentView(content);
    }
}
