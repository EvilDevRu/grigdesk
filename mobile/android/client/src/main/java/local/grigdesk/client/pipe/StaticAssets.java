package local.grigdesk.client.pipe;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Collection;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import local.grigdesk.client.key.Pins;
import org.json.JSONArray;
import org.json.JSONObject;

public final class StaticAssets {
  public interface Source {
    InputStream open(String path) throws IOException;
    Collection<String> files() throws IOException;
  }

  private final Source source;
  private final Map<String, Long> files = new LinkedHashMap<>();

  /**
   * Manifest проверяется по той же канонической последовательности полей, что Node.
   * Все файлы, размеры и SHA сверяются до первой загрузки интерфейса.
   */
  public StaticAssets(Source source) throws Exception {
    this(source, "Установка повреждена");
  }

  public StaticAssets(Source source, String installationFailure) throws Exception {
    this.source = source;

    JSONObject release = new JSONObject(readText(source.open("release.json"), 2 * 1024 * 1024));
    JSONArray list = release.getJSONArray("files");
    StringBuilder canonical = new StringBuilder("[");

    if (release.getInt("version") != 1 || list.length() == 0 || list.length() > 10000) {
      throw new IOException(installationFailure);
    }

    for (int index = 0; index < list.length(); index++) {
      JSONObject file = list.getJSONObject(index);
      String name = file.getString("path");
      long size = file.getLong("size");
      String hash = file.getString("sha256");

      if (!safe(name) || name.equals("release.json") || files.containsKey(name)
        || size < 0 || size > 256L * 1024 * 1024 || !hash.matches("[a-f0-9]{64}")) {
        throw new IOException(installationFailure);
      }

      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      long actual = 0;
      byte[] bytes = new byte[8192];

      try (InputStream input = source.open(name)) {
        int count;

        while ((count = input.read(bytes)) != -1) {
          digest.update(bytes, 0, count);
          actual += count;

          if (actual > size) {
            throw new IOException(installationFailure);
          }
        }
      }

      if (actual != size || !hex(digest.digest()).equals(hash)) {
        throw new IOException(installationFailure);
      }

      if (index > 0) {
        canonical.append(',');
      }

      canonical.append("{\"path\":\"").append(name).append("\",\"size\":").append(size)
        .append(",\"sha256\":\"").append(hash).append("\"}");
      files.put(name, size);
    }

    canonical.append(']');

    Set<String> actual = new HashSet<>(source.files());

    actual.remove("release.json");

    if (!files.containsKey("index.html") || !actual.equals(files.keySet())
      || !Pins.sha256Hex(canonical.toString().getBytes(StandardCharsets.UTF_8))
        .equals(release.getString("id"))) {
      throw new IOException(installationFailure);
    }
  }

  /**
   * Имя ресурса остаётся относительным путём внутри проверенного пакета.
   * Скрытые сегменты и специальные символы не расширяют область чтения assets.
   */
  private static boolean safe(String name) {
    if (name.isEmpty() || name.length() >= 240) {
      return false;
    }

    for (String part : name.split("/", -1)) {
      if (!part.matches("[a-zA-Z0-9_.-]+") || part.equals(".") || part.equals("..")) {
        return false;
      }
    }

    return true;
  }

  /**
   * Отпечаток переводится в единый нижний hex без зависимости от локали.
   * Каждый байт сохраняет два разряда для сравнения с Node-манифестом.
   */
  private static String hex(byte[] bytes) {
    StringBuilder value = new StringBuilder();

    for (byte item : bytes) {
      value.append(String.format(java.util.Locale.ROOT, "%02x", item & 255));
    }

    return value.toString();
  }

  /**
   * Неизвестный путь не становится HTML и не попадает к удалённой машине.
   * Ресурсы пакета immutable; index всегда проверяется заново без кэша.
   */
  public PipeResponse get(String path) throws IOException {
    String name = path.equals("/") ? "index.html" : path.substring(1);

    if (!files.containsKey(name)) {
      return PipeResponse.error(404, "not_found");
    }

    Map<String, String> headers = new LinkedHashMap<>();

    headers.put("content-type", mime(name));
    headers.put("cache-control", name.equals("index.html")
      ? "no-cache" : "public, max-age=31536000, immutable");
    headers.put("x-content-type-options", "nosniff");

    return new PipeResponse(200, headers, source.open(name), files.get(name), () -> {});
  }

  /**
   * Тип определяется локальным расширением запечатанного ресурса.
   * Неизвестные файлы остаются бинарными и не получают произвольный HTML-тип.
   */
  private static String mime(String name) {
    if (name.endsWith(".html")) {
      return "text/html; charset=utf-8";
    }

    if (name.endsWith(".js")) {
      return "text/javascript; charset=utf-8";
    }

    if (name.endsWith(".css")) {
      return "text/css; charset=utf-8";
    }

    if (name.endsWith(".json")) {
      return "application/json";
    }

    if (name.endsWith(".svg")) {
      return "image/svg+xml";
    }

    if (name.endsWith(".png")) {
      return "image/png";
    }

    if (name.endsWith(".webp")) {
      return "image/webp";
    }

    if (name.endsWith(".woff2")) {
      return "font/woff2";
    }

    if (name.endsWith(".wasm")) {
      return "application/wasm";
    }


    return "application/octet-stream";
  }

  /**
   * Служебный JSON читается с лимитом, а переданные файлы остаются потоками.
   * Закрывается только выделенный поток ресурса или тела запроса.
   */
  public static String readText(InputStream input, int limit) throws IOException {
    try (InputStream body = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
      byte[] buffer = new byte[8192];
      int count;

      while ((count = body.read(buffer)) != -1) {
        if (output.size() + count > limit) {
          throw new IOException("Слишком большой запрос");
        }

        output.write(buffer, 0, count);
      }

      return new String(output.toByteArray(), StandardCharsets.UTF_8);
    }
  }
}
