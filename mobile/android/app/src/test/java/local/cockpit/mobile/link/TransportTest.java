package local.cockpit.mobile.link;

import static org.junit.Assert.*;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.KeyManager;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.X509ExtendedKeyManager;
import org.json.JSONObject;
import org.junit.Test;

/**
 * Реальные OkHttp/forwarder/relay/brain работают только на временных ключах и loopback.
 * Тест не заменяет проверку аппаратного Keystore/биометрии на физическом Android.
 */
public class TransportTest {

  /**
   * JVM транспорт использует отдельный корень только для этого прогона.
   * Настройки и сертификаты работающего Кокпита не читаются и не меняются.
   */
  private File root() {
    File directory = new File(System.getProperty("user.dir")).getAbsoluteFile();

    while (directory != null && !new File(directory, "tools/mobile").isFile()) {
      directory = directory.getParentFile();
    }

    if (directory == null) {
      throw new IllegalStateException("Корень тестового проекта отсутствует");
    }

    return directory;
  }

  /**
   * Сертификат и ключ тестового телефона создаются в собственном временном каталоге.
   * Реальный TLS проверяется с отдельной identity, не импортируя Android Keystore.
   */
  private X509ExtendedKeyManager keys(File directory) throws Exception {
    KeyStore store = KeyStore.getInstance("PKCS12");

    try (
      java.io.InputStream input = Files.newInputStream(new File(directory, "device.p12").toPath())
    ) {
      store.load(input, "test-only".toCharArray());
    }

    KeyManagerFactory factory = KeyManagerFactory.getInstance(
      KeyManagerFactory.getDefaultAlgorithm()
    );

    factory.init(store, "test-only".toCharArray());

    for (KeyManager manager : factory.getKeyManagers()) {
      if (manager instanceof X509ExtendedKeyManager) {
        return (X509ExtendedKeyManager) manager;
      }
    }

    throw new IllegalStateException("Test key manager отсутствует");
  }

  /**
   * Проверяется первая pair с cert, одновременный REST/SSE и 95 секунд heartbeat idle.
   * Поддельные monotonic часы затем блокируют все методы и старое поколение, не открывая новую пару.
   */
  @Test
  public void actualDualTlsIdleDeadlineAndPinFailures() throws Exception {
    File directory = Files.createTempDirectory("cockpit-jvm-tls-").toFile();
    Process process = new ProcessBuilder(
      "node",
      "--max-old-space-size=768",
      "tools/mobile-phone/jvm-stack.mts",
      directory.getPath()
    )
      .directory(root())
      .redirectError(new File(directory, "worker.log"))
      .start();
    BufferedReader lines = new BufferedReader(
      new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8)
    );
    PrintWriter commands = new PrintWriter(process.getOutputStream(), true, StandardCharsets.UTF_8);
    long[] now = { 0 };
    NativeSession session = new NativeSession(() -> now[0]);
    LocalForwarder forwarder = null;
    BrainClient client = null;

