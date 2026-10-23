package local.grigdesk.client.pipe;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.DataInputStream;
import java.io.InputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BiConsumer;
import local.grigdesk.client.shell.ProfileStore;
import local.grigdesk.client.shell.ShellApi;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class RoutedUpstreamTest {
  private static final byte[] LARGE = new byte[5 * 1024 * 1024];
  private static final byte[] FRAME = new byte[] { (byte) 0x82, (byte) 0x83, 1, 2, 3, 4, 0, (byte) 255, 17 };

  static {
    new java.util.Random(17).nextBytes(LARGE);
  }

  /**
   * Сервер различает потерю ответа, управляемую загрузку, SSE и raw upgrade.
   * Оба пути ведут к одному TLS и реестру эффектов, поэтому replay нельзя спрятать сменой маршрута.
   */
  private static final class Fixture implements AutoCloseable {
    final AtomicInteger effects = new AtomicInteger();
    final AtomicInteger upgrades = new AtomicInteger();
    final CountDownLatch uploadReceived = new CountDownLatch(1);
    final CountDownLatch releaseUpload = new CountDownLatch(1);
    final CountDownLatch releaseEvent = new CountDownLatch(1);
    final TlsFixture server;
    final PhoneDirectFixture direct;
    final PhoneRelayFixture relay;
    final JSONObject profile;
    volatile boolean loseResponse;
    volatile String failure;

    /**
     * Фикстура передаёт HTTP только после настоящего pinned TLS и не подменяет selector.
     * Ручные latch дают вернуть direct, пока POST, SSE и WebSocket ещё принадлежат relay.
     */
    Fixture() throws Exception {
      server = new TlsFixture((head, body, output) -> {
        if (head.target().equals("/api/upload")) {
          assertArrayEquals(LARGE, body.readAllBytes());
          effects.incrementAndGet();
          uploadReceived.countDown();
          assertTrue(releaseUpload.await(20, TimeUnit.SECONDS));

          if (!loseResponse) {
            TlsFixture.response(output, 200, "0.1", "accepted".getBytes(StandardCharsets.US_ASCII));
          }

          return;
        }

        if (head.target().equals("/api/events")) {
          output.write(("HTTP/1.1 200 OK\r\nX-GrigDesk-Api: 0.1\r\n"
            + "Content-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n"
            + "9\r\ndata: 1\n\n\r\n").getBytes(StandardCharsets.US_ASCII));
          output.flush();
          assertTrue(releaseEvent.await(20, TimeUnit.SECONDS));
          output.write("9\r\ndata: 2\n\n\r\n0\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
          output.flush();

          return;
        }

        if (head.headers.containsKey("upgrade")) {
          upgrades.incrementAndGet();
          output.write(("HTTP/1.1 101 Switching Protocols\r\nX-GrigDesk-Api: 0.1\r\n"
            + "Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
          output.flush();
          output.write(body.readNBytes(FRAME.length));
          output.flush();

          return;
        }

        byte[] response = (failure == null ? "{\"fp\":\"" + serverPin()
          + "\",\"device\":{\"id\":\"d12345678\"}}" : "{\"error\":\"" + failure + "\"}")
          .getBytes(StandardCharsets.UTF_8);

        TlsFixture.response(output, failure == null ? 200 : 403, "0.1", response);
      });
      direct = new PhoneDirectFixture(server.server.getLocalPort());
      relay = new PhoneRelayFixture(server.server.getLocalPort());
      profile = new JSONObject().put("id", "same-profile").put("name", "Машина")
        .put("kind", "remote").put("port", 47101).put("fp", server.pin)
        .put("address", "https://" + direct.route().getString("host") + ":" + direct.server.getLocalPort())
        .put("direct", new JSONArray().put(direct.route())).put("relay", relay.route());
    }

    private String serverPin() {
      return server.pin;
    }

    RoutedUpstream route(BiConsumer<String, String> report) throws Exception {
      return new RoutedUpstream(profile, TlsFixture.keys("client"), new VersionGate(0, 1), report);
    }

    /**
     * Latch освобождаются до закрытия сокетов, чтобы фоновые тестовые обработчики завершились.
     * Очистка не зависит от того, на каком assert остановился сценарий.
     */
    @Override
    public void close() throws Exception {
      releaseUpload.countDown();
      releaseEvent.countDown();
      direct.close();
      relay.close();
      server.close();
    }
  }

  /**
   * GET полностью вычитывает ответ и освобождает active-call перед следующей проверкой пути.
   * Проверяется настоящий HTTP, а не только callback состояния.
   */
  private void get(PipeTransport route) throws Exception {
    try (PipeResponse response = route.forward(new HttpHead("GET /api/value HTTP/1.1", Map.of()),
      new ByteArrayInputStream(new byte[0]))) {
      assertEquals(200, response.status);
      assertTrue(response.body.readAllBytes().length > 0);
    }
  }

  /**
   * Большая мутация передаётся один раз через общий forward с явной длиной.
   * Ожидание response происходит отдельно от управляемого момента принятия тела сервером.
   */
  private int upload(PipeTransport route) throws Exception {
    HttpHead head = new HttpHead("POST /api/upload HTTP/1.1", Map.of("content-length", "" + LARGE.length));

    try (PipeResponse response = route.forward(head, new ByteArrayInputStream(LARGE))) {
      response.body.readAllBytes();

      return response.status;
    }
  }

  /**
   * Вычитываются ровно девять байтов SSE без попытки прочитать следующий chunk.
   * readNBytes у Okio может вызвать read с нулевой длиной и ждать закрытый тестом latch.
   */
  private String readEvent(InputStream input) throws Exception {
    byte[] bytes = new byte[9];

    new DataInputStream(input).readFully(bytes);

    return new String(bytes, StandardCharsets.US_ASCII);
  }

  /**
   * Возврат LAN влияет только на новые запросы, не создавая новый профиль или ключ.
   * Счётчики настоящих внешних hello отличают direct от работы через relay.
   */
  @Test(timeout = 30000)
  public void lanRelayLanUsesOneProfile() throws Exception {
    try (Fixture f = new Fixture(); RoutedUpstream routed = f.route((status, code) -> {})) {
      String original = f.profile.toString();

      routed.probe();
      get(routed);
      assertEquals(0, f.relay.hellos.get());
      f.direct.unavailable();
      routed.probe();
      get(routed);
      assertTrue(f.relay.hellos.get() > 0);
      f.direct.enabled = true;
      routed.probe();

      int relayBefore = f.relay.hellos.get();

      get(routed);
      assertEquals(relayBefore, f.relay.hellos.get());
      assertEquals(original, f.profile.toString());
    }
  }

  /**
   * Принятый POST с потерянным ответом нельзя повторять на запасном пути.
   * Следующий безопасный probe вправе сменить путь только для нового запроса.
   */
  @Test(timeout = 30000)
  public void lostPostResponseIsNotReplayedOnOtherPath() throws Exception {
    try (Fixture f = new Fixture(); RoutedUpstream routed = f.route((status, code) -> {})) {
      routed.probe();
      f.loseResponse = true;
      f.releaseUpload.countDown();
      assertEquals(503, upload(routed));
      assertEquals(1, f.effects.get());
      assertEquals(0, f.relay.hellos.get());
      f.direct.unavailable();
      routed.probe();
      get(routed);
      assertTrue(f.relay.hellos.get() > 0);
      assertEquals(1, f.effects.get());
    }
  }

  /**
   * Восстановление direct не закрывает начатые relay POST и upgrade.
   * Двоичный кадр и большой файл завершаются в прежних сокетах ровно один раз.
   */
  @Test(timeout = 30000)
  public void directRecoveryDoesNotCancelMutationOrReplayUpgrade() throws Exception {
    ExecutorService worker = Executors.newCachedThreadPool();

    try (Fixture f = new Fixture(); RoutedUpstream routed = f.route((status, code) -> {})) {
      f.direct.unavailable();
      routed.probe();

      Future<Integer> upload = worker.submit(() -> upload(routed));

      assertTrue(f.uploadReceived.await(5, TimeUnit.SECONDS));

      try (ClientPipe pipe = new ClientPipe(0, "fixture-secret", ClientPipeTest.assets(), () -> routed,
        (head, body) -> PipeResponse.error(404, "unknown"));
        Socket socket = new Socket("127.0.0.1", pipe.port())) {
        socket.setSoTimeout(5000);

        HttpHead response = ClientPipeTest.send(socket, pipe.port(), "GET /api/socket",
          "Cookie: grigdesk_pipe=fixture-secret\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n");

        assertEquals(101, response.status());
        f.direct.enabled = true;
        routed.probe();
        get(routed);
        socket.getOutputStream().write(FRAME);
        socket.getOutputStream().flush();
        assertArrayEquals(FRAME, socket.getInputStream().readNBytes(FRAME.length));
        f.releaseUpload.countDown();
        assertEquals(Integer.valueOf(200), upload.get(5, TimeUnit.SECONDS));
        assertEquals(1, f.effects.get());
        assertEquals(1, f.upgrades.get());
      }
    } finally {
      worker.shutdownNow();
    }
  }

  /**
   * Неправильный outer pin блокирует token, неправильный inner pin блокирует code и HTTP.
   * Результат нельзя маскировать EOF или успешным запасным путём.
   */
  @Test(timeout = 30000)
  public void relayPinPrecedesHelloAndServerPinPrecedesPair() throws Exception {
    try (Fixture f = new Fixture()) {
      f.direct.unavailable();
      f.profile.getJSONObject("relay").put("fp", "0".repeat(64));

      java.util.concurrent.atomic.AtomicReference<String> publicCode =
        new java.util.concurrent.atomic.AtomicReference<>();
      java.util.concurrent.atomic.AtomicReference<String> publicStatus =
        new java.util.concurrent.atomic.AtomicReference<>();

      // Чужой сертификат ретранслятора не получает токен и выключает только путь relay:
      // у прямого пути собственный pin сервера, поэтому весь профиль не защёлкивается.
      try (RoutedUpstream wrongRelay = f.route((status, code) -> {
        publicStatus.set(status);
        publicCode.set(code);
      })) {
        wrongRelay.probe();
        assertEquals(0, f.relay.hellos.get());
        assertTrue(f.server.requests.isEmpty());
        assertEquals("offline", publicStatus.get());
        assertEquals("relay_pin_mismatch", publicCode.get());
      }

      f.profile.put("relay", f.relay.route());
      f.profile.put("fp", "0".repeat(64));

      try (RoutedUpstream wrongServer = f.route((status, code) -> publicCode.set(code))) {
        wrongServer.probe();
        assertTrue(f.relay.hellos.get() > 0);
        assertTrue(f.server.requests.isEmpty());
        assertEquals("identityMismatch", publicCode.get());
      }

      f.profile.put("fp", f.server.pin);
      f.relay.unsupported = true;

      try (RoutedUpstream oldRelay = f.route((status, code) -> publicCode.set(code))) {
        oldRelay.probe();
        assertEquals("relay_upgrade_required", publicCode.get());

        int count = f.relay.hellos.get();

        oldRelay.probe();
        assertEquals(count, f.relay.hellos.get());
        assertTrue(f.server.requests.isEmpty());
      }

      f.relay.close();

      try (RoutedUpstream unavailable = f.route((status, code) -> publicCode.set(code))) {
        unavailable.probe();
        assertEquals("offline", publicCode.get());
      }
    }
  }

  /**
   * Терминальный отказ любого текущего пути закрывает весь профиль без fallback.
   * Обычный ответ бизнес-API не участвует в этом тесте и не считается отзывом.
   */
  @Test(timeout = 30000)
  public void terminalFailureStopsAllPaths() throws Exception {
    for (String failure : List.of("device_revoked", "device_scope_forbidden", "pair_locked", "unpaired")) {
      try (Fixture f = new Fixture(); RoutedUpstream routed = f.route((status, code) -> {})) {
        f.failure = failure;
        routed.probe();

        int requests = f.server.requests.size();

        f.failure = null;
        routed.probe();

        try (PipeResponse denied = routed.forward(new HttpHead("GET /api/private HTTP/1.1", Map.of()),
          new ByteArrayInputStream(new byte[0]))) {
          assertTrue(denied.status >= 400);
        }

        assertEquals(requests, f.server.requests.size());
        assertEquals(0, f.relay.hellos.get());
      }
    }
  }

  /**
   * Настоящий ShellApi отменяет пробный dial при фоне и сохраняет id, port и маршруты.
   * Возврат не повторяет прежнюю мутацию и не принимает callback закрытого поколения.
   */
  @Test(timeout = 30000)
  public void backgroundCancelsPendingDialAndResumeUsesSameProfile() throws Exception {
    Path root = Files.createTempDirectory("phone-background-");
    Path file = root.resolve("profiles.json");
    ExecutorService worker = Executors.newSingleThreadExecutor();

    try (Fixture f = new Fixture()) {
      ProfileStore store = profileStore(file, f);
      String id = store.profiles.get(0).getString("id");
      int port = store.get(id).getInt("port");
      List<RoutedUpstream> owners = new ArrayList<>();

      f.direct.stall = true;

      try (ShellApi shell = shell(store, f, new ArrayList<>(), owners, worker::execute)) {
        store.select(id);
        shell.connect(id, true);

        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);

        while (f.direct.accepted.get() == 0 && System.nanoTime() < deadline) {
          Thread.sleep(5);
        }

        assertTrue("Начат настоящий dial до ухода в фон", f.direct.accepted.get() > 0);
        shell.suspend();
        f.direct.stall = false;
        shell.resume(false);
        worker.submit(() -> {}).get(15, TimeUnit.SECONDS);
        assertEquals(id, store.selected);
        assertEquals(port, store.get(id).getInt("port"));
        assertEquals(f.relay.token, store.get(id).getJSONObject("relay").getString("token"));
        assertEquals(0, f.effects.get());
      }

      worker.shutdown();
      assertTrue(worker.awaitTermination(15, TimeUnit.SECONDS));
    } finally {
      worker.shutdownNow();
      Files.deleteIfExists(file);
      Files.deleteIfExists(root);
    }
  }

  /**
   * Три неуспешных фоновых direct probe не делают рабочий relay offline.
   * SSE и уже принятая загрузка продолжаются, затем новые запросы возвращаются в LAN.
   */
  @Test(timeout = 45000)
  public void failedDirectProbesKeepRelayOnline() throws Exception {
    Path root = Files.createTempDirectory("phone-health-");
    Path file = root.resolve("profiles.json");
    ExecutorService worker = Executors.newSingleThreadExecutor();

    try (Fixture f = new Fixture()) {
      ProfileStore store = profileStore(file, f);
      String id = store.profiles.get(0).getString("id");
      List<Runnable> callbacks = new ArrayList<>();
      List<RoutedUpstream> owners = new ArrayList<>();

      f.direct.unavailable();

      try (ShellApi shell = shell(store, f, callbacks, owners, Runnable::run)) {
        store.select(id);
        shell.connect(id, true);

        RoutedUpstream route = owners.get(0);

        try (PipeResponse events = route.forward(new HttpHead("GET /api/events HTTP/1.1", Map.of()),
          new ByteArrayInputStream(new byte[0]))) {
          assertEquals("data: 1\n\n", readEvent(events.body));

          Future<Integer> upload = worker.submit(() -> upload(route));

          assertTrue(f.uploadReceived.await(5, TimeUnit.SECONDS));
          f.direct.stall = true;

          for (int cycle = 0; cycle < 3; cycle++) {
            callbacks.get(callbacks.size() - 1).run();
            assertEquals("online", shell.state.snapshot().getString("status"));
            assertEquals(1, owners.size());
            assertEquals(1, f.effects.get());
          }

          f.releaseEvent.countDown();
          assertEquals("data: 2\n\n", readEvent(events.body));
          f.releaseUpload.countDown();
          assertEquals(Integer.valueOf(200), upload.get(5, TimeUnit.SECONDS));
          long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);

          while (!f.direct.sockets.isEmpty() && System.nanoTime() < deadline) {
            Thread.sleep(5);
          }

          assertTrue("Пробные direct-сокеты должны быть закрыты", f.direct.sockets.isEmpty());
          f.direct.stall = false;
          f.direct.enabled = true;
          callbacks.get(callbacks.size() - 1).run();

          int before = f.relay.hellos.get();

          get(route);
          assertEquals(before, f.relay.hellos.get());
          assertEquals(id, store.selected);
          assertEquals(1, f.effects.get());
        }
      }
    } finally {
      worker.shutdownNow();
      Files.deleteIfExists(file);
      Files.deleteIfExists(root);
    }
  }

  /**
   * Профиль создаётся штатным store, затем получает проверенные маршруты той же личности.
   * Тест не меняет формат durable-файла ради обхода production-валидации нового QR.
   */
  private ProfileStore profileStore(Path file, Fixture f) throws Exception {
    ProfileStore store = new ProfileStore(file.toFile(), port -> true);
    JSONObject profile = store.add("Машина", f.profile.getString("address"), f.server.pin);

    profile.put("direct", f.profile.getJSONArray("direct"));
    profile.put("relay", f.profile.getJSONObject("relay"));

    return store;
  }

  /**
   * Единственным владельцем health остаётся ShellApi со своим штатным scheduler.
   * Callback child проходит через настоящий routed owner, а не подменяется готовым online.
   */
  private ShellApi shell(ProfileStore store, Fixture f, List<Runnable> callbacks,
    List<RoutedUpstream> owners, java.util.function.Consumer<Runnable> worker) {
    return new ShellApi(store, null, (profile, gate, report) -> {
      RoutedUpstream routed = new RoutedUpstream(profile, TlsFixture.keys("client"), gate,
        (status, code) -> report.accept(status, code));

      owners.add(routed);

      return new ShellApi.Transport() {
        public void probe() throws Exception {
          routed.probe();
        }
        public void close() {
          routed.close();
        }
        public PipeTransport pipe() {
          return routed;
        }
      };
    }, (callback, delay) -> {
      callbacks.add(callback);

      return () -> {};
    }, worker, id -> {}, null, () -> 0.5, 0, 1);
  }
}
