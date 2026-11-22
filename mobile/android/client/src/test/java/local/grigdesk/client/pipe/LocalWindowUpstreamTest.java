package local.grigdesk.client.pipe;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;

public class LocalWindowUpstreamTest {
  /**
   * Сервер проверяет действующий ключ и сессию, а транспорт ждёт готовности ключа.
   * После перезапуска новая cookie обслуживает API без выдачи полномочий WebView.
   */
  @Test
  public void probeWaitsForWindowKeyAndRotatesSessionBeforeForwarding() throws Exception {
    AtomicReference<String> key = new AtomicReference<>("a".repeat(43));
    AtomicReference<String> availableKey = new AtomicReference<>();
    AtomicReference<String> status = new AtomicReference<>();
    AtomicInteger exchanges = new AtomicInteger();
    var worker = Executors.newSingleThreadExecutor();

    try (ServerSocket server = new ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"));
      Upstream upstream = new Upstream(server.getLocalPort(), () -> readKey(availableKey),
        new VersionGate(0, 1), (state, reason) -> status.set(state))) {
      var serving = worker.submit(() -> {
        serve(server, key, exchanges);

        return null;
      });

      upstream.probe();
      assertEquals("offline", status.get());
      assertEquals(0, exchanges.get());

      availableKey.set(key.get());
      upstream.probe();
      assertEquals("online", status.get());
      assertEquals(1, exchanges.get());

      key.set("b".repeat(43));
      availableKey.set(key.get());
      HttpHead request = new HttpHead("GET /api/projects HTTP/1.1",
        Map.of("cookie", "grigdesk_pipe=webview", "x-grigdesk-window-key", "webview"));

      try (PipeResponse result = upstream.forward(request, new ByteArrayInputStream(new byte[0]))) {
        assertEquals(200, result.status);
        assertFalse(result.headers.containsKey("set-cookie"));
        assertEquals(2, exchanges.get());
      }

      serving.get(5, TimeUnit.SECONDS);
    } finally {
      worker.shutdownNow();
    }
  }

  private static String readKey(AtomicReference<String> availableKey) throws IOException {
    String key = availableKey.get();

    if (key == null) {
      throw new IOException("Ключ ещё не готов");
    }

    return key;
  }

  /**
   * Два обмена ключа окружают probe и закрытый запрос к проектам после перезапуска.
   * Сокет закрывается после каждого ответа, чтобы fixture не зависела от пула OkHttp.
   */
  private static void serve(ServerSocket server, AtomicReference<String> key, AtomicInteger exchanges)
    throws Exception {
    for (int index = 0; index < 4; index++) {
      try (Socket socket = server.accept()) {
        socket.setSoTimeout(3000);
        HttpHead head = HttpHead.read(socket.getInputStream());

        if (head.target().equals("/api/auth/window-session")) {
          exchanges.incrementAndGet();
          assertEquals(key.get(), head.headers.get("x-grigdesk-window-key"));
          answer(socket, "Set-Cookie: " + cookie(key.get()) + "; HttpOnly\r\n", "{}");
        } else {
          assertEquals(cookie(key.get()), head.headers.get("cookie"));
          assertFalse(head.headers.containsKey("x-grigdesk-window-key"));
          String body = head.target().equals("/api/auth/state") ? "{\"authenticated\":true}" : "{}";

          answer(socket, "Set-Cookie: unexpected=value\r\n", body);
        }
      }
    }
  }

  private static String cookie(String key) {
    return "grigdesk_sid=session-" + key.charAt(0);
  }

  /**
   * Фикстура отвечает с версией API и закрывает ровно один HTTP-обмен.
   * Содержание симулирует лишь протокол входа и закрытого запроса.
   */
  private static void answer(Socket socket, String headers, String json) throws IOException {
    byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
    String head = "HTTP/1.1 200 OK\r\nX-GrigDesk-Api: 0.1\r\nConnection: close\r\n"
      + headers + "Content-Length: " + bytes.length + "\r\n\r\n";

    socket.getOutputStream().write(head.getBytes(StandardCharsets.US_ASCII));
    socket.getOutputStream().write(bytes);
  }
}
