package local.grigdesk.mobile.link;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Настройки принадлежат private filesDir и публикуются атомарно после fsync.
 * Повреждение identity не создаёт новую привязку и не удаляет старый Keystore ключ.
 */
public final class LinkStore {

  public interface DirectorySync {
    void sync(File directory) throws Exception;
  }

  private static DirectorySync directorySync = directory -> {
    try (
      java.nio.channels.FileChannel channel = java.nio.channels.FileChannel.open(
        directory.toPath(),
        java.nio.file.StandardOpenOption.READ
      )
    ) {
      channel.force(true);
    }
  };
  private final File file;

  public static void useDirectorySync(DirectorySync sync) {
    directorySync = sync;
  }

  public LinkStore(File directory) {
    file = new File(directory, "link.json");
  }

  public static JSONObject empty() throws Exception {
    return new JSONObject()
      .put("brainName", "")
      .put("brainFp", "")
      .put("deviceName", "Телефон")
      .put("paired", false)
      .put("relays", new JSONArray())
      .put("activeRelayId", JSONObject.NULL);
  }

  /**
   * Чтение проверяет размер и весь список посредников до использования одного поля.
   * Только отсутствие файла обозначает ещё не настроенный телефон.
   */
  public synchronized JSONObject read() throws Exception {
    if (!file.exists()) {
      return empty();
    }
    if (file.length() > 262144L) {
      throw new IllegalStateException("Настройки повреждены");
    }

    JSONObject value = new JSONObject(
      new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8)
    );

    validate(value);

    return value;
  }

  public synchronized void save(JSONObject value) throws Exception {
    validate(value);
    atomic(file, value.toString().getBytes(StandardCharsets.UTF_8));
  }

  /**
   * Удаление активного посредника снимает выбор до следующего запуска сети.
   * Остальные записи и личность мозга остаются в той же durable версии файла.
   */
  public synchronized void removeRelay(String id) throws Exception {
    JSONObject value = read();
    JSONArray relays = value.getJSONArray("relays");
    JSONArray next = new JSONArray();

    for (int index = 0; index < relays.length(); index += 1) {
      JSONObject relay = relays.getJSONObject(index);

      if (!relay.getString("id").equals(id)) {
        next.put(relay);
      }
    }

    value.put("relays", next);

    if (id.equals(value.optString("activeRelayId"))) {
      value.put("activeRelayId", JSONObject.NULL);
    }

    save(value);
  }

  public synchronized void delete() throws Exception {
    Files.deleteIfExists(file.toPath());
  }

  /**
   * Валидная pending привязка содержит identity, но ещё не имеет paired/deviceId.
   * При чтении запрещены строковые числа и невалидные relay fingerprints.
   */
  private static void validate(JSONObject value) throws Exception {
    if (!(value.get("paired") instanceof Boolean) || value.getString("deviceName").length() > 200) {
      throw new IllegalStateException("Настройки повреждены");
    }

    JSONArray relays = value.getJSONArray("relays");

    if (relays.length() > 64) {
      throw new IllegalStateException("Слишком много посредников");
    }
    if (relays.length() > 0 || value.getBoolean("paired")) {
      QrPayload.fingerprint(value.get("brainFp"));
      QrPayload.boundedString(value, "brainName", 200);
    }

    java.util.Set<String> ids = new java.util.HashSet<>();

    for (int index = 0; index < relays.length(); index += 1) {
      JSONObject relay = relays.getJSONObject(index);

      QrPayload.validateRelay(relay);

      if (!ids.add(relay.getString("id"))) {
        throw new IllegalStateException("Повтор посредника");
      }
    }

    if (!value.isNull("activeRelayId") && !ids.contains(value.getString("activeRelayId"))) {
      throw new IllegalStateException("Выбранный посредник отсутствует");
    }
  }

  /**
   * Готовый файл появляется только после синхронизации содержимого временной записи.
   * Существующая версия не удаляется, если запись или rename завершились отказом.
   */
  public static void atomic(File target, byte[] bytes) throws Exception {
    File directory = target.getParentFile();

    if (!directory.isDirectory() && !directory.mkdirs()) {
      throw new IllegalStateException("Каталог настроек недоступен");
    }

    File temporary = new File(directory, target.getName() + ".tmp");

    try (FileOutputStream stream = new FileOutputStream(temporary)) {
      temporary.setReadable(false, false);
      temporary.setReadable(true, true);
      temporary.setWritable(false, false);
      temporary.setWritable(true, true);
      stream.write(bytes);
      stream.getFD().sync();
    }
    Files.move(
      temporary.toPath(),
      target.toPath(),
      StandardCopyOption.ATOMIC_MOVE,
      StandardCopyOption.REPLACE_EXISTING
    );
    directorySync.sync(directory);
  }
}
