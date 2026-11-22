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
  public static final String LOCAL_ID = "local";
  static final String LOCAL_NAME = "Это устройство";
  public String selected;
  public final List<JSONObject> profiles = new ArrayList<>();
  private final File file;
  private final IntPredicate available;
  private final ShellLocale locale;
  final boolean localAvailable;

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
    this(file, available, locale, false);
  }

  /**
   * Только пакет с собственным сервером создаёт локальный профиль при первом запуске.
   * После инициализации сохранённый выбор и явное удаление профиля переживают перезапуск.
   */
  public ProfileStore(File file, IntPredicate available, ShellLocale locale, boolean localAvailable)
    throws Exception {
    this.file = file;
    this.available = available;
    this.locale = locale;
    this.localAvailable = localAvailable;

    JSONObject data = null;

    if (file.exists() && file.length() != 0) {
      data = read();
    }
    if (localAvailable && (data == null || !data.optBoolean("localInitialized"))) {
      profiles.add(localProfile());

      if (selected == null) {
        selected = LOCAL_ID;
      }

      save();
    }
  }

  /**
   * Чтение проверяет все записи, включая зарезервированный ID локального сервера.
   * HTTP-адрес локального сервера принадлежит runtime и не читается из JSON.
   */
  private JSONObject read() throws Exception {
    if (file.length() > 1024 * 1024) {
      throw new IllegalArgumentException(
        ShellLocale.text(locale, "native.profilesDamaged", "Файл машин повреждён."));
    }

    JSONObject data = new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
    JSONArray list = data.getJSONArray("profiles");
    Set<String> ids = new HashSet<>();
    Set<Integer> ports = new HashSet<>();

    boolean hasLocalProfileFormat = data.optBoolean("localInitialized");

    if (data.getInt("version") != 1 || list.length() > (hasLocalProfileFormat ? 100 : 99)) {
      throw new IllegalArgumentException(
        ShellLocale.text(locale, "native.profilesDamaged", "Файл машин повреждён."));
    }

    for (int index = 0; index < list.length(); index++) {
      JSONObject profile = list.getJSONObject(index);

      String id = profile.getString("id");
      boolean local = LOCAL_ID.equals(id);

      if (local) {
        if (!hasLocalProfileFormat || !profile.getString("kind").equals("local")
          || !profile.getString("address").isEmpty()) {
          throw damaged();
        }

        validateName(profile.getString("name"));
      } else if (profile.has("relay") && profile.getString("address").isEmpty()) {
        validate(profile.getString("name"), "https://profile.invalid", profile.getString("fp"), locale);
      } else {
        validate(profile.getString("name"), profile.getString("address"), profile.getString("fp"), locale);
      }

      if (profile.has("direct")) {
        PhonePairingPayload.routes(profile.getJSONArray("direct"), profile.optJSONObject("relay"));
      }

      int port = profile.getInt("port");

      if ((!local && !profile.getString("kind").equals("remote")) || !ids.add(id)
        || !ports.add(port) || port < firstPort(id) || port >= firstPort(id) + 99) {
        throw damaged();
      }

      // Читатели виджета используют только профили с удалённым транспортом.
      if (!local || localAvailable) {
        profiles.add(profile);
      }
    }

    selected = data.optString("selected", null);

    if (selected != null && profiles.stream().noneMatch(item -> item.optString("id").equals(selected))) {
      selected = null;
    }

    return data;
  }

  private IllegalArgumentException damaged() {
    return new IllegalArgumentException(
      ShellLocale.text(locale, "native.profilesDamaged", "Файл машин повреждён."));
  }

  private JSONObject localProfile() throws Exception {
    return new JSONObject().put("id", LOCAL_ID).put("port", freePort(LOCAL_ID))
      .put("createdAt", System.currentTimeMillis()).put("kind", "local")
      .put("name", LOCAL_NAME).put("address", "");
  }

  /**
   * Явное добавление восстанавливает локальную карточку без QR и второго профиля.
   * Новый origin резервируется так же, как для удалённой машины.
   */
  synchronized JSONObject addLocal() throws Exception {
    for (JSONObject profile : profiles) {
      if (LOCAL_ID.equals(profile.optString("id"))) {
        return profile;
      }
    }

    JSONObject profile = localProfile();
    List<JSONObject> candidate = new ArrayList<>(profiles);

    candidate.add(profile);
    save(candidate);
    profiles.add(profile);

    return profile;
  }

  /**
   * Локальная карточка допускает изменение подписи, адрес закреплён самой сборкой.
   * Ошибка записи оставляет прежнюю подпись и в памяти, и на диске.
   */
  synchronized void renameLocal(String name) throws Exception {
    validateName(name);

    JSONObject current = get(LOCAL_ID);
    JSONObject updated = new JSONObject(current.toString()).put("name", name.trim());
    List<JSONObject> candidate = new ArrayList<>(profiles);
    int index = profiles.indexOf(current);

    candidate.set(index, updated);
    save(candidate);
    profiles.set(index, updated);
  }

  private void validateName(String name) {
    if (name.trim().isEmpty() || name.length() > 128) {
      throw new IllegalArgumentException(
        ShellLocale.text(locale, "native.invalidMachine", "Неверное имя или адрес машины."));
    }
  }

  private static int firstPort(String id) {
    return LOCAL_ID.equals(id) ? 47001 : 47101;
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
    int start = firstPort(id);

    for (int port = start; port < start + 99; port++) {
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
    return add(name, address, fp, 1);
  }

  /**
   * QR новой личности сохраняет пользовательское имя и origin уже известного pin.
   * Прежний метод используется явным редактированием имени и не стирает версию ключа.
   */
  public synchronized JSONObject add(String name, String address, String fp, int clientKey) throws Exception {
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

    if (clientKey == 1 || !profile.has("name")) {
      profile.put("name", name.trim());
    }

    profile.put("address", address);
    profile.put("fp", fp);

    if (clientKey != 1) {
      profile.put("clientKey", clientKey);
    }

    save();

    return profile;
  }

  /**
   * Приватные маршруты сохраняются по pin в той же записи и с прежним origin.
   * Пустая адресная проекция допустима только при проверенном relay-only профиле.
   */
  public synchronized JSONObject addPhone(String name, String fp, JSONArray direct,
    JSONObject relay, String deviceId) throws Exception {
    return addPhone(name, fp, direct, relay, deviceId, 1);
  }

  /**
   * Маршруты и устройство обновляются после QR, а имя и локальный порт остаются прежними.
   * Обычный вызов без версии сохраняет старую возможность явного переименования.
   */
  public synchronized JSONObject addPhone(String name, String fp, JSONArray direct,
    JSONObject relay, String deviceId, int clientKey) throws Exception {
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

    if (clientKey == 1 || !profile.has("name")) {
      profile.put("name", name.trim());
    }

    profile.put("fp", fp).put("address", address).put("direct", direct).put("deviceId", deviceId);

    if (clientKey != 1) {
      profile.put("clientKey", clientKey);
    }

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
   * Сеть проверяется вне блокировки, поэтому перед записью сверяется весь исходный профиль.
   * Файл заменяется до памяти: отказ сохранения оставляет прежние маршруты в обоих местах.
   */
  public synchronized void updateRoutes(JSONObject expected, JSONArray direct, JSONObject relay,
    String deviceId) throws Exception {
    JSONObject current = get(expected.getString("id"));

    if (!current.toString().equals(expected.toString())) {
      throw new IllegalStateException(
        ShellLocale.text(locale, "native.profileChanged", "Машина изменена. Повторите обновление."));
    }

    PhonePairingPayload.routes(direct, relay);
    JSONObject updated = new JSONObject(current.toString());
    String address = direct.length() == 0 ? "" : "https://"
      + direct.getJSONObject(0).getString("host") + ":" + direct.getJSONObject(0).getInt("port");

    updated.put("direct", direct).put("address", address).put("deviceId", deviceId);

    if (relay == null) {
      updated.remove("relay");
    } else {
      updated.put("relay", relay);
    }

    List<JSONObject> candidate = new ArrayList<>(profiles);
    int index = profiles.indexOf(current);

    candidate.set(index, updated);
    save(candidate);
    profiles.set(index, updated);
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
    save(profiles);
  }

  /**
   * Кандидат записывается без публикации в общей коллекции профилей.
   * Обычные операции используют тот же приватный atomic rename.
   */
  private void save(List<JSONObject> candidate) throws Exception {
    JSONObject data = new JSONObject();

    data.put("version", 1);
    if (localAvailable) {
      data.put("localInitialized", true);
    }
    data.put("selected", selected == null ? JSONObject.NULL : selected);
    data.put("profiles", new JSONArray(candidate));

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
