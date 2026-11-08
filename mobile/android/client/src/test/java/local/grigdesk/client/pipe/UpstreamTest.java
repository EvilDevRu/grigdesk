package local.grigdesk.client.pipe;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;

public class UpstreamTest {
  /**
   * Потеря ответа после принятого POST не разрешает транспортный повтор.
   * Сервер читает всё тело и фиксирует эффект, затем закрывает TLS без ответа.
   */
  @Test
  public void lostResponseDoesNotReplayPost() throws Exception {
    java.util.concurrent.atomic.AtomicInteger effects = new java.util.concurrent.atomic.AtomicInteger();
    byte[] payload = "единственное действие".getBytes(StandardCharsets.UTF_8);

    try (TlsFixture server = new TlsFixture((head, body, output) -> {
      assertEquals("POST", head.method());
      assertArrayEquals(payload, body.readAllBytes());
      effects.incrementAndGet();
    }); Upstream upstream = new Upstream(server.address(), server.pin, TlsFixture.keys("client"),
      new VersionGate(0, 1), (status, reason) -> {})) {
      HttpHead head = new HttpHead("POST /api/action HTTP/1.1",
        Map.of("content-length", Integer.toString(payload.length)));

      try (PipeResponse response = upstream.forward(head, new ByteArrayInputStream(payload))) {
        assertEquals(503, response.status);
      }

      assertEquals(1, effects.get());
      assertEquals(1, server.requests.size());
    }
  }

  /**
   * Настоящий mTLS-стенд принимает HTTP только после совпадения pin.
   * Cookie и привилегированные заголовки WebView не передаются машине.
   */
  @Test
  public void pinnedTlsPrecedesHttpAndForbiddenHeadersStayLocal() throws Exception {
    try (TlsFixture server = new TlsFixture((head, body, output) -> {
      TlsFixture.response(output, 200, "0.1", "ok".getBytes(StandardCharsets.US_ASCII));
    }); Upstream upstream = new Upstream(server.address() + "/", server.pin, TlsFixture.keys("client"),
      new VersionGate(0, 1), (status, reason) -> {})) {
      Map<String, String> headers = new LinkedHashMap<>();

      headers.put("host", "127.0.0.1:47101");
      headers.put("origin", "http://127.0.0.1:47101");
      headers.put("cookie", "grigdesk_pipe=fixture-secret");
      headers.put("x-grigdesk-token", "fixture-token");
      headers.put("x-grigdesk-window-key", "fixture-key");
      headers.put("forwarded", "fixture");
      headers.put("x-forwarded-for", "fixture");

      try (PipeResponse response = upstream.forward(
        new HttpHead("GET /api/x HTTP/1.1", headers), new ByteArrayInputStream(new byte[0]))) {
        assertEquals(200, response.status);
        assertEquals("ok", new String(response.body.readAllBytes(), StandardCharsets.UTF_8));
      }

      assertEquals(1, server.requests.size());
      assertEquals(server.address().substring("https://".length()),
        server.requests.get(0).headers.get("host"));
      assertEquals(server.address(), server.requests.get(0).headers.get("origin"));

      for (String name : new String[] { "cookie", "x-grigdesk-token", "x-grigdesk-window-key",
        "forwarded", "x-forwarded-for" }) {
        assertNull(server.requests.get(0).headers.get(name));
      }
    }
  }

