package net.selphyprint.share;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** Receives ACTION_SEND / ACTION_SEND_MULTIPLE images, uploads them to the
    selphy-print server's /share-target inbox, then opens the web app (which
    drains the inbox into its print queue). */
public class ShareActivity extends Activity {

  private TextView status;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setGravity(Gravity.CENTER);
    int pad = dp(28);
    root.setPadding(pad, pad, pad, pad);
    root.setBackgroundColor(Color.parseColor("#16181d"));
    ProgressBar bar = new ProgressBar(this);
    root.addView(bar);
    status = new TextView(this);
    status.setText("Sending to printer queue…");
    status.setTextColor(Color.parseColor("#eef0f4"));
    status.setPadding(0, dp(12), 0, 0);
    status.setGravity(Gravity.CENTER);
    root.addView(status);
    setContentView(root);

    String base = Config.serverUrl(this);
    if (base.isEmpty()) {
      Toast.makeText(this, "Set the server URL first", Toast.LENGTH_LONG).show();
      startActivity(new Intent(this, MainActivity.class));
      finish();
      return;
    }

    List<Uri> uris = extractUris(getIntent());
    if (uris.isEmpty()) {
      Toast.makeText(this, "Nothing shareable received", Toast.LENGTH_LONG).show();
      finish();
      return;
    }

    new Thread(() -> upload(base, uris)).start();
  }

  private List<Uri> extractUris(Intent intent) {
    List<Uri> uris = new ArrayList<>();
    if (Intent.ACTION_SEND.equals(intent.getAction())) {
      Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
      if (u != null) uris.add(u);
    } else if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
      ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
      if (list != null) {
        for (Uri u : list) if (u != null) uris.add(u);
      }
    }
    return uris;
  }

  private void upload(String base, List<Uri> uris) {
    String boundary = "selphy-" + UUID.randomUUID();
    try {
      HttpURLConnection conn =
          (HttpURLConnection) new URL(base + "/share-target").openConnection();
      conn.setDoOutput(true);
      conn.setRequestMethod("POST");
      conn.setInstanceFollowRedirects(false); // server replies 303 → fine
      conn.setChunkedStreamingMode(0);
      conn.setConnectTimeout(10_000);
      conn.setReadTimeout(120_000);
      conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);

      try (OutputStream out = conn.getOutputStream()) {
        int n = 0;
        for (Uri uri : uris) {
          n++;
          final String msg = "Uploading " + n + " / " + uris.size() + "…";
          runOnUiThread(() -> status.setText(msg));
          String name = displayName(uri, "photo-" + n + ".jpg");
          String type = getContentResolver().getType(uri);
          if (type == null) type = "image/jpeg";

          out.write(("--" + boundary + "\r\n").getBytes(StandardCharsets.UTF_8));
          out.write(("Content-Disposition: form-data; name=\"images\"; filename=\""
              + name.replace("\"", "") + "\"\r\n").getBytes(StandardCharsets.UTF_8));
          out.write(("Content-Type: " + type + "\r\n\r\n").getBytes(StandardCharsets.UTF_8));
          try (InputStream in = getContentResolver().openInputStream(uri)) {
            byte[] buf = new byte[64 * 1024];
            int read;
            while (in != null && (read = in.read(buf)) > 0) out.write(buf, 0, read);
          }
          out.write("\r\n".getBytes(StandardCharsets.UTF_8));
        }
        out.write(("--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
      }

      int code = conn.getResponseCode();
      conn.disconnect();
      if (code >= 200 && code < 400) {
        runOnUiThread(() -> {
          Toast.makeText(this, uris.size() + " photo(s) queued", Toast.LENGTH_SHORT).show();
          startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(base)));
          finish();
        });
      } else {
        fail("Server answered HTTP " + code);
      }
    } catch (Exception e) {
      fail(e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
    }
  }

  private String displayName(Uri uri, String fallback) {
    try (Cursor c = getContentResolver().query(uri, null, null, null, null)) {
      if (c != null && c.moveToFirst()) {
        int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
        if (idx >= 0 && c.getString(idx) != null) return c.getString(idx);
      }
    } catch (Exception ignored) {
    }
    return fallback;
  }

  private void fail(String why) {
    runOnUiThread(() -> {
      Toast.makeText(this, "Upload failed: " + why, Toast.LENGTH_LONG).show();
      finish();
    });
  }

  private int dp(int v) {
    return Math.round(TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
  }
}