    try {
      java.util.concurrent.ExecutorService startup =
        java.util.concurrent.Executors.newSingleThreadExecutor();
      String ready;

      try {
        ready = startup.submit(lines::readLine).get(30, TimeUnit.SECONDS);
      } finally {
        startup.shutdownNow();
      }

      assertEquals("Изолированный Node стенд не запустился", "ready", ready);

      JSONObject fixture = new JSONObject(
        new String(
          Files.readAllBytes(new File(directory, "fixture.json").toPath()),
          StandardCharsets.UTF_8
        )
      );
      QrPayload qr = QrPayload.parse(fixture.getString("qr"));
      X509ExtendedKeyManager keys = keys(directory);
      long generation = session.unlock();

      forwarder = new LocalForwarder(new RelayDialer(qr.relay), session, generation);
      forwarder.start();

      CopyOnWriteArrayList<String> events = new CopyOnWriteArrayList<>();
      CopyOnWriteArrayList<String> states = new CopyOnWriteArrayList<>();

      client = new BrainClient(
        forwarder.port(),
        qr.brain.getString("fp"),
        keys,
        session,
        generation,
        () -> now[0],
        new BrainClient.Listener() {
          @Override
          public void event(String name, String data, long captured) {
            events.add(name);
          }

          @Override
          public void state(String state, long captured) {
            states.add(state);
          }
        }
      );
      assertTrue(new JSONObject(client.hello().body).isNull("device"));
      assertEquals(200, client.pair(qr.pair.getString("code"), "JVM телефон").status);

      JSONObject hello = new JSONObject(client.hello().body);

      assertEquals("JVM телефон", hello.getJSONObject("device").getString("name"));

      try (
        BrainClient wrongBrain = new BrainClient(
          forwarder.port(),
          "0".repeat(64),
          keys,
          session,
          generation,
          () -> now[0],
          new BrainClient.Listener() {
            @Override
            public void event(String name, String data, long captured) {
            }

            @Override
            public void state(String state, long captured) {
            }
          }
        )
      ) {
        Exception mismatch = assertThrows(Exception.class, wrongBrain::hello);

        assertTrue(BrainClient.hasCause(mismatch, java.security.cert.CertificateException.class));
      }
      client.startEvents();
      client.startEvents();

      BrainClient.Result accepted = client.request(
        "POST",
        "/api/mobile/v1/chats/integration-chat/messages",
        "{\"clientId\":\"jvm-message-001\",\"text\":\"Проверка Java\"}",
        "jvm-operation-001",
        System.currentTimeMillis()
      );

      assertEquals(202, accepted.status);
      commands.println("release");
      assertEquals("done", lines.readLine());

      long until = System.currentTimeMillis() + 5000;

      while (!events.contains("ready") && System.currentTimeMillis() < until) {
        Thread.sleep(20);
      }

      assertTrue(events.contains("ready"));
      assertEquals(200, client.request("GET", "/api/mobile/v1/chats", null, null, 0).status);
      Thread.sleep(95000);
      assertTrue(
        "SSE heartbeat не пережил 90 секунд idle",
        events.stream().filter("heartbeat"::equals).count() >= 5
      );
      assertTrue(forwarder.activePairs() >= 1);
      assertTrue(forwarder.activePairs() <= 8);
      assertEquals(200, client.hello().status);

      JSONObject wrongRelay = new JSONObject(qr.relay.toString()).put("fp", "0".repeat(64));
      java.util.ArrayList<java.net.Socket> attempted = new java.util.ArrayList<>();

      try {
        Exception mismatch = assertThrows(Exception.class, () ->
          new RelayDialer(wrongRelay).open(attempted::add)
        );

        assertTrue(BrainClient.hasCause(mismatch, java.security.cert.CertificateException.class));
      } finally {
        for (java.net.Socket socket : attempted) {
          socket.close();
        }
      }

      now[0] = 300000;

      long beforeSwitch = session.remaining();
      final BrainClient previousClient = client;
      long nextGeneration = session.rotate();

      forwarder.close();
      client.close();
      assertEquals(0, forwarder.activePairs());
      assertThrows(IllegalStateException.class, previousClient::hello);
      assertEquals(beforeSwitch, session.remaining());
      forwarder = new LocalForwarder(new RelayDialer(qr.relay), session, nextGeneration);
      forwarder.start();
      client = new BrainClient(
        forwarder.port(),
        qr.brain.getString("fp"),
        keys,
        session,
        nextGeneration,
        () -> now[0],
        new BrainClient.Listener() {
          @Override
          public void event(String name, String data, long captured) {
          }

          @Override
          public void state(String state, long captured) {
          }
        }
      );
      assertEquals(200, client.hello().status);
      assertEquals(beforeSwitch, session.remaining());
      now[0] = 600000;

      final BrainClient expired = client;

      assertThrows(IllegalStateException.class, expired::hello);
      assertThrows(IllegalStateException.class, expired::startEvents);
      assertThrows(IllegalStateException.class, () ->
        expired.request("GET", "/api/mobile/v1/chats", null, null, 0)
      );
      assertThrows(IllegalStateException.class, () ->
        expired.media(new File(directory, "media"), "device", "chat", "u:test.png")
      );
      assertThrows(IllegalStateException.class, () ->
        expired.downloadUpdate(new File(directory, "updates"))
      );
      session.lock();
      forwarder.close();
      client.close();
      assertEquals(0, forwarder.activePairs());
      assertThrows(IllegalStateException.class, expired::hello);
    } finally {
      session.lock();

      if (forwarder != null) {
        forwarder.close();
      }
      if (client != null) {
        client.close();
      }

      commands.println("close");

      if (!process.waitFor(10, TimeUnit.SECONDS)) {
        process.destroyForcibly();
        process.waitFor(10, TimeUnit.SECONDS);
      }

      try (java.util.stream.Stream<Path> files = Files.walk(directory.toPath())) {
        for (Path file : files.sorted(java.util.Comparator.reverseOrder()).toArray(Path[]::new)) {
          Files.deleteIfExists(file);
        }
      }
    }
  }
}
