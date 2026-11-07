package local.grigdesk.client.shell;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.function.Supplier;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Переводчик установки читает общий JSON через порт, без Android и глобальной Locale.
 * Сохранение завершает worker оболочки до публикации нового предпочтения.
 */
public final class ShellLocale {
  public interface Source {
    String read(String asset) throws Exception;
  }

  public interface PreferenceStore {
    String read() throws Exception;
    boolean write(String preference) throws Exception;
  }

  private final Source source;
  private final PreferenceStore store;
  private final Supplier<Locale> system;
  private final JSONArray registry;
  private final Map<String, JSONObject> catalogs = new HashMap<>();
  private String preference;

  /**
   * Реестр определяет допустимые языки, поэтому новый перевод не требует ветви Java.
   * Повреждённое предпочтение читается как system без записи при запуске.
   */
  public ShellLocale(Source source, PreferenceStore store, Supplier<Locale> system) throws Exception {
    this.source = source;
    this.store = store;
    this.system = system;
    registry = new JSONArray(source.read("locales/catalog.json"));
    String stored;

    try {
      stored = store.read();
    } catch (Exception exception) {
      stored = null;
    }

    preference = valid(stored) ? stored : "system";
  }

  public synchronized String preference() {
    return preference;
  }

  public String systemLanguage() {
    return system.get().toLanguageTag();
  }

  public synchronized String locale() {
    return preference.equals("system") ? (system.get().getLanguage().equals("ru") ? "ru" : "en")
      : preference;
  }

  /**
   * Валидация не изменяет файл, а отказ commit сохраняет прежний принятый язык.
   * Вызывающий endpoint публикует ревизию только после успешного возврата.
   */
  public synchronized void setPreference(String value) throws Exception {
    if (!valid(value)) {
      throw new IllegalArgumentException(text("native.invalidLanguage"));
    }

    boolean saved;

    try {
      saved = store.write(value);
    } catch (Exception exception) {
      throw new IllegalStateException(text("native.languageSaveFailure"), exception);
    }

    if (!saved) {
      throw new IllegalStateException(text("native.languageSaveFailure"));
    }

    preference = value;
  }

  /**
   * Старые чистые помощники сохраняют русский fallback без контекста установки.
   * Новый runtime передаёт общий переводчик, который читается только при показе отказа.
   */
  public static String text(ShellLocale locale, String key, String fallback) {
    return locale == null ? fallback : locale.text(key, fallback);
  }

  /**
   * Допустимы системный режим и ID из общего реестра переводов.
   * Новая локаль добавляется данными без изменения условий в native-экранах.
   */
  private boolean valid(String value) {
    if ("system".equals(value)) {
      return true;
    }

    for (int index = 0; index < registry.length(); index++) {
      if (registry.optJSONObject(index).optString("id").equals(value)) {
        return true;
      }
    }

    return false;
  }

  public synchronized String text(String key) {
    return text(key, "");
  }

  /**
   * Неизвестный перевод получает русский текст либо явную запасную подпись.
   * Ключ не попадает человеку, внешние строки этим методом не интерпретируются.
   */
  public synchronized String text(String key, String fallback) {
    String result = lookup(locale(), key);

    if (result == null) {
      result = lookup("ru", key);
    }

    return result == null ? fallback : result;
  }

  /**
   * Каталоги загружаются по областям и кэшируются в пределах установки.
   * Точки ключа обходят вложенные группы без специальных условий для экранов.
   */
  private String lookup(String language, String key) {
    String[] parts = key.split("\\.");

    if (parts.length < 2) {
      return null;
    }

    try {
      String asset = "locales/" + language + "/" + parts[0] + ".json";
      JSONObject catalog = catalogs.get(asset);

      if (catalog == null) {
        catalog = new JSONObject(source.read(asset));
        catalogs.put(asset, catalog);
      }

      Object value = catalog;

      for (int index = 1; index < parts.length; index++) {
        value = value instanceof JSONObject ? ((JSONObject) value).opt(parts[index]) : null;
      }

      return value instanceof String ? (String) value : null;
    } catch (Exception exception) {
      return null;
    }
  }
}
