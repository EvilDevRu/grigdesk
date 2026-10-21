package local.grigdesk.client.shell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import local.grigdesk.client.pipe.HttpHead;
import local.grigdesk.client.pipe.PipeResponse;
import local.grigdesk.client.pipe.StaticAssets;
import org.json.JSONObject;
import org.json.JSONArray;
import org.junit.Test;

public class ShellLocaleTest {
  private static final Path ASSETS = Path.of("../../../shared/i18n/assets");

  private static final class Preference implements ShellLocale.PreferenceStore {
    String saved;
    boolean writable = true;

    public String read() {
      return saved;
    }

    public boolean write(String value) {
      if (!writable) {
        return false;
      }

      saved = value;

      return true;
    }
  }

  /**
   * Переводчик читает те же общие assets, которые пакет получает отдельным source root.
   * Системный Locale передаётся портом: global Locale и Android Context не меняются.
   */
  private ShellLocale locale(Preference preference, String system) throws Exception {
    return new ShellLocale(
      asset -> Files.readString(ASSETS.resolve(asset)),
      preference,
      () -> Locale.forLanguageTag(system)
    );
  }

  /**
   * Перезапуск создаёт новый контекст над тем же сохранённым preference.
   * Невалидное значение возвращает system без перезаписи настроек установки.
   */
  @Test
  public void systemExplicitRestartAndFailedCommit() throws Exception {
    Preference preference = new Preference();

    assertEquals("ru", locale(preference, "ru-KZ").locale());
    assertEquals("en", locale(preference, "de-DE").locale());
    assertEquals("en", locale(preference, "").locale());

    ShellLocale context = locale(preference, "ru-RU");

    assertEquals("system", context.preference());
    context.setPreference("en");
    assertEquals("en", context.locale());
    assertEquals("en", locale(preference, "ru-RU").locale());
    preference.writable = false;
    assertThrows(Exception.class, () -> context.setPreference("ru"));
    assertEquals("en", context.preference());
    assertEquals("en", preference.saved);
    preference.saved = "invalid";
    assertEquals("system", locale(preference, "ru-RU").preference());
    assertEquals("invalid", preference.saved);
  }

  /**
   * Подписи native проверяются по фактическому JSON-источнику, а не другой таблице строк.
   * Все ветви читаются одним переводчиком; unknown ключ получает русский fallback.
   */
  @Test
  public void nativeCatalogIncludesScanUnlockSaveOfflineAndCancel() throws Exception {
    Preference preference = new Preference();
    ShellLocale context = locale(preference, "ru-RU");
    JSONObject ru = new JSONObject(Files.readString(ASSETS.resolve("locales/ru/native.json")));
    JSONObject en = new JSONObject(Files.readString(ASSETS.resolve("locales/en/native.json")));
    List<String> keys = new ArrayList<>();

    leaves(ru, "", keys);
    assertFalse(keys.isEmpty());

    for (String key : keys) {
      String russian = value(ru, key);
      String english = value(en, key);

      assertFalse(russian.isBlank());
      assertFalse(english.isBlank());
      context.setPreference("ru");
      assertEquals(russian, context.text("native." + key));
      context.setPreference("en");
      assertEquals(english, context.text("native." + key));
    }

    assertEquals("Неизвестное действие", context.text("unknown.native", "Неизвестное действие"));
    for (String code : List.of("locked", "invalid_pairing", "device_revoked", "offline")) {
      context.setPreference("ru");
      assertEquals(ClientFailure.message(code), ClientFailure.message(code, context));
      context.setPreference("en");
      assertFalse(ClientFailure.message(code, context).matches("(?s).*[А-Яа-яЁё].*"));
    }
  }

