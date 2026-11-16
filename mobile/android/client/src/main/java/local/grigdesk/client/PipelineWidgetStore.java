package local.grigdesk.client;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.Set;
import org.json.JSONObject;

/**
 * Кэш счётчиков конвейера для виджета главного экрана.
 * Повреждённый файл читается как отсутствие данных; запись идёт атомарной заменой,
 * чтобы виджет не увидел половину JSON. Образец — BackgroundLink установки.
 */
public final class PipelineWidgetStore {
  public static final Set<String> STATES =
    Set.of("ok", "offline", "locked", "no_machine", "unpaired", "identityMismatch",
      "client_upgrade_required", "server_upgrade_required");
  private static final int COUNTER_LIMIT = 1000000;
  private final File file;

  public PipelineWidgetStore(File file) {
    this.file = file;
  }

  /**
   * Отсутствие файла и повреждённый JSON одинаково означают «данных ещё нет».
   * Проверка формы не даёт виджету показать мусор из чужой записи.
   */
  public JSONObject read() {
    try {
      if (!file.exists()) {
        return null;
      }

      JSONObject data = new JSONObject(new String(Files.readAllBytes(file.toPath()),
        StandardCharsets.UTF_8));

      return isValid(data) ? data : null;
    } catch (Exception exception) {
      return null;
    }
  }

  /**
   * Кэш одной машины нельзя выдать за данные другой, включая отсутствие выбора.
   * Пустой profileId допустим только для состояния без выбранной машины.
   */
  public JSONObject readFor(String profileId) {
    JSONObject data = read();

    return data != null && profileId.equals(data.optString("profileId")) ? data : null;
  }

  /**
   * Прочерк означает отсутствие успешного снимка, ноль — успешный пустой счётчик.
   * Эту же чистую функцию использует RemoteViews, поэтому JVM проверяет видимый текст.
   */
  public static String counterText(JSONObject data, String key) {
    return data == null || data.optString("at").isEmpty() ? "–" : String.valueOf(data.optInt(key));
  }

  /**
   * Запись принимает только полную проверенную запись: счётчики, отметку и состояние.
   * Неудача сохраняет прежний файл и не оставляет временный мусор.
   */
  public synchronized void save(JSONObject data) throws Exception {
    if (!isValid(data)) {
      throw new IllegalArgumentException("Неверная запись кэша виджета.");
    }

    File pending = File.createTempFile("pipeline-widget-", ".json", file.getParentFile());

    try {
      pending.setReadable(false, false);
      pending.setWritable(false, false);
      pending.setReadable(true, true);
      pending.setWritable(true, true);
      Files.write(pending.toPath(), data.toString().getBytes(StandardCharsets.UTF_8));
      Files.move(pending.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE,
        StandardCopyOption.REPLACE_EXISTING);
    } finally {
      Files.deleteIfExists(pending.toPath());
    }
  }

  /**
   * Форма записи: ровно восемь полей, целые счётчики в разумном пределе,
   * строка отметки, числовое время запроса и известное состояние.
   * Пустая отметка допустима: успешного запроса ещё не было.
   */
  public static boolean isValid(JSONObject data) {
    if (data == null || data.length() != 8) {
      return false;
    }

    for (String key : new String[] { "running", "waiting", "stalled" }) {
      if (!(data.opt(key) instanceof Integer) || data.optInt(key) < 0
        || data.optInt(key) > COUNTER_LIMIT) {
        return false;
      }
    }

    if (!(data.opt("at") instanceof String) || data.optString("at").length() > 40) {
      return false;
    }

    if (!(data.opt("fetchedAt") instanceof Number) || data.optLong("fetchedAt") < 0) {
      return false;
    }

    return data.opt("profileId") instanceof String
      && data.optString("profileId").length() <= 128
      && data.opt("requestId") instanceof Number && data.optLong("requestId") >= 0
      && STATES.contains(data.optString("state"))
      && (!"ok".equals(data.optString("state")) || !data.optString("at").isEmpty());
  }
}
