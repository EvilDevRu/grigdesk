package local.grigdesk.client.shell;

import static org.junit.Assert.*;
import java.nio.file.Files;
import java.nio.file.Path;
import org.json.JSONObject;
import org.junit.Test;

public class ProfileStoreTest {
  /**
   * Старый single-address профиль читается без записи и соседствует с relay-only.
   * Пустой address разрешён лишь при сохранённом relay; id и порт не перенумеровываются.
   */
  @Test
  public void legacyReadAndRelayOnlyRoundTrip() throws Exception {
    Path root = Files.createTempDirectory("phone-profile-roundtrip-");
    Path file = root.resolve("profiles.json");

    try {
      ProfileStore store = new ProfileStore(file.toFile(), port -> true);
      JSONObject legacy = store.add("Старый", "https://old.example:443", "1".repeat(64));
      byte[] original = Files.readAllBytes(file);
      ProfileStore read = new ProfileStore(file.toFile(), port -> true);

      assertEquals(legacy.getString("id"), read.profiles.get(0).getString("id"));
      assertArrayEquals(original, Files.readAllBytes(file));

      JSONObject data = new JSONObject(new String(original, java.nio.charset.StandardCharsets.UTF_8));
      JSONObject relayOnly = new JSONObject().put("id", "relay-only").put("name", "Вне дома")
        .put("kind", "remote").put("address", "").put("fp", "2".repeat(64)).put("port", 47102)
        .put("createdAt", 1).put("direct", new org.json.JSONArray())
        .put("relay", new JSONObject().put("id", "r12345678").put("name", "Relay")
          .put("host", "relay.example").put("port", 443).put("fp", "3".repeat(64))
          .put("token", "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8").put("protocol", 2));

      data.getJSONArray("profiles").put(relayOnly);
      Files.write(file, data.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));

      ProfileStore restored = new ProfileStore(file.toFile(), port -> true);

      assertEquals(2, restored.profiles.size());
      assertEquals("", restored.get("relay-only").getString("address"));
      restored.select("relay-only");

      ProfileStore again = new ProfileStore(file.toFile(), port -> true);

      assertEquals("relay-only", again.selected);
      assertEquals(47102, again.get("relay-only").getInt("port"));
      assertEquals(legacy.getString("id"), again.profiles.get(0).getString("id"));
      assertEquals("relay.example", again.get("relay-only").getJSONObject("relay").getString("host"));
      assertFalse(new ShellState(again, 0, 1).snapshot().toString().contains("relay.example"));
    } finally {
      Files.deleteIfExists(file);
      Files.deleteIfExists(root);
    }
  }

  /**
   * Пустое хранилище и повтор pin сохраняют устойчивую идентичность профилей.
   * Занятый порт заменяется с записью, остальные origin не меняются.
   */
  @Test
  public void emptyAtomicPersistenceAndPortIsolation() throws Exception {
    Path root = Files.createTempDirectory("grigdesk-client-profile-");
    Path file = root.resolve("profiles.json");

    try {
      Files.write(file, new byte[0]);

      ProfileStore store = new ProfileStore(file.toFile(), port -> port != 47101);
      JSONObject first = store.add("Первая", "https://one.example:443", "1".repeat(64));
      JSONObject same = store.add("Переименована", "https://new.example:443", "1".repeat(64));
      JSONObject second = store.add("Вторая", "https://two.example:443", "2".repeat(64));

      assertEquals(first.getString("id"), same.getString("id"));
      assertEquals(47102, first.getInt("port"));
      assertEquals(47103, second.getInt("port"));
      assertEquals("Переименована", new ProfileStore(file.toFile(), port -> true)
        .get(first.getString("id")).getString("name"));
      assertEquals(1, Files.list(root).count());
    } finally {
      Files.deleteIfExists(file);
      Files.deleteIfExists(root);
    }
  }
}
