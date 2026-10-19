package local.grigdesk.client.pipe;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import org.json.JSONObject;

public final class PipeResponse implements AutoCloseable {
  public final int status;
  public final Map<String, String> headers;
  public final InputStream body;
  public final long length;
  private final Runnable finish;

  /**
   * Ответ передаёт тело как поток и сохраняет отдельное действие освобождения.
   * Неизвестная длина позволяет передавать SSE и файлы без накопления в памяти.
   */
  public PipeResponse(int status, Map<String, String> headers, InputStream body, long length,
    Runnable finish) {
    this.status = status;
    this.headers = new LinkedHashMap<>(headers);
    this.body = body;
    this.length = length;
    this.finish = finish;
  }

  /**
   * Небольшой управляющий ответ кодируется в UTF-8 с явным типом JSON.
   * Ошибка построения не возвращает частичный успешный ответ.
   */
  public static PipeResponse json(int status, JSONObject value) {
    byte[] bytes = value.toString().getBytes(StandardCharsets.UTF_8);
    Map<String, String> headers = new LinkedHashMap<>();

    headers.put("content-type", "application/json; charset=utf-8");
    headers.put("cache-control", "no-store");

    return new PipeResponse(status, headers, new ByteArrayInputStream(bytes), bytes.length, () -> {});
  }

  public static PipeResponse error(int status, String code) {
    return json(status, new JSONObject(java.util.Collections.singletonMap("error", code)));
  }

  @Override
  public void close() throws IOException {
    try {
      body.close();
    } finally {
      finish.run();
    }
  }
}
