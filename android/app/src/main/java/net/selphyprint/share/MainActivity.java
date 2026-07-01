package net.selphyprint.share;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/** Settings: where the selphy-print server lives, plus a shortcut into the web app. */
public class MainActivity extends Activity {

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    int pad = dp(24);
    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setPadding(pad, pad * 2, pad, pad);
    root.setBackgroundColor(Color.parseColor("#0b0c10"));

    TextView title = new TextView(this);
    title.setText("Selphy Print — share companion");
    title.setTextColor(Color.parseColor("#eef0f4"));
    title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
    root.addView(title);

    TextView help = new TextView(this);
    help.setText(
        "Receives photos from the Android share sheet and queues them on your "
            + "selphy-print server. Set the server URL once; then share images "
            + "from any app.");
    help.setTextColor(Color.parseColor("#9aa1b2"));
    help.setPadding(0, dp(8), 0, dp(20));
    root.addView(help);

    EditText url = new EditText(this);
    url.setHint("https://print.example.com");
    url.setText(Config.serverUrl(this));
    url.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
    url.setTextColor(Color.parseColor("#eef0f4"));
    url.setHintTextColor(Color.parseColor("#6b7183"));
    root.addView(url);

    Button save = new Button(this);
    save.setText("Save");
    save.setOnClickListener(v -> {
      String value = url.getText().toString().trim();
      if (!value.startsWith("http://") && !value.startsWith("https://")) {
        Toast.makeText(this, "URL must start with http(s)://", Toast.LENGTH_LONG).show();
        return;
      }
      Config.setServerUrl(this, value);
      Toast.makeText(this, "Saved — share images from your gallery now", Toast.LENGTH_LONG).show();
    });
    root.addView(save, buttonParams());

    Button open = new Button(this);
    open.setText("Open print queue");
    open.setOnClickListener(v -> {
      String base = Config.serverUrl(this);
      if (base.isEmpty()) {
        Toast.makeText(this, "Set the server URL first", Toast.LENGTH_LONG).show();
        return;
      }
      startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(base)));
    });
    root.addView(open, buttonParams());

    setContentView(root);
  }

  private LinearLayout.LayoutParams buttonParams() {
    LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    lp.topMargin = dp(12);
    lp.gravity = Gravity.CENTER_HORIZONTAL;
    return lp;
  }

  private int dp(int v) {
    return Math.round(TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
  }
}
