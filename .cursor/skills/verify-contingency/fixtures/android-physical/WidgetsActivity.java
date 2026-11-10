package dev.contingency.physicalfixture;

import android.app.AlertDialog;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.SearchView;
import android.widget.SeekBar;
import android.widget.Spinner;
import android.widget.Switch;
import android.widget.TextView;
import com.google.android.material.bottomsheet.BottomSheetDialog;
import com.google.android.material.tabs.TabLayout;
import java.util.ArrayList;
import java.util.List;

/**
 * Widget corpus for native observation coverage. Each tab exposes one family
 * of Android primitives that real apps use; every interaction writes the
 * `Last action:` label so a capture or proof can read its outcome.
 */
public class WidgetsActivity extends FixtureActivity {
    private final List<TextView> outcomes = new ArrayList<>();

    private void record(String action) {
        for (TextView outcome : outcomes) outcome.setText("Last action: " + action);
    }

    private TextView outcome() {
        TextView label = new TextView(this);
        label.setText("Last action: none");
        outcomes.add(label);
        return label;
    }

    private Button button(String title, View.OnClickListener listener) {
        Button button = new Button(this);
        button.setText(title);
        button.setOnClickListener(listener);
        return button;
    }

    private EditText field(String hint, int type) {
        EditText field = new EditText(this);
        field.setHint(hint);
        field.setInputType(type);
        field.setShowSoftInputOnFocus(false);
        return field;
    }

    // A clickable row whose name lives only in its child text views, as in
    // most hand-built product lists.
    private View row(String title, String price) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.VERTICAL);
        row.setPadding(0, 24, 0, 24);
        row.setClickable(true);
        row.setFocusable(true);
        TextView name = new TextView(this);
        name.setText(title);
        name.setTextSize(18);
        TextView cost = new TextView(this);
        cost.setText(price);
        row.addView(name);
        row.addView(cost);
        row.setOnClickListener(view -> record("Row " + title));
        return row;
    }

    private LinearLayout controls() {
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.addView(outcome());
        content.addView(button("Show alert", view -> new AlertDialog.Builder(this)
            .setTitle("Remove item?").setMessage("This removes the item from the cart.")
            .setNegativeButton("Cancel", (dialog, which) -> record("Alert cancel"))
            .setPositiveButton("Remove", (dialog, which) -> record("Alert remove")).show()));
        content.addView(button("Show bottom sheet", view -> {
            BottomSheetDialog sheet = new BottomSheetDialog(this);
            LinearLayout options = new LinearLayout(this);
            options.setOrientation(LinearLayout.VERTICAL);
            options.setPadding(32, 32, 32, 96);
            options.addView(button("Copy link", tap -> { record("Sheet copy"); sheet.dismiss(); }));
            options.addView(button("Close sheet", tap -> { record("Sheet cancel"); sheet.dismiss(); }));
            sheet.setContentView(options);
            sheet.show();
        }));
        Switch toggle = new Switch(this);
        toggle.setText("Notifications");
        toggle.setOnCheckedChangeListener((view, on) -> record(on ? "Notifications on" : "Notifications off"));
        content.addView(toggle);
        CheckBox gift = new CheckBox(this);
        gift.setText("Gift wrap");
        gift.setOnCheckedChangeListener((view, on) -> record(on ? "Gift wrap on" : "Gift wrap off"));
        content.addView(gift);
        RadioGroup shipping = new RadioGroup(this);
        for (String option : new String[] {"Standard", "Express"}) {
            RadioButton radio = new RadioButton(this);
            radio.setText(option);
            radio.setOnClickListener(view -> record("Shipping " + option));
            shipping.addView(radio);
        }
        content.addView(shipping);
        Spinner size = new Spinner(this);
        size.setContentDescription("Size");
        size.setAdapter(new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, new String[] {"Small", "Medium", "Large"}));
        content.addView(size);
        SeekBar volume = new SeekBar(this);
        volume.setContentDescription("Volume");
        volume.setMax(10);
        volume.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar bar, int value, boolean user) { if (user) record("Volume " + value); }
            @Override public void onStartTrackingTouch(SeekBar bar) {}
            @Override public void onStopTrackingTouch(SeekBar bar) {}
        });
        content.addView(volume);
        ImageButton favorite = new ImageButton(this);
        favorite.setImageResource(android.R.drawable.btn_star);
        favorite.setContentDescription("Favorite");
        favorite.setOnClickListener(view -> record("Favorite"));
        content.addView(favorite, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        content.addView(button("Continue", view -> record("Continue")));
        Button disabled = button("Unavailable", view -> record("Unavailable"));
        disabled.setEnabled(false);
        content.addView(disabled);
        content.addView(field("Email", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS));
        content.addView(field("Postal code", InputType.TYPE_CLASS_NUMBER));
        content.addView(field("Card PIN", InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD));
        EditText notes = field("Delivery notes", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        notes.setMinLines(3);
        content.addView(notes);
        SearchView search = new SearchView(this);
        search.setQueryHint("Search products");
        search.setIconifiedByDefault(false);
        content.addView(search);
        return content;
    }

    private LinearLayout list() {
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.addView(outcome());
        content.addView(row("Anvil", "$7.00"));
        content.addView(row("Rocket skates", "$14.00"));
        String[] products = new String[60];
        for (int index = 0; index < products.length; index++) products[index] = "Product " + (index + 1);
        ListView catalog = new ListView(this);
        catalog.setAdapter(new ArrayAdapter<>(this, android.R.layout.simple_list_item_1, products));
        catalog.setOnItemClickListener((AdapterView<?> parent, View view, int position, long id) -> record("Row " + products[position]));
        content.addView(catalog, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1200));
        return content;
    }

    private WebView web() {
        WebView view = new WebView(this);
        view.getSettings().setJavaScriptEnabled(true);
        view.loadData("<html><head><meta name=viewport content='width=device-width'></head><body style='font:20px sans-serif;padding:16px'>"
            + "<h1>Embedded help</h1><a href='#faq' onclick=\"document.getElementById('out').textContent='Web link'\">Shipping FAQ</a>"
            + "<p><label>Coupon <input aria-label='Coupon' id=coupon></label></p>"
            + "<button onclick=\"document.getElementById('out').textContent='Web apply'\">Apply coupon</button>"
            + "<p id=out>Web idle</p></body></html>", "text/html", "utf-8");
        return view;
    }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        setTheme(com.google.android.material.R.style.Theme_MaterialComponents_Light_NoActionBar);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(24, 96, 24, 24);
        TabLayout tabs = new TabLayout(this);
        View[] screens = {wrap(controls()), list(), web()};
        String[] titles = {"Controls", "List", "Web"};
        for (String title : titles) tabs.addTab(tabs.newTab().setText(title));
        root.addView(tabs);
        for (int index = 0; index < screens.length; index++) {
            screens[index].setVisibility(index == 0 ? View.VISIBLE : View.GONE);
            root.addView(screens[index], new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        }
        tabs.addOnTabSelectedListener(new TabLayout.OnTabSelectedListener() {
            @Override public void onTabSelected(TabLayout.Tab tab) {
                for (int index = 0; index < screens.length; index++) screens[index].setVisibility(index == tab.getPosition() ? View.VISIBLE : View.GONE);
            }
            @Override public void onTabUnselected(TabLayout.Tab tab) {}
            @Override public void onTabReselected(TabLayout.Tab tab) {}
        });
        setContentView(root);
    }

    private ScrollView wrap(View content) {
        ScrollView scroll = new ScrollView(this);
        scroll.addView(content);
        return scroll;
    }
}
