package local.grigdesk.client.pipe;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import local.grigdesk.client.shell.ClientFailure;
import local.grigdesk.client.shell.Pairing;
import local.grigdesk.client.shell.ProfileStore;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/**
 * Восстановление путей телефона на настоящих TLS-фикстурах: первая привязка, отказы
 * ретранслятора, единый поиск пути и сроки проверки связи. Физический Android не заменяет.
 */
public class PhoneRouteRecoveryTest {
  private static HttpHead get(String target) throws Exception {
    return new HttpHead("GET " + target + " HTTP/1.1", Map.of());
  }

  private static JSONObject profile(String pin, PhoneDirectFixture direct, PhoneRelayFixture relay)
    throws Exception {
    JSONObject result = new JSONObject().put("fp", pin).put("direct", new JSONArray().put(direct.route()));

    if (relay != null) {
      result.put("relay", relay.route());
    }

    return result;
  }

  private static TlsFixture okServer() throws Exception {
    return new TlsFixture((head, body, output) ->
      TlsFixture.response(output, 200, "0.1", "{}".getBytes(StandardCharsets.UTF_8)));
  }

  /**
   * Ответ без Connection: close оставляет TLS-соединение в пуле OkHttp.
   * Так проверяется поведение пробы по уже открытому соединению.
   */
  private static void keepAlive(OutputStream output, String body) throws Exception {
    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);