  /**
   * Чужой сертификат отсекается до первого HTTP-запроса.
   * Несовместимая версия защёлкивает отказ до создания нового транспорта.
   */
  @Test
  public void wrongPinSendsNoHttpAndVersionFailureLatches() throws Exception {
    AtomicReference<String> state = new AtomicReference<>();

    try (TlsFixture server = new TlsFixture((head, body, output) -> {
      TlsFixture.response(output, 200, "1.0", new byte[0]);
    }); Upstream wrong = new Upstream(server.address(), "0".repeat(64), TlsFixture.keys("client"),
      new VersionGate(0, 1), (status, reason) -> state.set(status));
      Upstream valid = new Upstream(server.address(), server.pin, TlsFixture.keys("client"),
        new VersionGate(0, 1), (status, reason) -> state.set(status))) {
      HttpHead request = new HttpHead("GET /api/x HTTP/1.1", Map.of());

      try (PipeResponse response = wrong.forward(request, new ByteArrayInputStream(new byte[0]))) {
        assertEquals(503, response.status);
        assertEquals("identityMismatch", state.get());
      }

      assertEquals(0, server.requests.size());

      try (PipeResponse response = valid.forward(request, new ByteArrayInputStream(new byte[0]))) {
        assertEquals(426, response.status);
        assertEquals("incompatible", state.get());
      }

      int count = server.requests.size();

      try (PipeResponse response = valid.forward(request, new ByteArrayInputStream(new byte[0]))) {
        assertEquals(426, response.status);
      }

      assertEquals(count, server.requests.size());
    }
  }
  /**
   * HTTP-ошибка и обрыв одного запроса не меняют состояние живого профиля.
   * Только явный probe вправе сообщить online или offline.
   */
  @Test
  public void requestFailuresDoNotReportConnectionState() throws Exception {
    java.util.List<String> states = new java.util.concurrent.CopyOnWriteArrayList<>();

    try (TlsFixture server = new TlsFixture((head, body, output) -> {
      if (head.target().equals("/api/broken")) {
        return;
      }
      TlsFixture.response(output, head.target().equals("/api/fail") ? 500 : 200,
        "0.1", "{}".getBytes(StandardCharsets.UTF_8));
    }); Upstream upstream = new Upstream(server.address(), server.pin, TlsFixture.keys("client"),
      new VersionGate(0, 1), (status, reason) -> states.add(status))) {
      upstream.probe();
      assertEquals(java.util.List.of("online"), states);
      try (PipeResponse response = upstream.forward(new HttpHead("GET /api/fail HTTP/1.1", Map.of()),
        new ByteArrayInputStream(new byte[0]))) {
        assertEquals(500, response.status);
      }
      assertEquals(java.util.List.of("online"), states);
      try (PipeResponse response = upstream.forward(new HttpHead("GET /api/broken HTTP/1.1", Map.of()),
        new ByteArrayInputStream(new byte[0]))) {
        assertEquals(503, response.status);
      }
      assertEquals(java.util.List.of("online"), states);
    }
  }

  /**
   * Состояние ключа проверяется перед handshake, где Conscrypt может потерять причину.
   * Даже отказ выбора клиентского alias в TLS не скрывает необходимость разблокировки.
   */
  @Test
  public void authenticationIsCheckedBeforeTlsCanHideTheCause() throws Exception {
    javax.net.ssl.X509KeyManager real = TlsFixture.keys("client");
    javax.net.ssl.X509KeyManager locked = new javax.net.ssl.X509KeyManager() {
      public String[] getClientAliases(String type, java.security.Principal[] issuers) {
        return real.getClientAliases(type, issuers);
      }
      public String chooseClientAlias(String[] types, java.security.Principal[] issuers,
        java.net.Socket socket) {
        return null;
      }
      public String[] getServerAliases(String type, java.security.Principal[] issuers) {
        return null;
      }
      public String chooseServerAlias(String type, java.security.Principal[] issuers,
        java.net.Socket socket) {
        return null;
      }
      public java.security.cert.X509Certificate[] getCertificateChain(String alias) {
        return real.getCertificateChain(alias);
      }
      public java.security.PrivateKey getPrivateKey(String alias) {
        throw new IllegalStateException(new UserNotAuthenticatedException());
      }
    };
    AtomicReference<String> state = new AtomicReference<>();

    try (TlsFixture server = new TlsFixture((head, body, output) -> {
      TlsFixture.response(output, 200, "0.1", new byte[0]);
    }); Upstream upstream = new Upstream(server.address(), server.pin, locked,
      new VersionGate(0, 1), (status, reason) -> state.set(status))) {
      upstream.probe();
      assertEquals("locked", state.get());
      try (PipeResponse response = upstream.forward(new HttpHead("GET /api/x HTTP/1.1", Map.of()),
        new ByteArrayInputStream(new byte[0]))) {
        assertEquals(423, response.status);
      }
      assertTrue(server.requests.isEmpty());

      try (Upstream upgradeOnly = new Upstream(server.address(), server.pin, locked,
        new VersionGate(0, 1), (status, reason) -> state.set(status));
        ClientPipe pipe = new ClientPipe(0, "fixture-secret", ClientPipeTest.assets(), () -> upgradeOnly,
          (head, body) -> PipeResponse.error(404, "unknown"));
        java.net.Socket downstream = new java.net.Socket("127.0.0.1", pipe.port())) {
        downstream.setSoTimeout(3000);

        HttpHead response = ClientPipeTest.send(downstream, pipe.port(), "GET /api/socket",
          "Cookie: grigdesk_pipe=fixture-secret\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n");

        assertEquals(423, response.status());
        assertEquals("locked", state.get());
      }

    }
  }

