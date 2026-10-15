package dev.contingency.physicalfixture;

import android.app.Activity;
import android.os.Bundle;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** A public display fixture with an explicit FLAG_SECURE transition. */
public class StreamActivity extends Activity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(24, 120, 24, 24);
        TextView title = new TextView(this);
        title.setText("Stream fixture ready");
        content.addView(title);
        TextView result = new TextView(this);
        result.setText("Original stream content");
        content.addView(result);
        Button change = new Button(this);
        change.setAllCaps(false);
        change.setText("Change screen");
        change.setOnClickListener(view -> result.setText("Changed stream content"));
        content.addView(change);
        Button secure = new Button(this);
        secure.setAllCaps(false);
        secure.setText("Show secure window");
        secure.setOnClickListener(view -> {
            if (secure.getText().toString().equals("Show secure window")) {
                getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
                secure.setText("Hide secure window");
            } else {
                getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
                secure.setText("Show secure window");
            }
        });
        content.addView(secure);
        setContentView(content);
    }
}
