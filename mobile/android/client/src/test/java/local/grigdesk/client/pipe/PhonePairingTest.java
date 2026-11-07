package local.grigdesk.client.pipe;

import static org.junit.Assert.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.concurrent.atomic.AtomicInteger;
import local.grigdesk.client.shell.Pairing;
import local.grigdesk.client.shell.ProfileStore;
import local.grigdesk.client.shell.ShellState;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class PhonePairingTest {
  /**
   * Direct, оба пути и первое relay-подключение используют один ключ и профиль по server pin.
   * Публичный ShellState не получает приватные маршруты, token, code или fingerprint.
   */
  @Test
  public void directRelayAndRelayFirstKeepOneIdentity() throws Exception {
    Path root = Files.createTempDirectory("phone-pairing-");
    Path file = root.resolve("profiles.json");
    String[] fp = new String[1];
    AtomicInteger pairs = new AtomicInteger();
    AtomicInteger keys = new AtomicInteger();

    try (TlsFixture server = new TlsFixture((head, body, output) -> {
      byte[] bytes = body.readAllBytes();
      JSONObject response = new JSONObject().put("fp", fp[0]).put("name", "Машина стенда")
        .put("device", new JSONObject().put("id", "d12345678").put("name", "Телефон"));

      if (head.target().endsWith("/pair")) {
        assertEquals("AAECAwQFBgcICQoLDA0ODxAREhMUFRYX", new JSONObject(
          new String(bytes, StandardCharsets.UTF_8)).getString("code"));
        pairs.incrementAndGet();
        response.put("server", new JSONObject().put("fp", fp[0]).put("name", "Машина стенда"));
      }

      TlsFixture.response(output, 200, "0.1", response.toString().getBytes(StandardCharsets.UTF_8));
    }); PhoneDirectFixture direct = new PhoneDirectFixture(server.server.getLocalPort());
      PhoneRelayFixture relay = new PhoneRelayFixture(server.server.getLocalPort())) {
      fp[0] = server.pin;

      ProfileStore store = new ProfileStore(file.toFile(), port -> true);
      javax.net.ssl.X509KeyManager installationKey = TlsFixture.keys("client");
      Pairing pairing = new Pairing(store, clientKey -> {
        keys.incrementAndGet();

        return installationKey;
      }, 0, 1);
      JSONObject first = pairing.add(payload(server.pin, new JSONArray().put(direct.route()), null));
      String id = first.getString("id");
      int port = first.getInt("port");
      JSONObject both = pairing.add(payload(server.pin, new JSONArray().put(direct.route()), relay.route()));

      assertEquals(id, both.getString("id"));
      assertEquals(port, both.getInt("port"));
      direct.unavailable();

      JSONObject relayOnly = pairing.add(payload(server.pin, new JSONArray(), relay.route()));

      assertEquals(id, relayOnly.getString("id"));
      assertEquals(port, relayOnly.getInt("port"));
      assertEquals("", relayOnly.getString("address"));
      assertEquals(1, store.profiles.size());
      assertEquals(3, pairs.get());
      assertTrue(keys.get() > 0);
      assertTrue(relay.hellos.get() > 0);

      ProfileStore restored = new ProfileStore(file.toFile(), candidate -> true);
      String snapshot = new ShellState(restored, 0, 1).snapshot().toString();

      assertEquals(id, restored.profiles.get(0).getString("id"));
      assertFalse(snapshot.contains(relay.token));
      assertFalse(snapshot.contains(server.pin));
      assertFalse(snapshot.contains("AAECAwQFBgcICQoLDA0ODxAREhMUFRYX"));
      assertFalse(snapshot.contains("\"relay\""));
    } finally {
      Files.deleteIfExists(file);
      Files.deleteIfExists(root);
    }
  }

  /**
   * Конверт собирается тестом по публичному wire, не будущим Java-кодеком.
   * Срок далёкий, но конечный; адреса и pin принадлежат только синтетическим серверам.
   */
  static String payload(String pin, JSONArray direct, JSONObject relay) throws Exception {
    JSONObject data = new JSONObject().put("v", 2)
      .put("server", new JSONObject().put("name", "Машина стенда").put("fp", pin))
      .put("direct", direct).put("pair", new JSONObject()
        .put("code", "AAECAwQFBgcICQoLDA0ODxAREhMUFRYX").put("exp", 2100000000000L));

    if (relay != null) {
      data.put("relay", relay);
    }

    return "GRIGDESK:PHONE:2:" + Base64.getUrlEncoder().withoutPadding()
      .encodeToString(data.toString().getBytes(StandardCharsets.UTF_8));
  }

  /**
   * Повторный QR той же машины обновляет существующий профиль, сохраняя id и порт.
   * Привязка использует современную личность и записывает её версию в профиль.
   */
  @Test
  public void modernQrRebindsSameProfileAndRecordsKeyVersion() throws Exception {
    Path root = Files.createTempDirectory("phone-rebind-");
    Path file = root.resolve("profiles.json");
    String[] fp = new String[1];
    java.util.List<Integer> requested = new java.util.ArrayList<>();

    try (TlsFixture server = new TlsFixture((head, body, output) -> {
      byte[] bytes = body.readAllBytes();
      JSONObject response = new JSONObject().put("fp", fp[0]).put("name", "Машина стенда")
        .put("device", new JSONObject().put("id", "d87654321").put("name", "Телефон"));

      if (head.target().endsWith("/pair")) {
        assertEquals("AAECAwQFBgcICQoLDA0ODxAREhMUFRYX", new JSONObject(
          new String(bytes, StandardCharsets.UTF_8)).getString("code"));
        response.put("server", new JSONObject().put("fp", fp[0]).put("name", "Машина стенда"));
      }

      TlsFixture.response(output, 200, "0.1", response.toString().getBytes(StandardCharsets.UTF_8));
    }); PhoneDirectFixture direct = new PhoneDirectFixture(server.server.getLocalPort())) {
      fp[0] = server.pin;

      JSONObject legacy = new JSONObject().put("id", "m11111111").put("name", "Моё имя машины")
        .put("kind", "remote").put("address", server.address()).put("fp", server.pin)
        .put("port", 47101).put("createdAt", 1)
        .put("direct", new JSONArray().put(direct.route()))
        .put("deviceId", "d00000001");
      JSONObject data = new JSONObject().put("version", 1).put("selected", JSONObject.NULL)
        .put("profiles", new JSONArray().put(legacy));

      Files.write(file, data.toString().getBytes(StandardCharsets.UTF_8));

      ProfileStore store = new ProfileStore(file.toFile(), port -> true);
      javax.net.ssl.X509KeyManager installationKey = TlsFixture.keys("client");
      Pairing pairing = new Pairing(store, clientKey -> {
        requested.add(clientKey);

        return installationKey;
      }, 0, 1);

      JSONObject reborn = pairing.add(payload(server.pin, new JSONArray().put(direct.route()), null));

      assertEquals("m11111111", reborn.getString("id"));
      assertEquals(47101, reborn.getInt("port"));
      assertEquals("Моё имя машины", reborn.getString("name"));
      assertEquals(2, reborn.getInt("clientKey"));
      assertEquals("d87654321", reborn.getString("deviceId"));
      assertEquals(java.util.List.of(2), requested);
      assertEquals(1, store.profiles.size());

      ProfileStore restored = new ProfileStore(file.toFile(), candidate -> true);

      assertEquals(2, restored.profiles.get(0).optInt("clientKey", 1));
    } finally {
      Files.deleteIfExists(file);
      Files.deleteIfExists(root);
    }
  }
}