    output.write(("HTTP/1.1 200 OK\r\nX-GrigDesk-Api: 0.1\r\nContent-Length: " + bytes.length
      + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
    output.write(bytes);
    output.flush();
  }

  /**
   * Сервер закрепляет маршрут за TLS-соединением: непривязанное остаётся в bootstrap
   * и отвечает device:null. Подтверждение привязки обязано прийти новым соединением.
   */
  @Test
  public void firstPairRequiresFreshAuthenticatedSocket() throws Exception {
    AtomicBoolean paired = new AtomicBoolean();
    Set<OutputStream> bootstrap = ConcurrentHashMap.newKeySet();
    Set<OutputStream> routed = ConcurrentHashMap.newKeySet();
    String[] pin = new String[1];

    try (TlsFixture server = new TlsFixture((head, body, output) -> {
      if (routed.add(output) && !paired.get()) {
        bootstrap.add(output);
      }

      body.readAllBytes();

      JSONObject value = new JSONObject().put("name", "Сервер").put("fp", pin[0]).put("device",
        bootstrap.contains(output) ? JSONObject.NULL : new JSONObject().put("id", "d12345678"));

      if (head.target().endsWith("/pair")) {
        paired.set(true);
        value.put("server", new JSONObject().put("name", "Сервер").put("fp", pin[0]));
      }

      keepAlive(output, value.toString());
    }, true); PhoneDirectFixture direct = new PhoneDirectFixture(server.server.getLocalPort())) {
      pin[0] = server.pin;

      Path directory = Files.createTempDirectory("phone-first-pair-");
      ProfileStore store = new ProfileStore(directory.resolve("profiles.json").toFile(), port -> true);
      JSONObject saved = new Pairing(store, () -> TlsFixture.keys("client"), 0, 1)
        .add(PhonePairingTest.payload(server.pin, new JSONArray().put(direct.route()), null));

      assertEquals("d12345678", saved.getString("deviceId"));
      assertEquals(1, store.profiles.size());
    }
  }

  /**
   * Десять одновременных запросов до выбора пути выполняют ровно одну пробу hello.
   * Остальные ждут её результата и не плодят отдельные child и forwarder.
   */
  @Test
  public void concurrentRequestsShareOneInitialProbe() throws Exception {
    AtomicInteger probes = new AtomicInteger();

    try (TlsFixture server = new TlsFixture((head, body, output) -> {
      if (head.target().endsWith("/hello")) {
        probes.incrementAndGet();
        Thread.sleep(300);
      }

      TlsFixture.response(output, 200, "0.1", "{}".getBytes(StandardCharsets.UTF_8));
    }); PhoneDirectFixture direct = new PhoneDirectFixture(server.server.getLocalPort());
      RoutedUpstream pipe = new RoutedUpstream(profile(server.pin, direct, null),
        TlsFixture.keys("client"), new VersionGate(0, 1), (status, code) -> {})) {
      ExecutorService pool = Executors.newFixedThreadPool(10);
      CountDownLatch start = new CountDownLatch(1);

      try {
        List<Future<Integer>> calls = new ArrayList<>();

        for (int index = 0; index < 10; index++) {
          calls.add(pool.submit(() -> {
            start.await();

            try (PipeResponse response = pipe.forward(get("/api/read"), InputStream.nullInputStream())) {
              return response.status;
            }
          }));
        }

        start.countDown();

        for (Future<Integer> call : calls) {
          assertEquals(200, (int) call.get(12, TimeUnit.SECONDS));
        }

        assertEquals("Один поиск пути на поколение", 1, probes.get());
      } finally {
        pool.shutdownNow();
      }
    }
  }

  /**
   * Несовместимый ретранслятор выключает только свой путь: direct остаётся рабочим
   * в том же транспорте, а профиль не получает терминальную защёлку.
   */
  @Test
  public void relayIncompatibilityDoesNotLatchDirect() throws Exception {
    try (TlsFixture server = okServer();
      PhoneDirectFixture direct = new PhoneDirectFixture(server.server.getLocalPort());
      PhoneRelayFixture relay = new PhoneRelayFixture(server.server.getLocalPort())) {
      List<String> states = new CopyOnWriteArrayList<>();

      direct.unavailable();
      relay.error = "bad_version";

      try (RoutedUpstream pipe = new RoutedUpstream(profile(server.pin, direct, relay),
        TlsFixture.keys("client"), new VersionGate(0, 1),
        (status, code) -> states.add(status + ":" + code))) {
        pipe.probe();
        assertTrue(states.toString(), states.contains("offline:relay_upgrade_required"));
        assertTrue(states.toString(),
          states.stream().noneMatch((state) -> state.startsWith("incompatible:")));

        direct.enabled = true;
        pipe.probe();

        try (PipeResponse response = pipe.forward(get("/api/read"), InputStream.nullInputStream())) {
          assertEquals(200, response.status);
        }
      }
    }
  }

  /**
   * Пока сервер не переподключил control после рестарта relay, ответ brain_offline временный.
   * Следующая проба того же транспорта находит путь через ретранслятор.
   */
  @Test
  public void relayOfflineRecoversWhenControlReturns() throws Exception {
    try (TlsFixture server = okServer();
      PhoneDirectFixture direct = new PhoneDirectFixture(server.server.getLocalPort());
      PhoneRelayFixture relay = new PhoneRelayFixture(server.server.getLocalPort())) {
      List<String> states = new CopyOnWriteArrayList<>();

      direct.unavailable();
      relay.error = "brain_offline";

      try (RoutedUpstream pipe = new RoutedUpstream(profile(server.pin, direct, relay),
        TlsFixture.keys("client"), new VersionGate(0, 1),
        (status, code) -> states.add(status + ":" + code))) {
        pipe.probe();
        assertEquals("offline:offline", states.get(states.size() - 1));

        relay.error = null;
        pipe.probe();
        assertEquals("online:null", states.get(states.size() - 1));

        try (PipeResponse response = pipe.forward(get("/api/read"), InputStream.nullInputStream())) {
          assertEquals(200, response.status);
        }
      }
    }
  }

  /**
   * Отвергнутый ретранслятором токен не означает отзыв устройства на сервере.
   * Причина видна как relay_unauthorized, а direct подключается без нового QR.
   */
  @Test
  public void relayTokenRefusalKeepsDirect() throws Exception {
    try (TlsFixture server = okServer();
      PhoneDirectFixture direct = new PhoneDirectFixture(server.server.getLocalPort());
      PhoneRelayFixture relay = new PhoneRelayFixture(server.server.getLocalPort())) {
      List<String> states = new CopyOnWriteArrayList<>();

      direct.unavailable();
      relay.error = "unauthorized";

      try (RoutedUpstream pipe = new RoutedUpstream(profile(server.pin, direct, relay),
        TlsFixture.keys("client"), new VersionGate(0, 1),
        (status, code) -> states.add(status + ":" + code))) {
        pipe.probe();
        assertEquals("offline:relay_unauthorized", states.get(states.size() - 1));
        assertTrue(states.toString(),
          states.stream().noneMatch((state) -> state.startsWith("unpaired:")));

        direct.enabled = true;
        pipe.probe();
        assertEquals("online:null", states.get(states.size() - 1));
      }
    }
  }

  /**
   * Поиск, запущенный прикладным запросом, не публикует offline: иначе каждый запрос
   * WebView отменял бы плановый повтор ShellApi. Ответ запросу несёт причину пути.
   */
  @Test
  public void requestProbeKeepsShellRetryAndExplainsRoute() throws Exception {
    try (TlsFixture server = okServer();
      PhoneDirectFixture direct = new PhoneDirectFixture(server.server.getLocalPort());
      PhoneRelayFixture relay = new PhoneRelayFixture(server.server.getLocalPort())) {
      List<String> states = new CopyOnWriteArrayList<>();

      direct.unavailable();
      relay.unsupported = true;

      try (RoutedUpstream pipe = new RoutedUpstream(profile(server.pin, direct, relay),
        TlsFixture.keys("client"), new VersionGate(0, 1),
        (status, code) -> states.add(status + ":" + code))) {
        try (PipeResponse response = pipe.forward(get("/api/read"), InputStream.nullInputStream())) {
          assertEquals(503, response.status);
          assertTrue(new String(response.body.readAllBytes(), StandardCharsets.UTF_8)
            .contains("relay_upgrade_required"));
        }

        assertFalse(states.toString(), states.stream().anyMatch((state) -> state.startsWith("offline:")));

        pipe.probe();
        assertEquals("offline:relay_upgrade_required", states.get(states.size() - 1));
      }
    }
  }

  /**
   * Health-проба ShellApi, попавшая на чужой тихий поиск, всё равно сообщает итог.
   * Тихий поиск запроса неуспешен, поэтому offline может прийти только от ожидавшей пробы;
   * без этого состояние connecting осталось бы без перехода и повтора.
   */
  @Test
  public void healthProbeWaitingForRequestProbePublishesResult() throws Exception {
    CountDownLatch helloStarted = new CountDownLatch(1);

    try (TlsFixture server = new TlsFixture((head, body, output) -> {
      helloStarted.countDown();
      Thread.sleep(500);
      TlsFixture.response(output, 503, "0.1", "{}".getBytes(StandardCharsets.UTF_8));
    }); PhoneDirectFixture direct = new PhoneDirectFixture(server.server.getLocalPort())) {
      List<String> states = new CopyOnWriteArrayList<>();
      ExecutorService pool = Executors.newSingleThreadExecutor();

      try (RoutedUpstream pipe = new RoutedUpstream(profile(server.pin, direct, null),
        TlsFixture.keys("client"), new VersionGate(0, 1), (status, code) -> states.add(status))) {
        Future<Integer> request = pool.submit(() -> {
          try (PipeResponse response = pipe.forward(get("/api/read"), InputStream.nullInputStream())) {
            return response.status;
          }
        });

        assertTrue(helloStarted.await(5, TimeUnit.SECONDS));
        pipe.probe();
        assertEquals(503, (int) request.get(5, TimeUnit.SECONDS));
        assertEquals(List.of("offline"), states);
      } finally {
        pool.shutdownNow();
      }
    }
  }

  /**
   * Долгий ACK ретранслятора (сервер дозванивается до минуты) укладывается в
   * рукопожатие, а мёртвый сервер на готовом соединении обнаруживается за секунды.
   */
  @Test
  public void relayProbeWaitsForAckButNotForDeadServer() throws Exception {
    AtomicInteger hellos = new AtomicInteger();
    CountDownLatch release = new CountDownLatch(1);

    try (TlsFixture server = new TlsFixture((head, body, output) -> {
      body.readAllBytes();

      if (head.target().endsWith("/hello") && hellos.incrementAndGet() > 1) {
        release.await(60, TimeUnit.SECONDS);

        return;
      }

      keepAlive(output, "{}");
    }, true); PhoneDirectFixture direct = new PhoneDirectFixture(server.server.getLocalPort());
      PhoneRelayFixture relay = new PhoneRelayFixture(server.server.getLocalPort())) {
      List<String> states = new CopyOnWriteArrayList<>();

      direct.unavailable();
      relay.delay = 11000;

      try (RoutedUpstream pipe = new RoutedUpstream(profile(server.pin, direct, relay),
        TlsFixture.keys("client"), new VersionGate(0, 1), (status, code) -> states.add(status))) {
        pipe.probe();
        assertEquals("ACK дольше короткого чтения не рвёт рукопожатие", "online",
          states.get(states.size() - 1));

        long started = System.nanoTime();

        pipe.probe();

        long seconds = TimeUnit.NANOSECONDS.toSeconds(System.nanoTime() - started);

        assertEquals("offline", states.get(states.size() - 1));
        assertTrue("мёртвый сервер обнаружен за " + seconds + " с", seconds < 20);
      } finally {
        release.countDown();
      }
    }
  }

  /**
   * Пул WebView: несколько HTTP, SSE, WebSocket и простаивающие keep-alive через relay.
   * Двенадцать одновременных пар не упираются в прежний предел восьми соединений.
   */
  @Test
  public void relayAllowsBrowserStreamsBeyondEightConnections() throws Exception {
    try (TlsFixture server = new TlsFixture((head, body, output) -> {});
      PhoneRelayFixture relay = new PhoneRelayFixture(server.server.getLocalPort());
      RelayForwarder forwarder = new RelayForwarder(relay.route(), (error) -> {})) {
      List<Socket> sockets = new ArrayList<>();

      try {
        for (int index = 0; index < 12; index++) {
          sockets.add(new Socket("127.0.0.1", URI.create(forwarder.address()).getPort()));
        }

        long until = System.currentTimeMillis() + 4000;

        while (relay.hellos.get() < 12 && System.currentTimeMillis() < until) {
          Thread.sleep(10);
        }

        assertEquals(12, relay.hellos.get());
      } finally {
        for (Socket socket : sockets) {
          socket.close();
        }
      }
    }
  }

  /**
   * Upgrade через relay с задержанным ACK сохраняет бинарный поток без повтора запроса.
   * Кадр проходит через ClientPipe и обе TLS-обёртки байт в байт.
   */
  @Test
  public void delayedRelayUpgradeKeepsBinaryStream() throws Exception {
    byte[] frame = new byte[] { (byte) 0x82, 2, 17, (byte) 255 };

    try (TlsFixture server = new TlsFixture((head, input, output) -> {
      if (head.headers.containsKey("upgrade")) {
        output.write(("HTTP/1.1 101 Switching Protocols\r\nX-GrigDesk-Api: 0.1\r\n"
          + "Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        output.flush();
        output.write(input.readNBytes(frame.length));
        output.flush();
      } else {
        TlsFixture.response(output, 200, "0.1", "{}".getBytes(StandardCharsets.UTF_8));
      }
    }); PhoneDirectFixture direct = new PhoneDirectFixture(server.server.getLocalPort());
      PhoneRelayFixture relay = new PhoneRelayFixture(server.server.getLocalPort())) {
      direct.unavailable();

      try (RoutedUpstream routed = new RoutedUpstream(profile(server.pin, direct, relay),
        TlsFixture.keys("client"), new VersionGate(0, 1), (status, code) -> {})) {
        routed.probe();
        relay.delay = 3500;

        try (ClientPipe pipe = new ClientPipe(0, "fixture-secret", ClientPipeTest.assets(), () -> routed,
          (head, body) -> PipeResponse.error(404, "unknown"));
          Socket socket = new Socket("127.0.0.1", pipe.port())) {
          socket.setSoTimeout(12000);

          HttpHead response = ClientPipeTest.send(socket, pipe.port(), "GET /api/socket",
            "Cookie: grigdesk_pipe=fixture-secret\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n");

          assertEquals(101, response.status());
          socket.getOutputStream().write(frame);
          socket.getOutputStream().flush();
          assertArrayEquals(frame, socket.getInputStream().readNBytes(frame.length));
        }
      }
    }
  }

  /**
   * Привязка через несовместимый ретранслятор объясняет причину, а не «сервер недоступен».
   * Профиль не создаётся, а пустой listener привязки не теряет код пути.
   */
  @Test
  public void pairingThroughRefusedRelayExplainsReason() throws Exception {
    try (TlsFixture server = okServer();
      PhoneRelayFixture relay = new PhoneRelayFixture(server.server.getLocalPort())) {
      Path directory = Files.createTempDirectory("phone-relay-refused-");
      ProfileStore store = new ProfileStore(directory.resolve("profiles.json").toFile(), port -> true);

      relay.unsupported = true;

      try {
        new Pairing(store, () -> TlsFixture.keys("client"), 0, 1)
          .add(PhonePairingTest.payload(server.pin, new JSONArray(), relay.route()));
        fail("Несовместимый relay не может завершить привязку");
      } catch (IllegalStateException expected) {
        assertEquals(ClientFailure.message("relay_upgrade_required"), expected.getMessage());
      }

      assertEquals(0, store.profiles.size());
    }
  }

  /**
   * Неудачная проверка нового профиля не оставляет недособранную запись в памяти.
   * Следующее сохранение и повторное чтение файла видят только корректный профиль.
   */
  @Test
  public void failedProfileValidationCannotPoisonLaterSave() throws Exception {
    Path directory = Files.createTempDirectory("phone-profile-");
    Path file = directory.resolve("profiles.json");
    ProfileStore store = new ProfileStore(file.toFile(), port -> true);
    JSONArray routes = new JSONArray().put(new JSONObject().put("host", "192.0.2.1").put("port", 443));

    try {
      store.addPhone("", "a".repeat(64), routes, null, "d1");
      fail("Пустое имя сервера не может стать профилем");
    } catch (IllegalArgumentException expected) {
      assertNotEquals("", expected.getMessage());
    }

    store.addPhone("Сервер", "b".repeat(64), routes, null, "d2");
    assertEquals(1, store.profiles.size());
    assertEquals(1, new ProfileStore(file.toFile(), port -> true).profiles.size());
  }

  /**
   * Сервер блокирует перебор кодом 429 pair_locked; это терминально для привязки.
   * Прежние 401/403 проверяет RoutedUpstreamTest.
   */
  @Test
  public void pairLocked429IsTerminal() throws Exception {
    try (TlsFixture server = new TlsFixture((head, body, output) -> TlsFixture.response(output, 429, "0.1",
      "{\"error\":\"pair_locked\"}".getBytes(StandardCharsets.UTF_8)))) {
      List<String> states = new ArrayList<>();

      try (Upstream pipe = new Upstream(server.address(), server.pin, TlsFixture.keys("client"),
        new VersionGate(0, 1), (status, code) -> states.add(status + ":" + code));
        PipeResponse response = pipe.forward(get("/api/client/pair"), InputStream.nullInputStream())) {
        assertEquals(429, response.status);
        assertTrue(states.toString(), states.contains("unpaired:pair_locked"));
      }
    }
  }

  /**
   * Новые коды пути имеют собственное действие и без каталога локали.
   * Ни один не сводится к общему «сервер недоступен».
   */
  @Test
  public void routeCodesHaveOwnActionWithoutLocale() {
    String offline = ClientFailure.message("offline");

    assertTrue(ClientFailure.message("device_unknown").contains("QR"));

    for (String code : List.of("relay_upgrade_required", "relay_pin_mismatch", "relay_unauthorized")) {
      assertNotEquals(code, offline, ClientFailure.message(code));
    }
  }
}