  /**
   * Обычный API-запрос ограничивает TLS-handshake отдельно от бесконечного чтения SSE.
   * Молчащий TCP-peer не может навсегда занять работника или переключить профиль offline.
   */
  @Test
  public void silentTlsHandshakeHasConnectionDeadline() throws Exception {
    java.util.concurrent.ExecutorService worker = java.util.concurrent.Executors.newSingleThreadExecutor();
    java.util.concurrent.atomic.AtomicReference<java.net.Socket> accepted =
      new java.util.concurrent.atomic.AtomicReference<>();

    try (java.net.ServerSocket server = new java.net.ServerSocket(0, 1,
      java.net.InetAddress.getByName("127.0.0.1"));
      Upstream upstream = new Upstream("https://127.0.0.1:" + server.getLocalPort(), "1".repeat(64),
        TlsFixture.keys("client"), new VersionGate(0, 1), (status, reason) -> {})) {
      Thread accept = new Thread(() -> {
        try {
          accepted.set(server.accept());
        } catch (Exception ignored) {
          // Завершение собственного стенда может отменить ещё не принятый сокет.
        }
      });
      accept.setDaemon(true);
      accept.start();
      java.util.concurrent.Future<Integer> response = worker.submit(() -> {
        try (PipeResponse result = upstream.forward(new HttpHead("GET /api/x HTTP/1.1", Map.of()),
          new ByteArrayInputStream(new byte[0]))) {
          return result.status;
        }
      });
      assertEquals(Integer.valueOf(503), response.get(5, java.util.concurrent.TimeUnit.SECONDS));
    } finally {
      if (accepted.get() != null) {
        accepted.get().close();
      }
      worker.shutdownNow();
    }
  }

  private static final class UserNotAuthenticatedException extends java.security.InvalidKeyException {
  }


