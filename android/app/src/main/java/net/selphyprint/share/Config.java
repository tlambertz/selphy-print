package net.selphyprint.share;

import android.content.Context;
import android.content.SharedPreferences;

final class Config {
  private static final String PREFS = "selphy";
  private static final String KEY_URL = "serverUrl";

  private Config() {}

  static String serverUrl(Context ctx) {
    SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    String url = p.getString(KEY_URL, "");
    return url.endsWith("/") ? url.substring(0, url.length() - 1) : url;
  }

  static void setServerUrl(Context ctx, String url) {
    ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        .edit()
        .putString(KEY_URL, url.trim())
        .apply();
  }
}
