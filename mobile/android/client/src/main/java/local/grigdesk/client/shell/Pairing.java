package local.grigdesk.client.shell;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import javax.net.ssl.X509KeyManager;
import local.grigdesk.client.pipe.HttpHead;
import local.grigdesk.client.pipe.PipeResponse;
import local.grigdesk.client.pipe.StaticAssets;
import local.grigdesk.client.pipe.Upstream;
import local.grigdesk.client.pipe.RoutedUpstream;
import local.grigdesk.client.pipe.PipeTransport;
import local.grigdesk.client.pipe.VersionGate;
import org.json.JSONObject;

public final class Pairing {
  /**
   * Версия личности выбирается по профилю: старые записи используют единицу.
   * Свежий QR всегда запрашивает современный ключ, не меняя остальные привязки.
   */
  public interface Keys {
    X509KeyManager get(int clientKey) throws Exception;
  }

  private final ProfileStore store;
  private final Keys keys;
  private final int major;
  private final int minor;
  private final ShellLocale locale;

  /**
   * Привязка разделяет постоянный профиль и фабрику ключа установки.
   * Версия приложения участвует и в pair, и в последующем подтверждении hello.
   */
  public Pairing(ProfileStore store, Keys keys, int major, int minor) {
    this(store, keys, major, minor, null);
  }

  /**
   * Переводчик установки используется только для известных собственных отказов.
   * Пины, ключи и последовательность pair/hello от языка не зависят.
   */
  public Pairing(ProfileStore store, Keys keys, int major, int minor, ShellLocale locale) {
    this.store = store;
    this.keys = keys;
    this.major = major;
    this.minor = minor;
    this.locale = locale;
  }

  /**
   * Одна личность установки используется и при повторе потерянного ответа pair.
   * Профиль сохраняется только после pin-проверенных pair и hello с тем же отпечатком.
   */
  public JSONObject add(String text) throws Exception {
    if (text.startsWith("GRIGDESK:PHONE:2:")) {
      return addPhone(text);
    }

    PairingPayload payload = PairingPayload.decode(text);
    String address = "https://" + payload.host + ":" + payload.port;

    try (Upstream upstream = new Upstream(address, payload.fp, keys.get(2), new VersionGate(major, minor),
      (status, code) -> {})) {
      JSONObject body = new JSONObject();

      body.put("code", payload.code);
      JSONObject paired = json(upstream, "/api/client/pair", body).getJSONObject("server");

      JSONObject hello = json(upstream, "/api/client/hello", null);

      if (!payload.fp.equals(hello.optString("fp")) || !payload.fp.equals(paired.optString("fp"))) {
        throw new IllegalStateException(ClientFailure.message("identityMismatch", locale));
      }

      return store.add(paired.getString("name"), address, payload.fp, 2);
    }
  }

  /**
   * Один ключ установки и один код используются на всех маршрутах нового конверта.
   * Профиль появляется только после pair и authenticated hello с ожидаемой личностью.
   */
  private JSONObject addPhone(String text) throws Exception {
    JSONObject payload = PhonePairingPayload.decode(text);
    JSONObject server = payload.getJSONObject("server");
    JSONObject profile = new JSONObject().put("fp", server.getString("fp"))
      .put("direct", payload.getJSONArray("direct"));

    if (payload.has("relay")) {
      profile.put("relay", payload.getJSONObject("relay"));
    }

    if (payload.getJSONObject("pair").getDouble("exp") <= System.currentTimeMillis()) {
      throw new IllegalArgumentException(ClientFailure.message("pair_code_invalid", locale));
    }

    X509KeyManager installationKey = keys.get(2);
    JSONObject paired;

    try (RoutedUpstream upstream = new RoutedUpstream(profile, installationKey,
      new VersionGate(major, minor), (status, code) -> {})) {
      paired = json(upstream, "/api/client/pair", new JSONObject()
        .put("code", payload.getJSONObject("pair").getString("code")));
    }

    // Bootstrap закреплён за TLS-сокетом: подтверждение всегда использует новый транспорт.
    // Тот же ключ сохраняет личность установки и безопасный повтор потерянного pair.
    try (RoutedUpstream upstream = new RoutedUpstream(profile, installationKey,
      new VersionGate(major, minor), (status, code) -> {})) {
      JSONObject hello = json(upstream, "/api/client/hello", null);

      if (!server.getString("fp").equals(paired.getJSONObject("server").optString("fp"))
        || !server.getString("fp").equals(hello.optString("fp"))
        || hello.optJSONObject("device") == null) {
        throw new IllegalStateException(ClientFailure.message("identityMismatch", locale));
      }

      return store.addPhone(paired.getJSONObject("server").getString("name"), server.getString("fp"),
        payload.getJSONArray("direct"), payload.optJSONObject("relay"),
        hello.getJSONObject("device").getString("id"), 2);
    }
  }

