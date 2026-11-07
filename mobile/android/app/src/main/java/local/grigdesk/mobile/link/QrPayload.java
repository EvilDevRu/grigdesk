package local.grigdesk.mobile.link;

import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import org.json.JSONObject;

/**
 * QR проверяется до создания ключа, prompt и любых сетевых соединений.
 * Каноническое base64url не допускает padding, скрытый мусор или подмену типа поля.
 */
public final class QrPayload {

  private static final String LINK_PREFIX = "grigdesklink:1:";

  public final JSONObject brain;
  public final JSONObject relay;
  public final JSONObject pair;

  private QrPayload(JSONObject value) throws Exception {
    brain = value.getJSONObject("brain");
    relay = value.getJSONObject("relay");
    pair = value.has("pair") ? value.getJSONObject("pair") : null;
  }

  /**
   * Весь текст и все поля ограничены независимо от способа получения QR.
   * Ошибка не содержит исходный token или код привязки.
   */
  public static QrPayload parse(String text) {
    try {
      if (
        text == null ||
        !text.startsWith(LINK_PREFIX) ||
        text.getBytes(StandardCharsets.UTF_8).length > 4096
      ) {
        throw new IllegalArgumentException();
      }

      byte[] bytes = strictBase64(text.substring(LINK_PREFIX.length()), -1);
      String json = StandardCharsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes))
        .toString();
      JSONObject value = new JSONObject(json);

      if (!(value.get("v") instanceof Number) || value.getDouble("v") != 1) {
        throw new IllegalArgumentException();
      }

      QrPayload result = new QrPayload(value);

      boundedString(result.brain, "name", 200);
      fingerprint(result.brain.get("fp"));
      validateRelay(result.relay);

      if (result.pair != null) {
        strictBase64(result.pair.getString("code"), 24);

        Object exp = result.pair.get("exp");

        if (
          !(exp instanceof Number) ||
          result.pair.getDouble("exp") != result.pair.getLong("exp") ||
          result.pair.getLong("exp") <= 0
        ) {
          throw new IllegalArgumentException();
        }
      }

      return result;
    } catch (Exception exception) {
      throw new IllegalArgumentException(
        "Неверный код привязки. Возьмите QR в настройках GrigDesk."
      );
    }
  }

  /**
   * Один validator используется для QR и приватного store после перезапуска.
   * Host является адресом посредника, а не URL с путём, userinfo или заголовком.
   */
  public static void validateRelay(JSONObject relay) throws Exception {
    boundedString(relay, "id", 200);
    boundedString(relay, "name", 200);

    Object host = relay.get("host");
    Object port = relay.get("port");

    if (
      !(host instanceof String) ||
      !((String) host).matches("[A-Za-z0-9.:-]{1,253}") ||
      !(port instanceof Number) ||
      relay.getDouble("port") != relay.getInt("port") ||
      relay.getInt("port") < 1 ||
      relay.getInt("port") > 65535
    ) {
      throw new IllegalArgumentException();
    }

    fingerprint(relay.get("fp"));
    strictBase64(relay.getString("token"), 32);
  }

  /**
   * Каноническое представление исключает неоднозначные последние биты base64url.
   * Размер секретного поля проверяется по декодированным байтам.
   */
  public static byte[] strictBase64(String text, int length) {
    if (text == null || !text.matches("[A-Za-z0-9_-]+")) {
      throw new IllegalArgumentException();
    }

    byte[] bytes = Base64.getUrlDecoder().decode(text);

    if (
      !Base64.getUrlEncoder().withoutPadding().encodeToString(bytes).equals(text) ||
      (length >= 0 && bytes.length != length)
    ) {
      throw new IllegalArgumentException();
    }

    return bytes;
  }

  public static void fingerprint(Object value) {
    if (!(value instanceof String) || !((String) value).matches("[a-f0-9]{64}")) {
      throw new IllegalArgumentException();
    }
  }

  public static void boundedString(JSONObject value, String key, int max) throws Exception {
    Object raw = value.get(key);

    if (
      !(raw instanceof String) || ((String) raw).trim().isEmpty() || ((String) raw).length() > max
    ) {
      throw new IllegalArgumentException();
    }
  }
}
