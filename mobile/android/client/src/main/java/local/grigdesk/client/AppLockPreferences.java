package local.grigdesk.client;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.Set;
import org.json.JSONObject;

/**
 * Значение настройки блокировки приложения установки: включена ли и порог фона в секундах.
 * Класс ничего не знает о gate: чтение и запись файла отделены от решения о блокировке.
 */
public final class AppLockPreferences {
  public static final int DEFAULT_DELAY_SECONDS = 60;
  private static final Set<Integer> DELAYS = Set.of(0, 60, 300);

  public final boolean enabled;
  public final int delaySeconds;

  /**
   * Чужой порог не нормализуется к ближайшему допустимому: значение либо точное, либо отказ.
   * Это защищает от молчаливой смены политики при чтении файла другой версии.
   */
  public AppLockPreferences(boolean enabled, int delaySeconds) {
    if (!DELAYS.contains(delaySeconds)) {
      throw new IllegalArgumentException("Недопустимый порог блокировки приложения.");
    }

    this.enabled = enabled;
    this.delaySeconds = delaySeconds;
  }

  /**
   * Только отсутствие файла означает первый запуск с выключенной защитой.
   * Битый JSON, лишние поля и чужой порог отвергаются, файл при этом не перезаписывается.
   */
  public static AppLockPreferences load(File file) throws Exception {
    if (!file.exists()) {
      return new AppLockPreferences(false, DEFAULT_DELAY_SECONDS);
    }

    JSONObject data = new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));

    if (data.length() != 2 || !(data.opt("enabled") instanceof Boolean)
      || !(data.opt("delaySeconds") instanceof Integer)) {
      throw new IllegalArgumentException("Файл настроек блокировки повреждён.");
    }

    return new AppLockPreferences(data.getBoolean("enabled"), data.getInt("delaySeconds"));
  }

  /**
   * Запись идёт в соседний временный файл с приватными правами и атомарной заменой.
   * Неудача не оставляет половину JSON вместо прежней настройки.
   */
  public static void save(File file, AppLockPreferences value) throws Exception {
    JSONObject data = new JSONObject().put("enabled", value.enabled)
      .put("delaySeconds", value.delaySeconds);
    File pending = File.createTempFile("app-lock-", ".json", file.getParentFile());

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
}
