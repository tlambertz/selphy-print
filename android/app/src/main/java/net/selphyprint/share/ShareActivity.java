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
  private ProgressBar bar;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setGravity(Gravity.CENTER);
    int pad = dp(28);
    root.setPadding(pad, pad, pad, pad);
    root.setBackgroundColor(Color.parseColor("#16181d"));
    // Horizontal determinate bar so each image shows real byte progress.
    bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
    bar.setMax(100);
    bar.setIndeterminate(true);
    LinearLayout.LayoutParams barLp =
        new LinearLayout.LayoutParams(dp(240), LinearLayout.LayoutParams.WRAP_CONTENT);
    root.addView(bar, barLp);
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
        final int count = uris.size();
        for (Uri uri : uris) {
          n++;
          final int idx = n;
          final long size = querySize(uri);
          runOnUiThread(() -> {
            bar.setIndeterminate(size <= 0);
            if (size > 0) bar.setProgress(0);
            status.setText("Uploading " + idx + " / " + count + "…");
          });
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
            long written = 0;
            int lastPct = -1;
            while (in != null && (read = in.read(buf)) > 0) {
              out.write(buf, 0, read);
              written += read;
              if (size > 0) {
                int pct = (int) (written * 100 / size);
                if (pct != lastPct) {
                  lastPct = pct;
                  final int shown = pct;
                  runOnUiThread(() -> {
                    bar.setProgress(shown);
                    status.setText("Uploading " + idx + " / " + count + " — " + shown + "%");
                  });
                }
              }
            }
          }
          out.write("\r\n".getBytes(StandardCharsets.UTF_8));
        }
        runOnUiThread(() -> status.setText("Finishing…"));
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

  private long querySize(Uri uri) {
    try (Cursor c = getContentResolver().query(uri, null, null, null, null)) {
      if (c != null && c.moveToFirst()) {
        int idx = c.getColumnIndex(OpenableColumns.SIZE);
        if (idx >= 0 && !c.isNull(idx)) return c.getLong(idx);
      }
    } catch (Exception ignored) {
    }
    return -1;
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
