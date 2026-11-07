package local.grigdesk.client.shell;

import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;

public final class PhonePairingPayload {
  private static final String PREFIX = "GRIGDESK:PHONE:2:";

  private PhonePairingPayload() {
  }

  /**
   * Новый конверт допускает только конкретные адреса сервера без URL и секретов.
   * Loopback телефона не может обозначать компьютер, с которого выдан QR.
   */
  public static boolean validHost(String host) {
    if (host == null || !host.matches("[a-z0-9.-]{1,253}") || host.equals("localhost")
      || host.endsWith(".localhost")) {
      return false;
    }

    if (host.matches("[0-9.]+")) {
      String[] parts = host.split("\\.", -1);

      if (parts.length != 4) {
        return false;
      }

      for (String part : parts) {
        if (!part.matches("0|[1-9][0-9]{0,2}") || Integer.parseInt(part) > 255) {
          return false;
        }
      }

      int first = Integer.parseInt(parts[0]);

      return first > 0 && first < 224 && first != 127;
    }

    for (String part : host.split("\\.", -1)) {
      if (!part.matches("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")) {
        return false;
      }
    }

    return true;
  }

  /**
   * Каноничность проверяется обратным кодированием, включая хвостовые биты.
   * Padding не принимается как альтернативная запись того же секрета.
   */
  private static byte[] bytes(String value) {
    byte[] decoded = Base64.getUrlDecoder().decode(value);

    if (!Base64.getUrlEncoder().withoutPadding().encodeToString(decoded).equals(value)) {
      throw new IllegalArgumentException("Неверная строка привязки");
    }

    return decoded;
  }

  /**
   * org.json преобразует числа в строки, но wire требует исходный JSON-тип.
   * Строгая проверка совпадает с TypeScript и не исправляет повреждённый секрет.
   */
  private static String text(JSONObject value, String key) throws Exception {
    Object result = value.get(key);

    if (!(result instanceof String)) {
      throw new IllegalArgumentException("Неверный тип поля привязки");
    }

    return (String) result;
  }

  /**
   * Порт обязан быть целым числом JSON и оставаться в диапазоне TCP.
   * Адрес проверяется до передачи в DNS или нативный транспорт.
   */
  private static void address(JSONObject value) throws Exception {
    Object port = value.get("port");

    if (!validHost(text(value, "host")) || !(port instanceof Number)
      || ((Number) port).doubleValue() != value.getInt("port")
      || value.getInt("port") < 1 || value.getInt("port") > 65535) {
      throw new IllegalArgumentException("Неверный адрес привязки");
    }
  }

  /**
   * Валидация общая для QR и приватных маршрутов профиля после повторного запуска.
   * Она не выполняет сеть и не публикует токены в ShellState или текстах ошибок.
   */
  public static void routes(JSONArray direct, JSONObject relay) throws Exception {
    if (direct.length() > 8 || (direct.length() == 0 && relay == null)) {
      throw new IllegalArgumentException("Нет адресов привязки");
    }

    for (int index = 0; index < direct.length(); index++) {
      address(direct.getJSONObject(index));
    }

    if (relay != null) {
      address(relay);

      if (!Integer.valueOf(2).equals(relay.get("protocol")) || !text(relay, "fp").matches("[a-f0-9]{64}")
        || text(relay, "id").isEmpty() || text(relay, "name").isEmpty()
        || bytes(text(relay, "token")).length != 32) {
        throw new IllegalArgumentException("Неверный ретранслятор");
      }
    }
  }

  /**
   * Разбор PHONE:2 полностью предшествует TLS и не принимает старый формат PAIR:1.
   * Исключение содержит только фиксированное сообщение без исходного QR.
   */
  public static JSONObject decode(String text) {
    try {
      if (text == null || text.length() > 4096 || !text.startsWith(PREFIX)) {
        throw new IllegalArgumentException();
      }

      String json = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes(text.substring(PREFIX.length())))).toString();
      JSONObject value = new JSONObject(json);
      JSONObject server = value.getJSONObject("server");
      JSONObject pair = value.getJSONObject("pair");

      if (!Integer.valueOf(2).equals(value.get("v")) || text(server, "name").trim().isEmpty()
        || !text(server, "fp").matches("[a-f0-9]{64}")
        || bytes(text(pair, "code")).length != 24 || !(pair.get("exp") instanceof Number)
        || !Double.isFinite(pair.getDouble("exp"))) {
        throw new IllegalArgumentException();
      }

      if (value.has("relay") && !(value.get("relay") instanceof JSONObject)) {
        throw new IllegalArgumentException();
      }

      routes(value.getJSONArray("direct"), value.optJSONObject("relay"));

      return value;
    } catch (Exception invalid) {
      throw new IllegalArgumentException("Строка привязки недействительна.");
    }
  }
}
