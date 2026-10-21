package local.grigdesk.client.shell;

import java.util.HashMap;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

public final class ShellState {
  private final ProfileStore store;
  private final ShellLocale locale;
  private final int major;
  private final int minor;
  private final Map<String, JSONObject> states = new HashMap<>();
  private long rev;

  public ShellState(ProfileStore store, int major, int minor) {
    this(store, major, minor, null);
  }

  /**
   * Снимок использует тот же переводчик установки, что endpoint и собственные окна.
   * Старый конструктор сохраняет прежний контракт без обязательного поля locale.
   */
  public ShellState(ProfileStore store, int major, int minor, ShellLocale locale) {
    this.locale = locale;
    this.store = store;
    this.major = major;
    this.minor = minor;
  }

  public synchronized void changed() {
    rev++;
    notifyAll();
  }

  public synchronized String status(String id) {
    return states.containsKey(id) ? states.get(id).optString("status", "offline") : "none";
  }

  /**
   * Повтор одинакового ответа не увеличивает ревизию и не раскручивает long-poll.
   * В публичное состояние попадают причина и версия, без pin, портов и ключей.
   */
  public synchronized void report(String id, String status, String code, String server) throws Exception {
    JSONObject connection = new JSONObject();

    connection.put("status", status);
    connection.put("detail", code == null ? JSONObject.NULL : new JSONObject().put("code", code));
    connection.put("serverApi", server == null ? JSONObject.NULL : version(server));

    if (!connection.toString().equals(String.valueOf(states.get(id)))) {
      states.put(id, connection);
      changed();
    }
  }

  /**
   * Срок повтора передаётся UI как данные состояния вместе с причиной offline.
   * Подписчик long-poll получает новую ревизию после назначения таймера.
   */
  public synchronized void retryAt(String id, long time) throws Exception {
    JSONObject connection = states.get(id);
    JSONObject detail = connection.optJSONObject("detail");

    if (detail == null) {
      detail = new JSONObject();
      connection.put("detail", detail);
    }

    detail.put("retryAt", time);
    changed();
  }

  private JSONObject version(String text) throws Exception {
    String[] parts = text.split("\\.");

    return new JSONObject().put("major", Long.parseLong(parts[0])).put("minor", Long.parseLong(parts[1]));
  }

  /**
   * Публичный профиль копирует только поля, необходимые интерфейсу выбора машины.
   * Pin, внутренний порт и остальные приватные поля остаются в хранилище.
   */
  private JSONObject profile(JSONObject source) throws Exception {
    JSONObject result = new JSONObject();

    for (String key : new String[] { "id", "name", "kind", "address" }) {
      result.put(key, source.get(key));
    }

    result.put("status", status(source.getString("id")));

    return result;
  }

  /**
   * Снимок копируется при каждом ответе, чтобы UI не мог менять внутренние данные.
   * Без профиля оболочка остаётся доступной и объявляет нативные возможности Android.
   */
  public synchronized JSONObject snapshot() throws Exception {
    JSONObject result = new JSONObject();
    JSONArray profiles = new JSONArray();

    for (JSONObject item : store.profiles) {
      profiles.put(profile(item));
    }

    JSONObject connection = states.get(store.selected);

    if (locale != null) {
      result.put("locale", new JSONObject().put("preference", locale.preference())
        .put("systemLanguage", locale.systemLanguage()));
    }

    result.put("rev", rev);
    result.put("profiles", profiles);
    result.put("profile", store.selected == null ? JSONObject.NULL : profile(store.get(store.selected)));
    result.put("status", store.selected == null ? "none" : connection == null ? "offline"
      : connection.getString("status"));
    result.put("detail", connection == null ? JSONObject.NULL : connection.get("detail"));
    result.put("serverApi", connection == null ? JSONObject.NULL : connection.get("serverApi"));
    result.put("appApi", new JSONObject().put("major", major).put("minor", minor));
    result.put("localAvailable", false);
    result.put("capabilities", new JSONArray(new String[] { "scan", "save", "unlock" }));

    return result;
  }

  /**
   * Long-poll ждёт смены ревизии с общим сроком не более 25 секунд.
   * Ложное пробуждение не возвращает прежнюю ревизию раньше срока.
   */
  public synchronized JSONObject poll(long previous) throws Exception {
    long deadline = System.nanoTime() + 25000000000L;

    while (rev == previous && System.nanoTime() < deadline) {
      long remaining = Math.max(1, (deadline - System.nanoTime()) / 1000000);

      wait(remaining);
    }

    return snapshot();
  }
}