  /**
   * Несколько HTTP-запросов по одному TLS не повторяют аппаратный initSign.
   * Отдельный probe проверяет срок ключа даже при переиспользовании готового соединения.
   */
  @Test
  public void keyPreflightRunsForNewTlsAndProbeInsteadOfEveryRequest() throws Exception {
    javax.net.ssl.X509KeyManager real = TlsFixture.keys("client");
    java.util.concurrent.atomic.AtomicInteger checks = new java.util.concurrent.atomic.AtomicInteger();
    javax.net.ssl.X509KeyManager counting = new javax.net.ssl.X509KeyManager() {
      public String[] getClientAliases(String type, java.security.Principal[] issuers) {
        checks.incrementAndGet();
        return real.getClientAliases(type, issuers);
      }
      public String chooseClientAlias(String[] types, java.security.Principal[] issuers,
        java.net.Socket socket) {
        return real.chooseClientAlias(types, issuers, socket);
      }
      public String[] getServerAliases(String type, java.security.Principal[] issuers) {
        return real.getServerAliases(type, issuers);
      }
      public String chooseServerAlias(String type, java.security.Principal[] issuers,
        java.net.Socket socket) {
        return real.chooseServerAlias(type, issuers, socket);
      }
      public java.security.cert.X509Certificate[] getCertificateChain(String alias) {
        return real.getCertificateChain(alias);
      }
      public java.security.PrivateKey getPrivateKey(String alias) {
        return real.getPrivateKey(alias);
      }
    };

    try (TlsFixture server = new TlsFixture((head, body, output) -> {
      output.write(("HTTP/1.1 200 OK\r\nX-GrigDesk-Api: 0.1\r\nContent-Length: 0"
        + "\r\nConnection: keep-alive\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
      output.flush();
    }, true); Upstream upstream = new Upstream(server.address(), server.pin, counting,
      new VersionGate(0, 1), (status, reason) -> {})) {
      for (int index = 0; index < 3; index++) {
        try (PipeResponse response = upstream.forward(new HttpHead("GET /api/x HTTP/1.1", Map.of()),
          new ByteArrayInputStream(new byte[0]))) {
          assertEquals(200, response.status);
          response.body.readAllBytes();
        }
      }

      assertEquals(1, checks.get());
      upstream.probe();
      assertEquals(2, checks.get());
    }
  }
  /**
   * Мутации без объявленного тела доходят до машины без тела: OkHttp иначе
   * помечал бы их chunked без Content-Type, и Fastify отвечал 415 до обработчика.
   * Объявленное тело любой длины сохраняет прежнее пересылание.
   */
  @Test
  public void bodylessMutationsAreForwardedWithoutBody() throws Exception {
    byte[] payload = "подтверждение".getBytes(StandardCharsets.UTF_8);
    java.util.List<byte[]> bodies = new java.util.concurrent.CopyOnWriteArrayList<>();

    try (TlsFixture server = new TlsFixture((head, body, output) -> {
      bodies.add(body.readAllBytes());
      TlsFixture.response(output, 200, "0.1", "ok".getBytes(StandardCharsets.US_ASCII));
    }); Upstream upstream = new Upstream(server.address(), server.pin, TlsFixture.keys("client"),
      new VersionGate(0, 1), (status, reason) -> {})) {
      try (PipeResponse response = upstream.forward(
        new HttpHead("DELETE /api/chat/pending/x HTTP/1.1", Map.of()),
        new ByteArrayInputStream(new byte[0]))) {
        assertEquals(200, response.status);
      }

      assertNull(server.requests.get(0).headers.get("transfer-encoding"));
      assertNull(server.requests.get(0).headers.get("content-length"));

      try (PipeResponse response = upstream.forward(new HttpHead(
        "DELETE /api/chat/pending/y HTTP/1.1", Map.of("content-length", "0")),
        new ByteArrayInputStream(new byte[0]))) {
        assertEquals(200, response.status);
      }

      assertEquals("0", server.requests.get(1).headers.get("content-length"));
      assertNull(server.requests.get(1).headers.get("transfer-encoding"));

      try (PipeResponse response = upstream.forward(new HttpHead(
        "DELETE /api/chat/pending/z HTTP/1.1", Map.of("content-length",
          Integer.toString(payload.length))), new ByteArrayInputStream(payload))) {
        assertEquals(200, response.status);
      }

      assertArrayEquals(payload, bodies.get(2));
    }
  }

  /**
   * Заголовки диагностики проходят настоящий pinned TLS до чтения потокового тела.
   * Обычный сервер без подробной метрики не включает диагностику в мосте.
   */
  @Test
  public void timingIsOptionalAndPreservesServerCorrelation() throws Exception {
    try (TlsFixture server = new TlsFixture((head, body, output) -> {
      boolean detailed = head.target().equals("/api/timed");
      String timing = detailed ? "db;dur=2, grigdesk;dur=10.0" : "db;dur=2";

      output.write(("HTTP/1.1 200 OK\r\nX-GrigDesk-Api: 0.1\r\n"
        + "Server-Timing: " + timing + "\r\n"
        + "X-GrigDesk-Request: aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa\r\n"
        + "Connection: close\r\nContent-Length: 2\r\n\r\n{}").getBytes(StandardCharsets.US_ASCII));
      output.flush();
    }); Upstream upstream = new Upstream(server.address(), server.pin, TlsFixture.keys("client"),
      new VersionGate(0, 1), (status, reason) -> {})) {
      for (String path : new String[] { "/api/timed", "/api/plain" }) {
        try (PipeResponse response = upstream.forward(new HttpHead("GET " + path + " HTTP/1.1",
          Map.of()), new ByteArrayInputStream(new byte[0]))) {
          assertEquals(200, response.status);
          assertEquals("aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
            response.headers.get("x-grigdesk-request"));

          String timing = response.headers.get("server-timing");

          if (path.equals("/api/timed")) {
            assertTrue(timing.contains("grigdesk;dur=10.0"));
            assertTrue(timing.matches(".*grigdesk_pipe;dur=[0-9]+\\.[0-9]+.*"));
          } else {
            assertEquals("db;dur=2", timing);
          }

          assertEquals("{}", new String(response.body.readAllBytes(), StandardCharsets.UTF_8));
        }
      }
    }
  }
}
