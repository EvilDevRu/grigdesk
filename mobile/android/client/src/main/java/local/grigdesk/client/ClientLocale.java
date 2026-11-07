package local.grigdesk.client;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.Locale;
import local.grigdesk.client.pipe.StaticAssets;
import local.grigdesk.client.shell.ShellLocale;

/**
 * Одна локаль принадлежит установке, всем origin машин и собственным окнам Android.
 * Контекст приложения не пересоздаётся, глобальная Locale устройства не меняется.
 */
public final class ClientLocale {
  private static ShellLocale current;

  private ClientLocale() {
  }

  /**
   * Ранний запуск читает предпочтение до первого собственного сообщения Activity.
   * Общие каталоги лежат отдельно от проверяемого манифестом дерева ui.
   */
  public static synchronized ShellLocale initialize(Context context) throws Exception {
    if (current == null) {
      SharedPreferences preferences = context.getSharedPreferences("client-locale", Context.MODE_PRIVATE);

      current = new ShellLocale(asset -> StaticAssets.readText(context.getAssets().open(asset), 1048576),
        new ShellLocale.PreferenceStore() {
          public String read() {
            return preferences.getString("preference", "system");
          }

          public boolean write(String value) {
            return preferences.edit().putString("preference", value).commit();
          }
        }, Locale::getDefault);
    }

    return current;
  }

  public static String text(String key) {
    return current == null ? "GrigDesk" : current.text("native." + key);
  }
}
