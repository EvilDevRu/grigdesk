package local.grigdesk.client.pipe;

import static org.junit.Assert.*;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import local.grigdesk.client.shell.Pairing;
import local.grigdesk.client.shell.ProfileStore;
import local.grigdesk.client.shell.ShellApi;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class RelayRouteUpdateTest {
  /**
   * Отдельный route PATCH использует прежний ключ, включая профиль без clientKey.
   * Привязка и новый hello обязаны сохранить устройство, выбранную машину и локальный origin.
   */
  @Test
  public void routePatchKeepsExistingKey() throws Exception {
    for (int version : new int[] { 0, 1, 2 }) {
      exercise(version, "success");
    }
  }

  /**
   * Ошибка доверия, сети или durable-записи не меняет память и старый файл профиля.
   * Отказ неизвестного PATCH-поля не засчитывается за проверку этих причин.
   */
  @Test
  public void routeFailureKeepsProfile() throws Exception {
    for (String failure : new String[] {
      "serverPin", "relayPin", "revoked", "expired", "invalid", "network", "save"
    }) {
      exercise(1, failure);
    }
  }

  /**
   * Все сокеты и PKCS12 принадлежат существующей синтетической TLS-фикстуре.
   * File-адаптер отказывает только созданию временного файла, оставляя старые bytes доступными.
   */
  private void exercise(int version, String mode) throws Exception {
    Path root = Files.createTempDirectory("relay-route-update-");
    Path file = root.resolve("profiles.json");
    Path blocked = root.resolve("not-a-directory");
    AtomicBoolean failSave = new AtomicBoolean();
    AtomicInteger pairs = new AtomicInteger();
    AtomicInteger hellos = new AtomicInteger();
    List<Integer> requestedKeys = new ArrayList<>();
    List<String> navigation = new ArrayList<>();
    String[] fp = new String[1];

    try (TlsFixture server = new TlsFixture((head, body, output) -> {
      JSONObject response = new JSONObject().put("fp", fp[0]).put("name", "Сервер стенда")
        .put("device", new JSONObject().put("id", "d12345678").put("name", "Телефон"));

      if (head.target().endsWith("/pair")) {
        pairs.incrementAndGet();
        body.readAllBytes();
        response.put("server", new JSONObject().put("fp", fp[0]).put("name", "Сервер стенда"));
      } else if (head.target().equals("/api/client/hello") && pairs.get() > 0) {
        // RoutedUpstream проверяет маршрут через hello перед первым forward.
        // Для обновления нужен authenticated hello после pair, число штатных probes не ограничено.
        hellos.incrementAndGet();
      }

      int status = mode.equals("revoked") ? 403 : 200;
      String text = mode.equals("revoked")
        ? new JSONObject().put("error", "device_revoked").toString() : response.toString();

      TlsFixture.response(output, status, "0.1", text.getBytes(StandardCharsets.UTF_8));
    }); PhoneDirectFixture direct = new PhoneDirectFixture(server.server.getLocalPort());
      PhoneRelayFixture relay = new PhoneRelayFixture(server.server.getLocalPort())) {
      fp[0] = server.pin;

      JSONObject old = new JSONObject().put("id", "m12345678").put("name", "Моё имя")
        .put("kind", "remote").put("address", "https://127.0.0.1:9")
        .put("fp", server.pin).put("port", 47101).put("createdAt", 17)
        .put("deviceId", "d12345678");

      if (version != 0) {
        old.put("clientKey", version);
      }

      Files.write(file, new JSONObject().put("version", 1).put("selected", "m12345678")
        .put("profiles", new JSONArray().put(old)).toString().getBytes(StandardCharsets.UTF_8));
      Files.write(blocked, "Блокировка только тестовой записи".getBytes(StandardCharsets.UTF_8));

      File target = new File(file.toString()) {
        @Override
        public File getParentFile() {
          return failSave.get() ? blocked.toFile() : super.getParentFile();
        }
      };
      ProfileStore store = new ProfileStore(target, port -> true);
      Pairing pairing = new Pairing(store, clientKey -> {
        requestedKeys.add(clientKey);

        return TlsFixture.keys("client");
      }, 0, 1);
      JSONArray routes = new JSONArray().put(direct.route());
      JSONObject relayRoute = null;
      String pin = mode.equals("serverPin") ? "e".repeat(64) : server.pin;

      if (mode.equals("relayPin")) {
        routes = new JSONArray();
        relayRoute = new JSONObject(relay.route().toString()).put("fp", "e".repeat(64));
      }

      if (mode.equals("network")) {
        routes = new JSONArray().put(new JSONObject().put("host", "127.0.0.1").put("port", 9));
      }

      String text = PhonePairingTest.payload(pin, routes, relayRoute);

      if (mode.equals("expired")) {
        JSONObject payload = new JSONObject(new String(java.util.Base64.getUrlDecoder()
          .decode(text.substring("GRIGDESK:PHONE:2:".length())), StandardCharsets.UTF_8));

        payload.getJSONObject("pair").put("exp", 1);
        text = "GRIGDESK:PHONE:2:" + java.util.Base64.getUrlEncoder().withoutPadding()
          .encodeToString(payload.toString().getBytes(StandardCharsets.UTF_8));
      }

      if (mode.equals("invalid")) {
        text = "GRIGDESK:PHONE:2:broken";
      }

      byte[] before = Files.readAllBytes(file);
      String memory = store.get("m12345678").toString();

      failSave.set(mode.equals("save"));

      try (ShellApi shell = new ShellApi(store, pairing, (profile, gate, report) ->
        new ShellApi.Transport() {
          public void probe() {
            report.accept("online", null);
          }
          public void close() {
          }
          public PipeTransport pipe() {
            return null;
          }
        }, (callback, delay) -> () -> {}, Runnable::run, navigation::add, null, () -> 0.5, 0, 1)) {
        byte[] body = new JSONObject().put("routePairing", text).toString()
          .getBytes(StandardCharsets.UTF_8);
        HttpHead head = new HttpHead("PATCH /__shell/profiles/m12345678 HTTP/1.1", Map.of(
          "content-type", "application/json", "content-length", Integer.toString(body.length)));

        try (PipeResponse response = shell.handle(head, new ByteArrayInputStream(body))) {
          String result = StaticAssets.readText(response.body, 65536);

          if (mode.equals("success")) {
            assertEquals(result, 200, response.status);
            assertEquals(List.of(version == 0 ? 1 : version), requestedKeys);
            assertEquals(1, pairs.get());
            assertTrue("После pair подтверждён authenticated hello", hellos.get() > 0);
            assertEquals(1, store.profiles.size());

            JSONObject updated = store.get("m12345678");

            for (String field : new String[] { "id", "name", "fp", "kind", "port", "createdAt" }) {
              assertEquals(field, old.get(field), updated.get(field));
            }

            assertEquals(version == 0 ? 1 : version, updated.optInt("clientKey", 1));
            assertEquals("d12345678", updated.getString("deviceId"));
            assertEquals(routes.toString(), updated.getJSONArray("direct").toString());
            assertEquals("m12345678", store.selected);
            assertTrue(navigation.isEmpty());
          } else {
            assertTrue(result, response.status >= 400);
            assertFalse("Отказ неизвестного поля не доказывает обработку QR",
              result.contains("Неверные поля"));
            assertEquals(memory, store.get("m12345678").toString());
            assertArrayEquals(before, Files.readAllBytes(file));
            assertEquals(1, store.profiles.size());
            assertEquals("m12345678", store.selected);
            assertTrue(navigation.isEmpty());
          }

          String snapshot = shell.state.snapshot().toString();

          assertFalse(snapshot.contains(text));
          assertFalse(snapshot.contains(relay.token));
          assertFalse(snapshot.contains(server.pin));
        }
      }
    } finally {
      Files.deleteIfExists(file);
      Files.deleteIfExists(blocked);
      Files.deleteIfExists(root);
    }
  }
}
