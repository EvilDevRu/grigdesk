package local.grigdesk.client.shell;

import java.io.File;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.function.IntPredicate;
import org.json.JSONArray;
import org.json.JSONObject;

public final class ProfileStore {
  public String selected;
  public final List<JSONObject> profiles = new ArrayList<>();
  private final File file;
  private final IntPredicate available;
  private final ShellLocale locale;

  /**
   * Приватный файл не содержит ключ устройства; повреждённый JSON не перезаписывается.
   * Отсутствующий или пустой файл означает первый запуск без профилей.
   */
  public ProfileStore(File file, IntPredicate available) throws Exception {
    this(file, available, null);
  }

  /**
   * Локаль установки меняет только собственные сообщения хранилища.
   * Формат файла, проверка адресов и выбор порта остаются прежними.
   */
  public ProfileStore(File file, IntPredicate available, ShellLocale locale) throws Exception {
    this.file = file;
    this.available = available;
    this.locale = locale;

    if (!file.exists() || file.length() == 0) {
      return;
    }

    if (file.length() > 1024 * 1024) {
      throw new IllegalArgumentException(
        ShellLocale.text(locale, "native.profilesDamaged", "Файл машин повреждён."));
    }

    JSONObject data = new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
    JSONArray list = data.getJSONArray("profiles");
    Set<String> ids = new HashSet<>();
    Set<Integer> ports = new HashSet<>();

    if (data.getInt("version") != 1 || list.length() > 99) {
      throw new IllegalArgumentException(
        ShellLocale.text(locale, "native.profilesDamaged", "Файл машин повреждён."));
    }

    for (int index = 0; index < list.length(); index++) {
      JSONObject profile = list.getJSONObject(index);

      if (profile.has("relay") && profile.getString("address").isEmpty()) {
        validate(profile.getString("name"), "https://profile.invalid", profile.getString("fp"), locale);
      } else {
        validate(profile.getString("name"), profile.getString("address"), profile.getString("fp"), locale);
      }

      if (profile.has("direct")) {
        PhonePairingPayload.routes(profile.getJSONArray("direct"), profile.optJSONObject("relay"));
      }

      if (!profile.getString("kind").equals("remote") || !ids.add(profile.getString("id"))
        || !ports.add(profile.getInt("port")) || profile.getInt("port") < 47101
        || profile.getInt("port") > 47199) {
        throw new IllegalArgumentException(
          ShellLocale.text(locale, "native.profilesDamaged", "Файл машин повреждён."));
      }

      profiles.add(profile);
    }

    selected = data.optString("selected", null);

    if (selected != null && profiles.stream().noneMatch(item -> item.optString("id").equals(selected))) {
      selected = null;
    }
  }

  /**
   * Адрес нельзя превратить в URL с паролем, путём или перенаправлением запроса.
   * Имя ограничено для UI, а pin сохраняется только после проверки привязки.
   */
  public static void validate(String name, String address, String fp) {
    validate(name, address, fp, null);
  }

  /**
   * Валидация адреса использует тот же предикат и не нормализует данные человека.
   * Оболочка передаёт локаль только для собственного сообщения об отказе.
   */
  public static void validate(String name, String address, String fp, ShellLocale locale) {
    URI uri = URI.create(address);

    if (name.trim().isEmpty() || name.length() > 128 || !fp.matches("[a-f0-9]{64}")
      || !"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null
      || uri.getHost().contains(":") || uri.getRawQuery() != null || uri.getRawFragment() != null
      || !Set.of("", "/").contains(uri.getPath()) || uri.getPort() == 0 || uri.getPort() > 65535) {
      throw new IllegalArgumentException(
        ShellLocale.text(locale, "native.invalidMachine", "Неверное имя или адрес машины."));
    }
  }

  /**
   * Порт выбирается из диапазона машин с исключением остальных сохранённых профилей.
   * Проверка доступности позволяет восстановиться при занятом origin прежнего запуска.
   */
  private int freePort(String id) {
    for (int port = 47101; port <= 47199; port++) {
      final int candidate = port;
      boolean used = profiles.stream().anyMatch(item -> !item.optString("id").equals(id)
        && item.optInt("port") == candidate);

      if (!used && available.test(port)) {
        return port;
      }
    }

    throw new IllegalStateException(
      ShellLocale.text(locale, "native.noFreePort", "Нет свободного порта для машины."));
  }