  /**
   * Snapshot и HTTP принадлежат настоящему ShellApi, а исполнитель не навигирует WebView.
   * Preference доступен без машины; невалидный запрос не меняет файл и ревизию.
   */
  @Test
  public void shellEndpointIsLocalPersistentAndDoesNotNavigate() throws Exception {
    Path directory = Files.createTempDirectory("locale-shell-");
    Path profiles = directory.resolve("profiles.json");
    Preference preference = new Preference();
    ShellLocale context = locale(preference, "ru-RU");
    ProfileStore store = new ProfileStore(profiles.toFile(), port -> true);
    List<String> navigated = new ArrayList<>();

    try (ShellApi shell = new ShellApi(store, null, null, (callback, delay) -> () -> {},
      Runnable::run, navigated::add, null, () -> 0.5, 0, 1, context)) {
      assertEquals("system", shell.state.snapshot().getJSONObject("locale").getString("preference"));
      long revision = shell.state.snapshot().getLong("rev");

      try (PipeResponse response = shell.handle(
        new HttpHead("POST /__shell/locale HTTP/1.1", Map.of()),
        new ByteArrayInputStream("{\"preference\":\"en\"}".getBytes(StandardCharsets.UTF_8)))) {
        assertEquals(200, response.status);
        JSONObject accepted = new JSONObject(StaticAssets.readText(response.body, 65536));

        assertEquals("en", accepted.getJSONObject("locale").getString("preference"));
      }

      assertTrue(shell.state.snapshot().getLong("rev") > revision);
      assertEquals("en", locale(preference, "ru-RU").preference());
      assertTrue(navigated.isEmpty());

      try (PipeResponse response = shell.handle(
        new HttpHead("POST /__shell/locale HTTP/1.1", Map.of()),
        new ByteArrayInputStream("{\"preference\":\"invalid\"}".getBytes(StandardCharsets.UTF_8)))) {
        assertEquals(400, response.status);
      }

      assertEquals("en", preference.saved);
    } finally {
      Files.deleteIfExists(profiles);
      Files.deleteIfExists(directory);
    }
  }

  /**
   * Третий язык добавляется данными реестра и JSON без изменения native reader.
   * Тот же метод text читает новое значение, не разветвляясь по ru/en в Java.
   */
  @Test
  public void thirdCatalogUsesTheSameNativeReader() throws Exception {
    Preference preference = new Preference();
    JSONArray registry = new JSONArray(Files.readString(ASSETS.resolve("locales/catalog.json")));

    registry.put(new JSONObject().put("id", "fr").put("name", "Français").put("intlLocale", "fr-FR"));

    JSONObject translated = new JSONObject(Files.readString(ASSETS.resolve("locales/en/native.json")));
    List<String> keys = new ArrayList<>();

    leaves(translated, "", keys);
    assertFalse(keys.isEmpty());

    String[] parts = keys.get(0).split("\\.");
    JSONObject target = translated;

    for (int index = 0; index < parts.length - 1; index++) {
      target = target.getJSONObject(parts[index]);
    }

    target.put(parts[parts.length - 1], "Texte de la fixture");

    ShellLocale context = new ShellLocale(asset -> {
      if (asset.equals("locales/catalog.json")) {
        return registry.toString();
      }

      if (asset.equals("locales/fr/native.json")) {
        return translated.toString();
      }

      return Files.readString(ASSETS.resolve(asset.replace("/fr/", "/en/")));
    }, preference, () -> Locale.FRANCE);

    context.setPreference("fr");
    assertEquals("fr", context.locale());
    assertEquals("Texte de la fixture", context.text("native." + keys.get(0)));
  }

  /**
   * Путь ключа сохраняется при рекурсивном чтении JSON-каталога.
   * Вложенные группы не требуют специальных ветвей в native reader.
   */
  private void leaves(JSONObject object, String prefix, List<String> keys) {
    for (String key : object.keySet()) {
      String path = prefix.isEmpty() ? key : prefix + "." + key;

      if (object.optJSONObject(key) != null) {
        leaves(object.getJSONObject(key), path, keys);
      } else if (object.get(key) instanceof String) {
        keys.add(path);
      }
    }
  }

  /**
   * Ожидаемый текст извлекается из того же locale-файла, который получает Source.
   * Отсутствие соответствующего EN ключа является ошибкой каталога.
   */
  private String value(JSONObject object, String key) {
    String[] parts = key.split("\\.");

    for (int index = 0; index < parts.length - 1; index++) {
      object = object.getJSONObject(parts[index]);
    }

    return object.getString(parts[parts.length - 1]);
  }
}
