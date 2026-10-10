package local.cockpit.mobile.link;

import static org.junit.Assert.*;

import java.io.File;
import java.nio.file.Files;
import java.util.Base64;
import java.util.Random;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class LinkLogicTest {

  /**
   * Новые настройки доступны только по явным маршрутам v1.
   * Расширение не открывает общий proxy, посторонние методы или вложенные пути.
   */
  @Test
  public void chatControlsRoutesStayBounded() {
    assertTrue(Routes.allowed("GET", "/api/mobile/v1/chat-options"));
    assertTrue(Routes.allowed("GET", "/api/mobile/v1/attention"));
    assertTrue(Routes.allowed("POST", "/api/mobile/v1/chats"));
    assertTrue(Routes.allowed("POST", "/api/mobile/v1/chats/chat-one/settings"));
    assertTrue(Routes.allowed("POST", "/api/mobile/v1/chats/chat-one/read"));
    assertTrue(Routes.allowed("POST", "/api/mobile/v1/chats/chat-one/workspace/preview"));
    assertTrue(Routes.allowed("POST", "/api/mobile/v1/chats/chat-one/workspace"));
    assertFalse(Routes.allowed("POST", "/api/mobile/v1/chat-options"));
    assertFalse(Routes.allowed("POST", "/api/mobile/v1/chats/chat-one/settings/extra"));
    assertFalse(Routes.allowed("POST", "/api/mobile/v1/chats/chat-one/workspace?path=/tmp"));
    assertFalse(Routes.allowed("POST", "/api/chat/workdir/change"));
  }

  private String qr(int port) throws Exception {
    JSONObject payload = new JSONObject()
      .put("v", 1)
      .put("brain", new JSONObject().put("name", "Мозг").put("fp", "a".repeat(64)))
      .put(
        "relay",
        new JSONObject()
          .put("id", "r12345678")
          .put("name", "Дом")
          .put("host", "127.0.0.1")
          .put("port", port)
          .put("fp", "b".repeat(64))
          .put(
            "token",
            Base64.getUrlEncoder()
              .withoutPadding()
              .encodeToString(new byte[32])
          )
      )
      .put(
        "pair",
        new JSONObject()
          .put(
            "code",
            Base64.getUrlEncoder()
              .withoutPadding()
              .encodeToString(new byte[24])
          )
          .put("exp", 1760000000000L)
      );

    return (
      "cockpitlink:1:" +
      Base64.getUrlEncoder()
        .withoutPadding()
        .encodeToString(payload.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8))
    );
  }

  /**
   * Неверные QR, адреса и ответы посредника отвергаются до сетевых эффектов.
   * Проверка использует собственные синтетические identity и строгие границы размера.
   */
  @Test
  public void strictQrAndHello() throws Exception {
    QrPayload value = QrPayload.parse(qr(443));

    assertEquals("Дом", value.relay.getString("name"));
    assertThrows(IllegalArgumentException.class, () -> QrPayload.parse(qr(0)));
    assertThrows(IllegalArgumentException.class, () -> QrPayload.parse("cockpitlink:1:%%%"));
    assertThrows(IllegalArgumentException.class, () -> QrPayload.parse("other:" + qr(443)));

    String token = Base64.getUrlEncoder()
      .withoutPadding()
      .encodeToString(new byte[32]);

    assertEquals(
      "{\"v\":1,\"role\":\"device\",\"token\":\"" + token + "\"}\n",
      new String(RelayHello.encodeDevice(token), java.nio.charset.StandardCharsets.UTF_8)
    );
    assertEquals("ok", RelayHello.parseReply("{\"ok\":true}"));
    assertEquals(
      "brain_offline",
      RelayHello.parseReply("{\"ok\":false,\"error\":\"brain_offline\"}")
    );
  }

  /**
   * Повторы и сохранённые записи имеют фиксированные бюджеты размера и задержки.
   * Повреждение durable файла не превращается в пустую успешную привязку.
   */
  @Test
  public void backoffAndStoreAreBounded() throws Exception {
    Backoff backoff = new Backoff(
      new Random() {
        @Override
        public double nextDouble() {
          return 0.5;
        }
      }
    );
    long[] delays = { 1000, 2000, 4000, 8000, 16000, 30000, 30000 };

    for (long delay : delays) {
      assertEquals(delay, backoff.next());
    }

    File directory = Files.createTempDirectory("link-store-").toFile();
    LinkStore store = new LinkStore(directory);
    JSONObject data = new JSONObject()
      .put("brainName", "Мозг")
      .put("brainFp", "a".repeat(64))
      .put("deviceName", "Телефон")
      .put("paired", false)
      .put("relays", new JSONArray().put(QrPayload.parse(qr(443)).relay))
      .put("activeRelayId", "r12345678");

    store.save(data);
    assertEquals("Мозг", store.read().getString("brainName"));
    store.removeRelay("r12345678");
    assertTrue(store.read().isNull("activeRelayId"));
    Files.write(
      new File(directory, "link.json").toPath(),
      "broken".getBytes(java.nio.charset.StandardCharsets.UTF_8)
    );
    assertThrows(Exception.class, store::read);
  }

  /**
   * Monotonic deadline проверяется независимо от живого соединения и времени ОС.
   * Rotate и background немедленно отзывают право старого callback публиковать ответ.
   */
  @Test
  public void deadlineAndGenerationRejectLateCallback() {
    long[] now = { 0 };
    NativeSession session = new NativeSession(() -> now[0]);

    assertThrows(IllegalStateException.class, session::capture);

    long first = session.unlock();

    assertTrue(session.isCurrent(first));
    now[0] = 100000;

    long rotated = session.rotate();

    assertFalse(session.isCurrent(first));
    assertEquals(500000, session.remaining());
    now[0] = 600000;
    assertFalse(session.isCurrent(rotated));
    assertFalse(session.isCurrent(first));

    long second = session.unlock();

    assertNotEquals(first, second);
    session.lock();
    assertFalse(session.isCurrent(second));
    session.unlock();
    session.background();
    session.foreground();
    assertFalse(session.isUnlocked());
  }

  /**
   * PEM принадлежит только тесту; ожидаемый fingerprint вычислен openssl, не Pins.
   * Неверный pin отвергается независимо от доверия CA и содержимого subject.
   */
  @Test
  public void pinsAndTrustManagerRejectSubstitution() throws Exception {
    java.security.cert.X509Certificate certificate;

    try (java.io.InputStream input = getClass().getResourceAsStream("/test-pin.pem")) {
      certificate =
        (java.security.cert.X509Certificate) java.security.cert.CertificateFactory.getInstance(
          "X.509"
        ).generateCertificate(input);
    }

    String pin = Pins.sha256Hex(certificate.getEncoded());

    assertEquals("0a162093f01b2b126eae8acaf76acfe34a1ba1883f67dd486731c6fb26226588", pin);
    assertTrue(Pins.matches(certificate, pin));
    assertFalse(Pins.matches(certificate, "0".repeat(64)));
    new PinnedTrustManager(pin).checkServerTrusted(
      new java.security.cert.X509Certificate[] { certificate },
      "EC"
    );
    assertThrows(java.security.cert.CertificateException.class, () ->
      new PinnedTrustManager("0".repeat(64)).checkServerTrusted(
        new java.security.cert.X509Certificate[] { certificate },
        "EC"
      )
    );
  }

  /**
   * Hello parser читает ровно строку и сохраняет склеенный первый TLS record для следующего читателя.
   * EOF и oversize не превращаются в успешную передачу туннеля.
   */
  @Test
  public void fragmentedHelloPreservesRawTail() throws Exception {
    byte[] head = "{\"ok\":true}\n".getBytes(java.nio.charset.StandardCharsets.UTF_8);
    byte[] combined = java.util.Arrays.copyOf(head, head.length + 3);

    combined[head.length] = 22;
    combined[head.length + 1] = 3;
    combined[head.length + 2] = 3;

    java.io.ByteArrayInputStream input = new java.io.ByteArrayInputStream(combined);

    assertEquals("ok", RelayHello.parseReply(RelayDialer.readLine(input)));
    assertEquals(22, input.read());
    assertEquals(3, input.read());
    assertThrows(Exception.class, () ->
      RelayDialer.readLine(new java.io.ByteArrayInputStream(new byte[0]))
    );
    assertThrows(Exception.class, () ->
      RelayDialer.readLine(new java.io.ByteArrayInputStream(new byte[2050]))
    );
  }

  /**
   * Durable очередь сохраняет первоначальный body/time и owner после повторного открытия.
   * Подмена key или сертификата не удаляет существующую запись и не разрешает второй эффект.
   */
  @Test
  public void outboxRejectsConflictsAndKeepsOrder() throws Exception {
    File directory = Files.createTempDirectory("link-outbox-").toFile();
    OutboxStore store = new OutboxStore(directory, "a".repeat(64), "b".repeat(64));
    JSONObject first = new JSONObject()
      .put("method", "POST")
      .put("path", "/api/mobile/v1/chats/demo/messages")
      .put("body", "{\"clientId\":\"m1\",\"text\":\"текст\"}")
      .put("idempotencyKey", "operation-m1")
      .put("createdAt", 1760000000000L);

    store.put(first);
    store.put(first);
    assertEquals(1, store.read().length());
    assertEquals("demo", store.read().getJSONObject(0).getString("chatId"));

    JSONObject changed = new JSONObject(first.toString()).put("body", "{\"clientId\":\"m2\"}");

    assertThrows(IllegalStateException.class, () -> store.put(changed));
    assertThrows(IllegalStateException.class, () ->
      new OutboxStore(directory, "a".repeat(64), "c".repeat(64)).read()
    );

    JSONObject second = new JSONObject(first.toString())
      .put("idempotencyKey", "operation-m2")
      .put("body", "{\"clientId\":\"m2\",\"text\":\"второй\"}");

    store.put(second);
    assertTrue(
      store.read().getJSONObject(0).getLong("order") <
        store.read().getJSONObject(1).getLong("order")
    );
    store.remove("operation-m1");
    assertEquals("m2", store.read().getJSONObject(0).getString("clientId"));
  }

  /**
   * Суммарный размер включает metadata, поэтому удаление LRU освобождает и соседний ETag.
   * Очистка снимает все временные и готовые изображения, сохраняя посторонний каталог APK.
   */
  @Test
  public void mediaCacheRemovesOldestAndMetadata() throws Exception {
    File root = Files.createTempDirectory("link-cache-").toFile();
    File directory = new File(root, "media");

    assertTrue(directory.mkdir());

    File older = new File(directory, "a".repeat(64));
    File newer = new File(directory, "b".repeat(64));

    Files.write(older.toPath(), new byte[10]);
    Files.write(newer.toPath(), new byte[10]);
    Files.write(
      new File(older.getPath() + ".etag").toPath(),
      "etag".getBytes(java.nio.charset.StandardCharsets.UTF_8)
    );
    assertTrue(older.setLastModified(1000));
    assertTrue(newer.setLastModified(2000));
    MediaCache.evict(directory, 10);
    assertFalse(older.exists());
    assertFalse(new File(older.getPath() + ".etag").exists());
    assertTrue(newer.exists());
    MediaCache.clear(directory);
    assertFalse(newer.exists());
  }
}