  /**
   * Повтор привязки того же pin обновляет машину, сохраняя её origin и настройки вида.
   * Разные машины получают отдельные постоянные порты и случайные идентификаторы.
   */
  public synchronized JSONObject add(String name, String address, String fp) throws Exception {
    boolean relayOnly = address.isEmpty() && profiles.stream().anyMatch(item ->
      item.optString("fp").equals(fp) && item.has("relay"));

    validate(name, relayOnly ? "https://profile.invalid" : address, fp, locale);

    JSONObject profile = profiles.stream().filter(item -> item.optString("fp").equals(fp))
      .findFirst().orElse(null);

    if (profile == null) {
      profile = new JSONObject();
      profile.put("id", UUID.randomUUID().toString());
      profile.put("port", freePort(null));
      profile.put("createdAt", System.currentTimeMillis());
      profile.put("kind", "remote");
      profiles.add(profile);
    }

    if (profile.has("direct") && !address.equals(profile.optString("address"))) {
      URI uri = URI.create(address);

      if (!PhonePairingPayload.validHost(uri.getHost())) {
        throw new IllegalArgumentException(
          ShellLocale.text(locale, "native.invalidMachine", "Неверное имя или адрес машины."));
      }

      profile.put("direct", new JSONArray().put(new JSONObject().put("host", uri.getHost())
        .put("port", uri.getPort() < 0 ? 443 : uri.getPort())));
    }

    profile.put("name", name.trim());
    profile.put("address", address);
    profile.put("fp", fp);
    save();

    return profile;
  }

  /**
   * Приватные маршруты сохраняются по pin в той же записи и с прежним origin.
   * Пустая адресная проекция допустима только при проверенном relay-only профиле.
   */
  public synchronized JSONObject addPhone(String name, String fp, JSONArray direct,
    JSONObject relay, String deviceId) throws Exception {
    PhonePairingPayload.routes(direct, relay);

    String address = direct.length() == 0 ? "" : "https://"
      + direct.getJSONObject(0).getString("host") + ":" + direct.getJSONObject(0).getInt("port");
    validate(name, address.isEmpty() ? "https://profile.invalid" : address, fp, locale);

    JSONObject profile = profiles.stream().filter(item -> item.optString("fp").equals(fp))
      .findFirst().orElse(null);

    if (profile == null) {
      profile = new JSONObject().put("id", UUID.randomUUID().toString()).put("port", freePort(null))
        .put("createdAt", System.currentTimeMillis()).put("kind", "remote");
      profiles.add(profile);
    }

    profile.put("name", name.trim()).put("fp", fp).put("address", address)
      .put("direct", direct).put("deviceId", deviceId);

    if (relay == null) {
      profile.remove("relay");
    } else {
      profile.put("relay", relay);
    }

    save();

    return profile;
  }

  public synchronized JSONObject get(String id) {
    return profiles.stream().filter(item -> item.optString("id").equals(id)).findFirst().orElseThrow();
  }

  /**
   * Выбор допускает только существующую машину либо пустой экран подключения.
   * Изменение сохраняется до навигации, чтобы следующий запуск открыл тот же профиль.
   */
  public synchronized void select(String id) throws Exception {
    if (id != null) {
      get(id);
    }

    selected = id;
    save();
  }

  /**
   * Удаление выбранной машины возвращает установку на экран подключения.
   * Другие профили и их постоянные origin сохраняются без перенумерации.
   */
  public synchronized void remove(String id) throws Exception {
    profiles.remove(get(id));

    if (id.equals(selected)) {
      selected = null;
    }

    save();
  }

  /**
   * Занятый порт заменяется свободным до открытия документа машины.
   * Новый origin записывается в профиль, чтобы сохраняться между запусками.
   */
  public synchronized int claimPort(String id) throws Exception {
    JSONObject profile = get(id);
    int port = profile.getInt("port");

    if (!available.test(port)) {
      port = freePort(id);
      profile.put("port", port);
      save();
    }

    return port;
  }

  /**
   * Запись происходит в соседний временный файл с приватными правами и atomic rename.
   * Неудача не оставляет половину JSON вместо ранее сохранённых машин.
   */
  private void save() throws Exception {
    JSONObject data = new JSONObject();

    data.put("version", 1);
    data.put("selected", selected == null ? JSONObject.NULL : selected);
    data.put("profiles", new JSONArray(profiles));

    File pending = File.createTempFile("profiles-", ".json", file.getParentFile());

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
