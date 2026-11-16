package local.grigdesk.client;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import org.json.JSONObject;

/**
 * Фоновая связь — явный выбор человека: труба и событие остаются живыми в свёрнутом приложении.
 * Настройка хранится отдельно от блокировки и не меняет политику закрытия интерфейса.
 */
public final class BackgroundLink {
  private final File file;
  private volatile boolean enabled;

  /**
   * Отсутствие файла означает первый запуск с выключенной фоновой связью.
   * Повреждённый файл не перезаписывается и читается как выключенное значение.
   */
  public BackgroundLink(File file) {
    this.file = file;

    boolean stored = false;

    try {
      if (file.exists()) {
        JSONObject data = new JSONObject(new String(Files.readAllBytes(file.toPath()),
          StandardCharsets.UTF_8));

        if (data.length() == 1 && data.opt("enabled") instanceof Boolean) {
          stored = data.getBoolean("enabled");
        }
      }
    } catch (Exception exception) {
      stored = false;
    }

    enabled = stored;
  }

  public boolean enabled() {
    return enabled;
  }

  /**
   * Запись идёт во временный файл с приватными правами и атомарной заменой.
   * Неудача сохраняет прежнее значение и не оставляет половину JSON.
   */
  public synchronized void set(boolean value) throws Exception {
    JSONObject data = new JSONObject().put("enabled", value);
    File pending = File.createTempFile("background-link-", ".json", file.getParentFile());

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

    enabled = value;
  }

  public JSONObject snapshot() {
    try {
      return new JSONObject().put("enabled", enabled);
    } catch (org.json.JSONException exception) {
      throw new IllegalStateException(exception);
    }
  }
}
