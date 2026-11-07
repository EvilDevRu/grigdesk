package local.grigdesk.client;

import static org.junit.Assert.*;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.Test;

public class AppLockScreenTest {
  /**
   * Синтетический удерживаемый документ скрывается без доставки shell snapshot.
   * При задержанном таймере после сна проверка gate предшествует разрешению первого кадра.
   */
  @Test
  public void retainedDocumentIsHiddenBeforeAnySnapshot() throws Exception {
    Path root = Files.createTempDirectory("app-lock-screen-");
    Path file = root.resolve("app-lock.json");
    AtomicLong clock = new AtomicLong();
    AtomicBoolean documentVisible = new AtomicBoolean(true);

    try {
      AppLockPreferences.save(file.toFile(), new AppLockPreferences(true, 60));
      AppLock lock = new AppLock(file.toFile(), (callback, delay) -> () -> {},
        () -> {}, null, clock::get);
      AppLockScreen screen = new AppLockScreen(lock, documentVisible::set);

      screen.started();
      assertFalse(documentVisible.get());
      lock.unlocked();
      screen.refresh();
      assertTrue(documentVisible.get());
      screen.stopped();
      assertFalse(documentVisible.get());
      lock.enterBackground();
      clock.set(60000);
      screen.started();
      assertTrue(lock.locked());
      assertFalse(documentVisible.get());
    } finally {
      Files.deleteIfExists(file);
      Files.deleteIfExists(root);
    }
  }
}
