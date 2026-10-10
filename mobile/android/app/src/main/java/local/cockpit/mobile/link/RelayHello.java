package local.cockpit.mobile.link;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import org.json.JSONObject;

public final class RelayHello {

  private RelayHello() {
  }

  public static byte[] encodeDevice(String token) {
    QrPayload.strictBase64(token, 32);

    return ("{\"v\":1,\"role\":\"device\",\"token\":\"" + token + "\"}\n").getBytes(
      StandardCharsets.UTF_8
    );
  }

  /**
   * Ответ не передаёт произвольный текст ошибки дальше в UI или журнал.
   * Неизвестный код и повреждённая строка закрывают внешний TLS.
   */
  public static String parseReply(String line) throws Exception {
    if (line.getBytes(StandardCharsets.UTF_8).length > 2048) {
      throw new IllegalArgumentException("Ответ посредника повреждён");
    }

    JSONObject value = new JSONObject(line);

    if (Boolean.TRUE.equals(value.opt("ok"))) {
      return "ok";
    }

    String error = value.optString("error");

    if (
      !Boolean.FALSE.equals(value.opt("ok")) ||
      !Arrays.asList(
        "bad_hello",
        "bad_version",
        "bad_role",
        "unauthorized",
        "brain_offline",
        "brain_timeout",
        "busy",
        "unknown_id",
        "banned"
      ).contains(error)
    ) {
      throw new IllegalArgumentException("Ответ посредника повреждён");
    }

    return error;
  }
}
