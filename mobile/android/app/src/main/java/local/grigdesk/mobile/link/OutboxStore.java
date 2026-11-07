package local.grigdesk.mobile.link;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Native intent записывается до сети и связан с brain/device certificate identity.
 * Один файл ограничивает все POST операции, а очередь сообщений хранит прежний порядок и ключи.
 */
public final class OutboxStore {

  private final File file;
  private final String brainFp;
  private final String deviceFp;

  public OutboxStore(File directory, String brainFp, String deviceFp) {
    file = new File(directory, "outbox.json");
    this.brainFp = brainFp;
    this.deviceFp = deviceFp;
  }

  /**
   * Сохранённая очередь читается только после проверки owner и полного размера файла.
   * Повреждённый outbox не сбрасывается молча, чтобы не скрывать принятые операции.
   */
  public synchronized JSONArray read() throws Exception {
    if (!file.exists()) {
      return new JSONArray();
    }
    if (file.length() > 2 * 1024 * 1024) {
      throw new IllegalStateException("outbox_corrupt");
    }

    JSONObject envelope = new JSONObject(
      new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8)
    );

    if (
      envelope.getInt("version") != 1 ||
      !brainFp.equals(envelope.getString("brainFp")) ||
      !deviceFp.equals(envelope.getString("deviceFp"))
    ) {
      throw new IllegalStateException("outbox_corrupt");
    }

    JSONArray items = envelope.getJSONArray("items");

    if (items.length() > 100) {
      throw new IllegalStateException("outbox_corrupt");
    }

    for (int index = 0; index < items.length(); index += 1) {
      validate(items.getJSONObject(index));
    }

    return items;
  }

  /**
   * Повтор key принимает только прежние path/body/createdAt, никогда не подменяя эффект.
   * Бюджет проверяется до атомарной записи и до разрешения начала HTTP.
   */
  public synchronized void put(JSONObject input) throws Exception {
    JSONObject item = new JSONObject(input.toString());

    validate(item);

    JSONArray items = read();
    long order = 0;

    for (int index = 0; index < items.length(); index += 1) {
      JSONObject existing = items.getJSONObject(index);

      order = Math.max(order, existing.optLong("order"));

      if (existing.getString("idempotencyKey").equals(item.getString("idempotencyKey"))) {
        if (
          !existing.getString("path").equals(item.getString("path")) ||
          !existing.getString("body").equals(item.getString("body")) ||
          existing.getLong("createdAt") != item.getLong("createdAt")
        ) {
          throw new IllegalStateException("idempotency_conflict");
        }

        return;
      }
    }

    if (items.length() >= 100) {
      throw new IllegalStateException("outbox_full");
    }

    item.put("order", order + 1);

    String route = item.getString("path");

    if (route.endsWith("/messages")) {
      JSONObject body = new JSONObject(item.getString("body"));

      item.put("clientId", body.getString("clientId"));
      item.put("chatId", route.split("/")[5]);
    }

    items.put(item);
    save(items);
  }

  /**
   * Подтверждённый result или delivery proof снимает только одну прежнюю операцию.
   * Остальные сообщения сохраняют свою последовательность и fingerprint.
   */
  public synchronized void remove(String key) throws Exception {
    JSONArray items = read();
    JSONArray next = new JSONArray();

    for (int index = 0; index < items.length(); index += 1) {
      JSONObject item = items.getJSONObject(index);

      if (!item.getString("idempotencyKey").equals(key)) {
        next.put(item);
      }
    }

    save(next);
  }

  private void save(JSONArray items) throws Exception {
    byte[] bytes = new JSONObject()
      .put("version", 1)
      .put("brainFp", brainFp)
      .put("deviceFp", deviceFp)
      .put("items", items)
      .toString()
      .getBytes(StandardCharsets.UTF_8);

    if (bytes.length > 2 * 1024 * 1024) {
      throw new IllegalStateException("outbox_full");
    }

    LinkStore.atomic(file, bytes);
  }

  /**
   * Метаданные POST проверяются строго как числа/строки, без URL и произвольного метода.
   * Время назначено клиентом до первой попытки и остаётся неизменным после восстановления.
   */
  private static void validate(JSONObject item) throws Exception {
    if (
      !"POST".equals(item.get("method")) ||
      !Routes.allowed("POST", item.getString("path")) ||
      !(item.get("body") instanceof String) ||
      !item.getString("idempotencyKey").matches("[A-Za-z0-9_-]{8,80}") ||
      !(item.get("createdAt") instanceof Number) ||
      item.getDouble("createdAt") != item.getLong("createdAt") ||
      item.getLong("createdAt") < 0
    ) {
      throw new IllegalArgumentException("bad_operation");
    }

    new JSONObject(item.getString("body"));
  }
}
