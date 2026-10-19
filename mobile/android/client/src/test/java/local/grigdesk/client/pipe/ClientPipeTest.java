package local.grigdesk.client.pipe;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import local.grigdesk.client.key.Pins;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class ClientPipeTest {
  /**
   * Пакет фикстуры строится тем же форматом инвентаря и отпечатка, что Node UI.
   * Проверка статики не подменяется выдачей произвольной директории.
   */
  static StaticAssets assets() throws Exception {
    Map<String, byte[]> files = new LinkedHashMap<>();

    files.put("index.html", "<div>fixture</div>".getBytes(StandardCharsets.UTF_8));
    files.put("api-version.json", "{\"major\":0,\"minor\":1}".getBytes(StandardCharsets.UTF_8));

    StringBuilder canonical = new StringBuilder("[");

    for (Map.Entry<String, byte[]> entry : files.entrySet()) {
      if (canonical.length() > 1) {
        canonical.append(',');
      }

      canonical.append("{\"path\":\"").append(entry.getKey()).append("\",\"size\":")
        .append(entry.getValue().length).append(",\"sha256\":\"")
        .append(Pins.sha256Hex(entry.getValue())).append("\"}");
    }

    canonical.append(']');

    JSONObject release = new JSONObject();

    release.put("version", 1);
    release.put("id", Pins.sha256Hex(canonical.toString().getBytes(StandardCharsets.UTF_8)));
    release.put("files", new JSONArray(canonical.toString()));
    files.put("release.json", release.toString().getBytes(StandardCharsets.UTF_8));

    return new StaticAssets(new StaticAssets.Source() {
      @Override
      public InputStream open(String path) {
        return new ByteArrayInputStream(files.get(path));
      }

      @Override
      public java.util.Collection<String> files() {
        return files.keySet();
      }
    });
  }

  /**
   * HTTP-байты записываются в существующее keep-alive соединение.
   * Ответ разбирается без скрытого создания нового клиента между запросами.
   */
  static HttpHead send(Socket socket, int port, String request, String extra) throws Exception {
    socket.getOutputStream().write((request + " HTTP/1.1\r\nHost: 127.0.0.1:" + port
      + "\r\n" + extra + "\r\n").getBytes(StandardCharsets.US_ASCII));
    socket.getOutputStream().flush();

    return HttpHead.read(socket.getInputStream());
  }

  /**
   * Секрет, Host и Origin проверяются до выдачи встроенных ресурсов.
   * Несколько запросов одного сокета сохраняют корректное разделение тел.
   */
  @Test
  public void cookieGateAssetsAndKeepAlive() throws Exception {
    try (ClientPipe pipe = new ClientPipe(0, "fixture-secret", assets(), () -> null,
      (head, body) -> PipeResponse.error(404, "unknown"))) {
      try (Socket socket = new Socket("127.0.0.1", pipe.port())) {
        HttpHead response = send(socket, pipe.port(), "GET /", "");

        assertEquals(403, response.status());
      }

      try (Socket socket = new Socket("127.0.0.1", pipe.port())) {
        String auth = "Cookie: grigdesk_pipe=fixture-secret\r\n";
        HttpHead response = send(socket, pipe.port(), "GET /", auth);

        assertEquals(200, response.status());
        assertEquals("no-cache", response.headers.get("cache-control"));
        assertEquals("<div>fixture</div>", StaticAssets.readText(
          BodyFraming.input(response, socket.getInputStream()), 1024));
        response = send(socket, pipe.port(), "GET /missing", auth);
        assertEquals(404, response.status());
        BodyFraming.input(response, socket.getInputStream()).readAllBytes();
        response = send(socket, pipe.port(), "GET /api/x", auth);
        assertEquals(503, response.status());
      }

      try (Socket socket = new Socket("127.0.0.1", pipe.port())) {
        assertEquals(403, send(socket, pipe.port(), "GET /",
          "Cookie: grigdesk_pipe=fixture-secret\r\nOrigin: https://foreign.invalid\r\n").status());
      }
    }
  }
  /**
   * Соседний порт является same-site, но не получает права локальной трубы.
   * Подставленная cookie с более узким Path не затеняет подлинный HttpOnly секрет.
   */
  @Test
  public void fetchSiteAndDuplicateCookies() throws Exception {
    try (ClientPipe pipe = new ClientPipe(0, "fixture-secret", assets(), () -> null,
      (head, body) -> PipeResponse.error(404, "unknown"))) {
      for (String site : new String[] { "same-site", "cross-site", "same-origin", "none" }) {
        try (Socket socket = new Socket("127.0.0.1", pipe.port())) {
          HttpHead response = send(socket, pipe.port(), "GET /",
            "Cookie: grigdesk_pipe=x; grigdesk_pipe=fixture-secret\r\nSec-Fetch-Site: " + site + "\r\n");
          assertEquals(site.equals("same-origin") || site.equals("none") ? 200 : 403, response.status());
        }
      }
    }
  }

  /**
   * Экран без выбранной машины возвращает понятный общий код API.
   * Внутреннее имя состояния none не выходит вместо причины отказа запроса.
   */
  @Test
  public void noMachineHasPublicErrorCode() throws Exception {
    try (ClientPipe pipe = new ClientPipe(0, "fixture-secret", assets(), () -> null,
      (head, body) -> PipeResponse.error(404, "unknown"), () -> "none");
      Socket socket = new Socket("127.0.0.1", pipe.port())) {
      HttpHead response = send(socket, pipe.port(), "GET /api/x", "Cookie: grigdesk_pipe=fixture-secret\r\n");
      String text = StaticAssets.readText(BodyFraming.input(response, socket.getInputStream()), 4096);

      assertEquals("no_machine", new JSONObject(text).getString("error"));
    }
  }

}
