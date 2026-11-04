package local.grigdesk.client;

import static org.junit.Assert.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.Test;

public class AppLockPreferencesTest {
  /**
   * Первый запуск не создаёт файл и читает выключенную защиту с порогом минуты.
   * Само чтение не оставляет файл на диске.
   */
  @Test
  public void absentDefaults() throws Exception {
    Path root = Files.createTempDirectory("app-lock-absent-");
    Path file = root.resolve("app-lock.json");

    try {
      AppLockPreferences value = AppLockPreferences.load(file.toFile());

      assertFalse(value.enabled);
      assertEquals(60, value.delaySeconds);
      assertFalse(Files.exists(file));
    } finally {
      Files.deleteIfExists(root);
    }
  }

  /**
   * Записанное значение перечитывается другим экземпляром без изменений.
   * Временные файлы записи не остаются в каталоге.
   */
  @Test
  public void survivesRestart() throws Exception {
    Path root = Files.createTempDirectory("app-lock-restart-");
    Path file = root.resolve("app-lock.json");

    try {
      AppLockPreferences.save(file.toFile(), new AppLockPreferences(true, 300));

      AppLockPreferences read = AppLockPreferences.load(file.toFile());

      assertTrue(read.enabled);
      assertEquals(300, read.delaySeconds);
      assertEquals(1, Files.list(root).count());
    } finally {
      Files.deleteIfExists(file);
      Files.deleteIfExists(root);
    }
  }

  /**
   * Чужой порог отвергается и в конструкторе, и при чтении файла.
   * Значение 45 не превращается в 60 молча.
   */
  @Test
  public void rejectsUnknownDelay() throws Exception {
    Path root = Files.createTempDirectory("app-lock-delay-");
    Path file = root.resolve("app-lock.json");

    try {
      assertThrows(IllegalArgumentException.class, () -> new AppLockPreferences(true, 45));

      Files.write(file, ("{\"enabled\":true,\"delaySeconds\":45}").getBytes(StandardCharsets.UTF_8));
      assertThrows(IllegalArgumentException.class, () -> AppLockPreferences.load(file.toFile()));
    } finally {
      Files.deleteIfExists(file);
      Files.deleteIfExists(root);
    }
  }

  /**
   * Лишние и недостающие поля, чужие типы и битый JSON дают отказ чтения.
   * Файл после отказов остаётся ровно тем же: решение о нём принимает gate, не загрузчик.
   */
  @Test
  public void rejectsUnknownFieldsAndCorruptJson() throws Exception {
    Path root = Files.createTempDirectory("app-lock-fields-");
    Path file = root.resolve("app-lock.json");

    try {
      for (String source : new String[] {
        "{\"enabled\":true,\"delaySeconds\":60,\"extra\":1}",
        "{\"enabled\":true}",
        "{\"enabled\":\"yes\",\"delaySeconds\":60}",
        "{не json",
        "",
      }) {
        Files.write(file, (source).getBytes(StandardCharsets.UTF_8));
        assertThrows(Exception.class, () -> AppLockPreferences.load(file.toFile()));
      }
    } finally {
      Files.deleteIfExists(file);
      Files.deleteIfExists(root);
    }
  }

  /**
   * Отказ записи не изменяет прежнее содержимое диска.
   * Каталог настройки подменён обычным файлом, поэтому temp-файл создать нельзя.
   */
  @Test
  public void writeFailureKeepsDisk() throws Exception {
    Path root = Files.createTempDirectory("app-lock-write-");
    Path blocker = root.resolve("app-lock.json");
    Path nested = root.resolve("app-lock.json").resolveSibling("blocked");

    try {
      Files.write(blocker, ("{\"enabled\":true,\"delaySeconds\":60}").getBytes(StandardCharsets.UTF_8));
      Files.createFile(nested);

      // Цель внутри обычного файла-«каталога»: temp-файл создать невозможно.
      Path broken = nested.resolve("app-lock.json");

      assertThrows(Exception.class,
        () -> AppLockPreferences.save(broken.toFile(), new AppLockPreferences(false, 60)));
      assertEquals("{\"enabled\":true,\"delaySeconds\":60}",
        new String(Files.readAllBytes(blocker), StandardCharsets.UTF_8));
    } finally {
      Files.deleteIfExists(blocker);
      Files.deleteIfExists(nested);
      Files.deleteIfExists(root);
    }
  }

  /**
   * Две установки (телефон и планшет) описываются разными файлами без общего состояния.
   * Класс не хранит ничего статического, поэтому независимость проверяется поведением.
   */
  @Test
  public void twoStoresAreIndependent() throws Exception {
    Path root = Files.createTempDirectory("app-lock-two-");

    try {
      Path phone = root.resolve("phone.json");
      Path tablet = root.resolve("tablet.json");

      AppLockPreferences.save(phone.toFile(), new AppLockPreferences(true, 60));
      AppLockPreferences.save(tablet.toFile(), new AppLockPreferences(false, 300));

      assertFalse(AppLockPreferences.load(phone.toFile()).enabled
        == AppLockPreferences.load(tablet.toFile()).enabled);
      assertEquals(300, AppLockPreferences.load(tablet.toFile()).delaySeconds);
    } finally {
      try (var files = Files.list(root)) {
        for (Path item : files.toArray(Path[]::new)) {
          Files.deleteIfExists(item);
        }
      }

      Files.deleteIfExists(root);
    }
  }
}
