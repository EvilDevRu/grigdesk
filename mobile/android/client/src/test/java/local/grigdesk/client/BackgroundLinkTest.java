package local.grigdesk.client;

import static org.junit.Assert.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.Test;

public class BackgroundLinkTest {
  /**
   * Первый запуск выключен; сохранённый выбор переживает пересоздание настройки.
   * Повреждённый файл читается как выключенное значение и не перезаписывается.
   */
  @Test
  public void preferencePersistsAndDamagedFileReadsDisabled() throws Exception {
    Path root = Files.createTempDirectory("grigdesk-background-link-");
    Path file = root.resolve("background-link.json");

    try {
      assertFalse(new BackgroundLink(file.toFile()).enabled());

      BackgroundLink link = new BackgroundLink(file.toFile());

      link.set(true);

      assertTrue(link.enabled());
      assertTrue(new BackgroundLink(file.toFile()).enabled());
      assertTrue(link.snapshot().getBoolean("enabled"));

      link.set(false);

      assertFalse(new BackgroundLink(file.toFile()).enabled());

      Files.write(file, "{повреждено".getBytes(StandardCharsets.UTF_8));

      BackgroundLink damaged = new BackgroundLink(file.toFile());

      assertFalse(damaged.enabled());
      assertEquals("{повреждено", new String(Files.readAllBytes(file), StandardCharsets.UTF_8));
    } finally {
      Files.deleteIfExists(file);
      Files.deleteIfExists(root);
    }
  }
}
