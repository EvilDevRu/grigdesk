package local.grigdesk.client.shell;

import static org.junit.Assert.*;
import java.nio.file.Files;
import java.nio.file.Path;
import org.json.JSONObject;
import org.junit.Test;

public class ProfileStoreTest {
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
