package local.grigdesk.client.shell;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import javax.net.ssl.X509KeyManager;
import local.grigdesk.client.pipe.HttpHead;
import local.grigdesk.client.pipe.PipeResponse;
import local.grigdesk.client.pipe.StaticAssets;
import local.grigdesk.client.pipe.Upstream;
import local.grigdesk.client.pipe.VersionGate;
import org.json.JSONObject;

public final class Pairing {
  public interface Keys {
    X509KeyManager get() throws Exception;
  }

  private final ProfileStore store;
  private final Keys keys;
  private final int major;
  private final int minor;

  /**
   * Привязка разделяет постоянный профиль и фабрику ключа установки.
   * Версия приложения участвует и в pair, и в последующем подтверждении hello.
   */
  public Pairing(ProfileStore store, Keys keys, int major, int minor) {
    this.store = store;
    this.keys = keys;
    this.major = major;
    this.minor = minor;
  }

  /**
   * Одна личность установки используется и при повторе потерянного ответа pair.
   * Профиль сохраняется только после pin-проверенных pair и hello с тем же отпечатком.
   */
  public JSONObject add(String text) throws Exception {
    PairingPayload payload = PairingPayload.decode(text);
    String address = "https://" + payload.host + ":" + payload.port;

    try (Upstream upstream = new Upstream(address, payload.fp, keys.get(), new VersionGate(major, minor),
      (status, code) -> {})) {
      JSONObject body = new JSONObject();

      body.put("code", payload.code);
      JSONObject paired = json(upstream, "/api/client/pair", body).getJSONObject("server");

      JSONObject hello = json(upstream, "/api/client/hello", null);

      if (!payload.fp.equals(hello.optString("fp")) || !payload.fp.equals(paired.optString("fp"))) {
        throw new IllegalStateException("Это не тот сервер.");
      }

      return store.add(paired.getString("name"), address, payload.fp);
    }
  }

  /**
   * Смена адреса проверяет существующий pin через новый TLS-транспорт.
   * Ответ hello обязан подтвердить ту же личность до сохранения изменённого профиля.
   */
  public void verify(JSONObject profile) throws Exception {
    try (Upstream upstream = new Upstream(profile.getString("address"), profile.getString("fp"),
      keys.get(), new VersionGate(major, minor), (status, code) -> {})) {
      if (!profile.getString("fp").equals(json(upstream, "/api/client/hello", null).optString("fp"))) {
        throw new IllegalStateException("Это не тот сервер.");
      }
    }
  }

  /**
   * Управляющий ответ ограничен, а тело привязки никогда не попадает в диагностику.
   * Любой неуспех не создаёт профиль и требует явного исправления человеком.
   */
  private JSONObject json(Upstream upstream, String path, JSONObject value) throws Exception {
    byte[] bytes = value == null ? new byte[0] : value.toString().getBytes(StandardCharsets.UTF_8);
    HttpHead head = new HttpHead((value == null ? "GET " : "POST ") + path + " HTTP/1.1",
      value == null ? Map.of() : Map.of("content-length", Integer.toString(bytes.length),
        "content-type", "application/json"));

    try (PipeResponse response = upstream.forward(head, new ByteArrayInputStream(bytes))) {
      if (response.status != 200) {
        String error = new JSONObject(StaticAssets.readText(response.body, 65536)).optString("error");

        throw new IllegalStateException(ClientFailure.message(error));
      }

      return new JSONObject(StaticAssets.readText(response.body, 1024 * 1024));
    }
  }
}
