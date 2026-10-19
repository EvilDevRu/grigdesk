package local.grigdesk.client.pipe;

import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

public final class HttpHead {
  public final String first;
  public final Map<String, String> headers;

  public HttpHead(String first, Map<String, String> headers) {
    this.first = first;
    this.headers = new LinkedHashMap<>(headers);
  }

  /**
   * Заголовок ограничен 64 КиБ; чтение останавливается точно перед первым байтом тела.
   * Дубли framing-заголовков и переносы внутри значений не создают второй запрос.
   */
  public static HttpHead read(InputStream input) throws IOException {
    String first = line(input, 65536);

    if (first == null) {
      return null;
    }

    int size = first.length() + 2;
    Map<String, String> headers = new LinkedHashMap<>();

    while (true) {
      String value = line(input, 65536 - size);

      if (value == null) {
        throw new EOFException("Неполный заголовок HTTP");
      }

      size += value.length() + 2;

      if (size > 65536) {
        throw new IOException("Слишком большой заголовок HTTP");
      }

      if (value.isEmpty()) {
        break;
      }

      int colon = value.indexOf(':');
      String name = colon > 0 ? value.substring(0, colon).toLowerCase(Locale.ROOT) : "";

      if (!name.matches("[a-z0-9!#$%&'*+.^_`|~-]+")) {
        throw new IOException("Неверный заголовок HTTP");
      }

      if (headers.containsKey(name) && (name.equals("content-length") || name.equals("transfer-encoding")
        || name.equals("host") || name.equals("origin"))) {
        throw new IOException("Повтор framing-заголовка");
      }

      String text = value.substring(colon + 1).trim();

      headers.merge(name, text, (old, next) -> old + (name.equals("cookie") ? "; " : ", ") + next);
    }

    if (headers.containsKey("content-length") && headers.containsKey("transfer-encoding")) {
      throw new IOException("Неоднозначное тело HTTP");
    }

    return new HttpHead(first, headers);
  }

  /**
   * Принимается только CRLF, а контрольные байты и слишком длинные строки отклоняются.
   * Чистый EOF допустим только до первого байта очередного заголовка.
   */
  static String line(InputStream input, int limit) throws IOException {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();

    while (true) {
      int value = input.read();

      if (value < 0) {
        if (bytes.size() == 0) {
          return null;
        }

        throw new EOFException("Неполная строка HTTP");
      }

      if (value == '\r') {
        if (input.read() != '\n') {
          throw new IOException("Неверный конец строки HTTP");
        }

        return new String(bytes.toByteArray(), StandardCharsets.ISO_8859_1);
      }

      if (value == '\n' || value == 0 || (value < 32 && value != '\t') || bytes.size() >= limit) {
        throw new IOException("Неверная или слишком длинная строка HTTP");
      }

      bytes.write(value);
    }
  }

  public String method() {
    return first.split(" ", 3)[0];
  }

  /**
   * Request-target извлекается из ограниченной первой строки без чтения тела.
   * Повреждённая строка отвергается до выбора маршрута или машины.
   */
  public String target() throws IOException {
    String[] parts = first.split(" ", 3);

    if (parts.length != 3 || !parts[2].equals("HTTP/1.1")) {
      throw new IOException("Поддерживается HTTP/1.1");
    }

    return parts[1];
  }

  /**
   * Код ответа разбирается только из корректной первой строки HTTP.
   * Невалидный ответ не становится успешным завершением проксируемого запроса.
   */
  public int status() throws IOException {
    String[] parts = first.split(" ", 3);

    if (parts.length < 2 || !parts[0].equals("HTTP/1.1") || !parts[1].matches("[1-5][0-9]{2}")) {
      throw new IOException("Неверный ответ HTTP");
    }

    return Integer.parseInt(parts[1]);
  }

  /**
   * Сборка заголовка не меняет байты тела и не допускает инъекцию CRLF.
   * Имена уже нормализованы parser-ом либо построены самой трубой.
   */
  public byte[] encode() throws IOException {
    StringBuilder output = new StringBuilder(first).append("\r\n");

    for (Map.Entry<String, String> item : headers.entrySet()) {
      if (item.getKey().contains("\r") || item.getKey().contains("\n")
        || item.getValue().contains("\r") || item.getValue().contains("\n")) {
        throw new IOException("Неверный заголовок HTTP");
      }

      output.append(item.getKey()).append(": ").append(item.getValue()).append("\r\n");
    }

    return output.append("\r\n").toString().getBytes(StandardCharsets.ISO_8859_1);
  }
}
