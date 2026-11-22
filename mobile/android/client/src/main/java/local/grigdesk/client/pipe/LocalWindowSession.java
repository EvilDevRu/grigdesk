package local.grigdesk.client.pipe;

import java.io.IOException;
import java.net.URI;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

final class LocalWindowSession {
  private static final String SESSION = "grigdesk_sid=";
  private final URI address;
  private final Upstream.WindowKey windowKey;
  private String acceptedKey;
  private String cookie;

  LocalWindowSession(URI address, Upstream.WindowKey windowKey) {
    this.address = address;
    this.windowKey = windowKey;
  }

  /**
   * Один обмен обслуживает параллельные запросы того же процесса сервера.
   * Новый ключ меняет сессию до отправки API-запроса или websocket upgrade.
   */
  synchronized String cookie(OkHttpClient client) throws IOException {
    String key = windowKey.read();

    if (!key.equals(acceptedKey) || cookie == null) {
      Request request = new Request.Builder().url(address.resolve("/api/auth/window-session").toString())
        .header("x-grigdesk-window-key", key)
        .post(RequestBody.create(new byte[0], null)).build();

      OkHttpClient bounded = client.newBuilder().callTimeout(3, TimeUnit.SECONDS).build();

      try (Response response = bounded.newCall(request).execute()) {
        if (response.code() == 200) {
          for (String value : response.headers("set-cookie")) {
            if (value.startsWith(SESSION)) {
              cookie = value.split(";", 2)[0];
              acceptedKey = key;
              return cookie;
            }
          }
        }
      }

      throw new IOException("Не удалось получить сессию локального сервера");
    }

    return cookie;
  }

  synchronized void reject(String sent) {
    if (sent != null && sent.equals(cookie)) {
      cookie = null;
    }
  }
}