  /**
   * Смена адреса проверяет существующий pin через новый TLS-транспорт.
   * Ответ hello обязан подтвердить ту же личность до сохранения изменённого профиля.
   */
  public void verify(JSONObject profile) throws Exception {
    try (Upstream upstream = new Upstream(profile.getString("address"), profile.getString("fp"),
      keys.get(profile.optInt("clientKey", 1)), new VersionGate(major, minor), (status, code) -> {})) {
      if (!profile.getString("fp").equals(json(upstream, "/api/client/hello", null).optString("fp"))) {
        throw new IllegalStateException(ClientFailure.message("identityMismatch", locale));
      }
    }
  }

  /**
   * Обновление маршрута проверяет прежний pin до сети и использует прежний ключ устройства.
   * Только новый authenticated hello разрешает атомарную замену адресов известного профиля.
   */
  public void updateRoutes(String id, String text) throws Exception {
    JSONObject expected = new JSONObject(store.get(id).toString());
    JSONObject payload = PhonePairingPayload.decode(text);
    String fp = expected.getString("fp");

    if (!fp.equals(payload.getJSONObject("server").getString("fp"))) {
      throw new IllegalStateException(ClientFailure.message("identityMismatch", locale));
    }

    if (payload.getJSONObject("pair").getDouble("exp") <= System.currentTimeMillis()) {
      throw new IllegalArgumentException(ClientFailure.message("pair_code_invalid", locale));
    }

    JSONObject candidate = new JSONObject().put("fp", fp).put("direct", payload.getJSONArray("direct"));

    if (payload.has("relay")) {
      candidate.put("relay", payload.getJSONObject("relay"));
    }

    X509KeyManager key = keys.get(expected.optInt("clientKey", 1));
    JSONObject paired;

    try (RoutedUpstream upstream = new RoutedUpstream(candidate, key,
      new VersionGate(major, minor), (status, code) -> {})) {
      paired = json(upstream, "/api/client/pair", new JSONObject()
        .put("code", payload.getJSONObject("pair").getString("code")));
    }

    try (RoutedUpstream upstream = new RoutedUpstream(candidate, key,
      new VersionGate(major, minor), (status, code) -> {})) {
      JSONObject hello = json(upstream, "/api/client/hello", null);
      JSONObject device = hello.optJSONObject("device");

      if (!fp.equals(paired.getJSONObject("server").optString("fp"))
        || !fp.equals(hello.optString("fp")) || device == null
        || expected.has("deviceId") && !expected.getString("deviceId").equals(device.optString("id"))) {
        throw new IllegalStateException(ClientFailure.message("identityMismatch", locale));
      }

      store.updateRoutes(expected, payload.getJSONArray("direct"), payload.optJSONObject("relay"),
        device.getString("id"));
    }
  }

  /**
   * Управляющий ответ ограничен, а тело привязки никогда не попадает в диагностику.
   * Любой неуспех не создаёт профиль и требует явного исправления человеком.
   */
  private JSONObject json(PipeTransport upstream, String path, JSONObject value) throws Exception {
    byte[] bytes = value == null ? new byte[0] : value.toString().getBytes(StandardCharsets.UTF_8);
    HttpHead head = new HttpHead((value == null ? "GET " : "POST ") + path + " HTTP/1.1",
      value == null ? Map.of() : Map.of("content-length", Integer.toString(bytes.length),
        "content-type", "application/json"));

    try (PipeResponse response = upstream.forward(head, new ByteArrayInputStream(bytes))) {
      if (response.status != 200) {
        String error = new JSONObject(StaticAssets.readText(response.body, 65536)).optString("error");

        throw new IllegalStateException(ClientFailure.message(error, locale));
      }

      return new JSONObject(StaticAssets.readText(response.body, 1024 * 1024));
    }
  }
}
