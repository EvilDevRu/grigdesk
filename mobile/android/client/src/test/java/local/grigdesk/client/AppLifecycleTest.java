package local.grigdesk.client;

import static org.junit.Assert.*;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.Test;

public class AppLifecycleTest {
  /**
   * Часы подменяются, чтобы проверить фон и окно аутентификации без ожидания.
   * Длительный возврат требует locked и сохраняет явную разблокировку.
   */
  @Test
  public void wholeApplicationBackgroundClosesAndExpiryLocks() {
    AtomicLong clock = new AtomicLong();
    List<String> actions = new ArrayList<>();
    AppLifecycle lifecycle = new AppLifecycle(clock::get, new AppLifecycle.Hooks() {
      public void background() {
        actions.add("background");
      }
      public void foreground(boolean locked) {
        actions.add(locked ? "locked" : "foreground");
      }
    });

    lifecycle.started();
    lifecycle.authenticated();
    lifecycle.started();
    lifecycle.stopped(false);
    assertTrue(actions.isEmpty());
    lifecycle.stopped(false);
    assertEquals(List.of("background"), actions);
    clock.set(599999);
    lifecycle.started();
    assertEquals(List.of("background", "foreground"), actions);
    lifecycle.stopped(false);
    clock.set(600001);
    lifecycle.started();
    assertEquals("locked", actions.get(actions.size() - 1));
  }

  /**
   * Поворот и собственный системный диалог не являются уходом всего приложения.
   * Настоящая потеря видимости закрывает соединение ровно один раз.
   */
  @Test
  public void rotationAndNativePickerDoNotDisconnectOrReplay() {
    List<String> actions = new ArrayList<>();
    AppLifecycle lifecycle = new AppLifecycle(() -> 0, new AppLifecycle.Hooks() {
      public void background() {
        actions.add("background");
      }
      public void foreground(boolean locked) {
        actions.add("foreground");
      }
    });

    lifecycle.started();
    lifecycle.stopped(true);
    lifecycle.started();
    lifecycle.nativeFlow(true);
    lifecycle.stopped(false);
    lifecycle.started();
    lifecycle.nativeFlow(false);
    assertTrue(actions.isEmpty());
    lifecycle.stopped(false);
    assertEquals(List.of("background"), actions);
  }
  /**
   * Системный picker сохраняет видимость приложения даже после проверки importance.
   * Холодный старт без локальной даты доверяет явной проверке Keystore вместо ложного locked.
   */
  @Test
  public void processPollingKeepsNativeFlowAndUnknownAuthenticationDoesNotExpire() {
    List<String> actions = new ArrayList<>();
    AppLifecycle lifecycle = new AppLifecycle(() -> 900000, new AppLifecycle.Hooks() {
      public void background() {
        actions.add("background");
      }
      public void foreground(boolean locked) {
        actions.add(locked ? "locked" : "foreground");
      }
    });
    lifecycle.started();
    lifecycle.nativeFlow(true);
    lifecycle.stopped(false);
    lifecycle.processForeground(false);
    assertTrue(actions.isEmpty());
    lifecycle.started();
    lifecycle.nativeFlow(false);
    lifecycle.stopped(false);
    lifecycle.started();
    assertEquals(List.of("background", "foreground"), actions);
  }


  /**
   * Системный диалог даёт ограниченный срок, а не бесконечное разрешение работать в фоне.
   * Часы моделируют Домой из picker без ожидания настоящей минуты.
   */
  @Test
  public void invisibleNativeFlowExpiresAfterMinute() {
    AtomicLong clock = new AtomicLong();
    List<String> actions = new ArrayList<>();
    AppLifecycle lifecycle = new AppLifecycle(clock::get, new AppLifecycle.Hooks() {
      public void background() {
        actions.add("background");
      }
      public void foreground(boolean locked) {
        actions.add("foreground");
      }
    });

    lifecycle.started();
    lifecycle.nativeFlow(true);
    lifecycle.stopped(false);
    lifecycle.processForeground(false);
    clock.set(59999);
    lifecycle.processForeground(false);
    assertTrue(actions.isEmpty());
    clock.set(60000);
    lifecycle.processForeground(false);
    assertEquals(List.of("background"), actions);
    lifecycle.started();
    assertEquals(List.of("background", "foreground"), actions);
  }
}
