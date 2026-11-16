package local.grigdesk.client;

import static org.junit.Assert.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.json.JSONObject;
import org.junit.Test;

public class WidgetTextTest {
  private static final String[] KEYS = {
    "widgetTitle", "widgetRunning", "widgetWaiting", "widgetStalled", "widgetUpdated",
    "widgetStateOffline", "widgetStateLocked", "widgetStateNoMachine", "widgetStateUnpaired",
    "widgetUpdating", "widgetRefresh", "widgetRefreshInvalid",
    "widgetStateClientUpgrade", "widgetStateServerUpgrade",
  };

  /**
   * Надписи виджета живут в общем каталоге установки и обязаны быть на обоих языках.
   * Пустая строка считается отсутствием: виджет не показывает молчаливые ключи.
   */
  @Test
  public void widgetTextsExistInBothLocales() throws Exception {
    for (String lang : new String[] { "ru", "en" }) {
      Path file = Path.of("..", "..", "..", "shared", "i18n", "assets", "locales", lang,
        "native.json");
      JSONObject catalog = new JSONObject(new String(Files.readAllBytes(file),
        StandardCharsets.UTF_8));

      for (String key : KEYS) {
        assertTrue(lang + ":" + key, catalog.optString(key, "").length() > 0);
      }
    }
  }
}
