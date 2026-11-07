package local.grigdesk.client;

import static org.junit.Assert.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;
import org.junit.Test;

public class AppLockTest {
  /**
   * Планировщик собирает задержки и функции отмены без реального времени.
   * Пороговые значения и отмены проверяются точно, а не по часам.
   */
  private static final class ListScheduler implements AppLock.Scheduler {
    final List<Long> delays = new ArrayList<>();
    final List<Runnable> callbacks = new ArrayList<>();
    final List<Boolean> cancelled = new ArrayList<>();

    /**
     * Каждый запрос оставляет отдельный callback и признак отмены для проверки поколений.
     * Отменённую функцию можно доставить вручную, воспроизводя гонку планировщика.
     */
    @Override
    public Runnable schedule(Runnable callback, long delayMillis) {
      delays.add(delayMillis);
      callbacks.add(callback);
      cancelled.add(false);

      int index = callbacks.size() - 1;

      return () -> cancelled.set(index, true);
    }
  }

  private static final class CountingListener implements AppLock.Listener {
    final AtomicInteger changes = new AtomicInteger();

    @Override
    public void changed() {
      changes.incrementAndGet();
    }
  }

  /**
   * Синтетическая настройка хранится в отдельном каталоге каждого сценария.
   * Возвращённый путь позволяет проверить сохранность файла и убрать каталог в finally.
   */
  private static Path write(String json) throws Exception {
    Path root = Files.createTempDirectory("app-lock-gate-");
    Path file = root.resolve("app-lock.json");

    Files.write(file, (json).getBytes(StandardCharsets.UTF_8));

    return file;
  }

  /**
   * Холодный запуск с включённой блокировкой закрыт, с выключенной открыт.
   * Прошлый процесс не является разрешением: locked выставляется конструктором.
   */
  @Test
  public void coldStartEnabledLocksAndDisabledOpens() throws Exception {
    Path enabled = write("{\"enabled\":true,\"delaySeconds\":60}");
    Path disabled = write("{\"enabled\":false,\"delaySeconds\":60}");

    try {
      assertTrue(new AppLock(enabled.toFile(), new ListScheduler(), new CountingListener(),
        null).locked());
      assertFalse(new AppLock(disabled.toFile(), new ListScheduler(), new CountingListener(),
        null).locked());
    } finally {
      Files.deleteIfExists(enabled);
      Files.deleteIfExists(enabled.getParent());
      Files.deleteIfExists(disabled);
      Files.deleteIfExists(disabled.getParent());
    }
  }

  /**
   * Повреждённое хранилище означает включённую защиту с порогом минуты и закрытый gate.
   * Файл чтением не исправляется и содержимое не теряет.
   */
  @Test
  public void coldStartWithDamagedStoreLocks() throws Exception {
    Path damaged = write("{не json");

    try {
      AppLock lock = new AppLock(damaged.toFile(), new ListScheduler(), new CountingListener(),
        null);

      assertTrue(lock.locked());
      assertTrue(lock.snapshot().getBoolean("enabled"));
      assertEquals(60, lock.snapshot().getInt("delaySeconds"));
      assertEquals("{не json", new String(Files.readAllBytes(damaged), StandardCharsets.UTF_8));
    } finally {
      Files.deleteIfExists(damaged);
      Files.deleteIfExists(damaged.getParent());
    }
  }

  /**
   * Уход в фон ставит один таймер на полный порог; срабатывание закрывает и публикует событие.
   * Уже закрытая блокировка не публикует событие повторно.
   */
  @Test
  public void backgroundDelayElapsesAndLocksOnce() throws Exception {
    Path file = write("{\"enabled\":true,\"delaySeconds\":60}");
    ListScheduler scheduler = new ListScheduler();
    CountingListener listener = new CountingListener();

    try {
      AppLock lock = new AppLock(file.toFile(), scheduler, listener, null, () -> 0L);

      lock.unlocked();
      listener.changes.set(0);
      lock.leaveBackground();
      lock.enterBackground();
      assertEquals(List.of(60000L), scheduler.delays);

      scheduler.callbacks.get(0).run();

      assertTrue(lock.locked());
      assertEquals(1, listener.changes.get());

      lock.leaveBackground();
      lock.enterBackground();
      assertEquals(1, scheduler.callbacks.size());
      scheduler.callbacks.get(0).run();

      assertTrue(lock.locked());
      assertEquals(1, listener.changes.get());
    } finally {
      Files.deleteIfExists(file);
      Files.deleteIfExists(file.getParent());
    }
  }

  /**
   * Возврат до порога отменяет таймер; короткие выходы не суммируются.
   * Блокировка остаётся открытой после двух коротких циклов.
   */
  @Test
  public void returnBeforeDelayCancelsAndShortExitsDoNotAccumulate() throws Exception {
    Path file = write("{\"enabled\":true,\"delaySeconds\":60}");
    ListScheduler scheduler = new ListScheduler();

    try {
      AppLock lock = new AppLock(file.toFile(), scheduler, new CountingListener(), null, () -> 0L);

      lock.unlocked();
      lock.enterBackground();
      lock.leaveBackground();
      lock.enterBackground();
      lock.leaveBackground();

      assertTrue(scheduler.cancelled.get(0));
      assertTrue(scheduler.cancelled.get(1));
      assertFalse(lock.locked());
      assertEquals(List.of(60000L, 60000L), scheduler.delays);

      lock.enterBackground();
      scheduler.callbacks.get(2).run();

      assertTrue(lock.locked());
    } finally {
      Files.deleteIfExists(file);
      Files.deleteIfExists(file.getParent());
    }
  }

  /**
   * Выключенная блокировка не ставит таймеры и не закрывает доступ никогда.
   * Порог подсказки жизненного цикла в этом режиме максимальный.
   */
  @Test
  public void disabledNeverLocksOrSchedules() throws Exception {
    Path file = write("{\"enabled\":false,\"delaySeconds\":300}");
    ListScheduler scheduler = new ListScheduler();

    try {
      AppLock lock = new AppLock(file.toFile(), scheduler, new CountingListener(), null, () -> 0L);

      lock.enterBackground();

      assertFalse(lock.locked());
      assertTrue(scheduler.delays.isEmpty());
      assertEquals(Long.MAX_VALUE, lock.foregroundLimitMillis());
    } finally {
      Files.deleteIfExists(file);
      Files.deleteIfExists(file.getParent());
    }
  }

  /**
   * Включённая блокировка отдаёт порог подсказки в миллисекундах.
   * Значения 0/60/300 переходят в 0/60000/300000.
   */
  @Test
  public void foregroundLimitFollowsPolicy() throws Exception {
    for (int delay : new int[] { 0, 60, 300 }) {
      Path file = write("{\"enabled\":true,\"delaySeconds\":" + delay + "}");

      try {
        assertEquals(delay * 1000L, new AppLock(file.toFile(), new ListScheduler(),
          new CountingListener(), null).foregroundLimitMillis());
      } finally {
        Files.deleteIfExists(file);
        Files.deleteIfExists(file.getParent());
      }
    }
  }

  /**
   * Полное значение сохраняется сразу: выбор порога 0 не закрывает передний план.
   * Запись попадает на диск и перечитывается новым владельцем.
   */
  @Test
  public void updateAppliesImmediatelyAndPersists() throws Exception {
    Path file = write("{\"enabled\":false,\"delaySeconds\":60}");
    ListScheduler scheduler = new ListScheduler();
    CountingListener listener = new CountingListener();

    try {
      AppLock lock = new AppLock(file.toFile(), scheduler, listener, null, () -> 0L);

      lock.update(new JSONObject().put("enabled", true).put("delaySeconds", 0));

      assertFalse(lock.locked());
      assertEquals(1, listener.changes.get());
      assertTrue(AppLockPreferences.load(file.toFile()).enabled);
      assertEquals(0, AppLockPreferences.load(file.toFile()).delaySeconds);

      lock.enterBackground();
      assertTrue(lock.locked());
      lock.leaveBackground();
      lock.unlocked();

      assertFalse(lock.locked());
    } finally {
      Files.deleteIfExists(file);
      Files.deleteIfExists(file.getParent());
    }
  }

  /**
   * Чужие поля, чужой порог и неполное значение отвергаются целиком.
   * Принятое значение, gate и файл при отказе валидации не меняются.
   */
  @Test
  public void updateRejectsInvalidValues() throws Exception {
    Path file = write("{\"enabled\":false,\"delaySeconds\":60}");

    try {
      AppLock lock = new AppLock(file.toFile(), new ListScheduler(), new CountingListener(),
        null);

      for (JSONObject bad : new JSONObject[] {
        new JSONObject().put("enabled", true).put("delaySeconds", 45),
        new JSONObject().put("enabled", true),
        new JSONObject().put("enabled", true).put("delaySeconds", 60).put("extra", 1),
        new JSONObject().put("enabled", "yes").put("delaySeconds", 60),
      }) {
        assertThrows(IllegalArgumentException.class, () -> lock.update(bad));
      }

      assertFalse(lock.locked());
      assertFalse(AppLockPreferences.load(file.toFile()).enabled);
    } finally {
      Files.deleteIfExists(file);
      Files.deleteIfExists(file.getParent());
    }
  }

  /**
   * Отказ записи оставляет прежнее принятое значение и открытый gate.
   * Родительский путь — обычный файл, поэтому temp-файл создать нельзя.
   */
  @Test
  public void updateFailureKeepsMemoryAndGate() throws Exception {
    Path root = Files.createTempDirectory("app-lock-gate-write-");
    Path blocker = root.resolve("blocked");

    Files.write(blocker, ("not a directory").getBytes(StandardCharsets.UTF_8));

    try {
      Path file = blocker.resolve("app-lock.json");
      AppLock lock = new AppLock(file.toFile(), new ListScheduler(), new CountingListener(),
        null);

      assertThrows(IllegalStateException.class, () -> lock.update(
        new JSONObject().put("enabled", true).put("delaySeconds", 60)));

      assertFalse(lock.locked());
      assertFalse(lock.snapshot().getBoolean("enabled"));
    } finally {
      Files.deleteIfExists(blocker);
      Files.deleteIfExists(root);
    }
  }

  /**
   * Точная граница проверяется без исполнения таймера, как при сне устройства.
   * Старый callback после возврата и нового выхода не может закрыть новый доступ.
   */
  @Test
  public void deadlineIncludesSleepAndCancelledCallbackCannotLock() throws Exception {
    for (int delay : new int[] { 0, 60, 300 }) {
      Path file = write("{\"enabled\":true,\"delaySeconds\":" + delay + "}");
      java.util.concurrent.atomic.AtomicLong clock = new java.util.concurrent.atomic.AtomicLong();
      ListScheduler scheduler = new ListScheduler();

      try {
        AppLock lock = new AppLock(file.toFile(), scheduler, () -> {}, null, clock::get);
        lock.unlocked();
        lock.enterBackground();

        if (delay == 0) {
          assertTrue(lock.locked());
          assertTrue(scheduler.callbacks.isEmpty());
          continue;
        }

        clock.set(delay * 1000L - 1);
        lock.leaveBackground();
        assertFalse(lock.locked());
        lock.enterBackground();
        scheduler.callbacks.get(0).run();
        assertFalse(lock.locked());
        clock.addAndGet(delay * 1000L);
        lock.leaveBackground();
        assertTrue(lock.locked());
      } finally {
        Files.deleteIfExists(file);
        Files.deleteIfExists(file.getParent());
      }
    }
  }

  /**
   * Сохранение выключения отменяет уже поставленное закрытие даже при позднем callback.
   * Изменение срока в фоне считает остаток от прежнего backgroundSince.
   */
  @Test
  public void disableInvalidatesTimerAndDelayChangeKeepsBackgroundStart() throws Exception {
    Path file = write("{\"enabled\":true,\"delaySeconds\":60}");
    java.util.concurrent.atomic.AtomicLong clock = new java.util.concurrent.atomic.AtomicLong();
    ListScheduler scheduler = new ListScheduler();

    try {
      AppLock lock = new AppLock(file.toFile(), scheduler, () -> {}, null, clock::get);
      lock.unlocked();
      lock.enterBackground();
      clock.set(10000);
      lock.update(new JSONObject().put("enabled", true).put("delaySeconds", 300));
      assertEquals(List.of(60000L, 290000L), scheduler.delays);
      lock.update(new JSONObject().put("enabled", false).put("delaySeconds", 60));
      scheduler.callbacks.get(0).run();
      scheduler.callbacks.get(1).run();
      assertFalse(lock.locked());
      assertFalse(lock.snapshot().getBoolean("enabled"));
      assertTrue(scheduler.cancelled.get(0));
      assertTrue(scheduler.cancelled.get(1));
    } finally {
      Files.deleteIfExists(file);
      Files.deleteIfExists(file.getParent());
    }
  }

  /**
   * Существующий нулевой файл является повреждением защиты, а не первым запуском.
   * Холодный запуск закрывается, не изменяя повреждённый файл чтением.
   */
  @Test
  public void emptyExistingFileFailsClosed() throws Exception {
    Path file = write("");

    try {
      AppLock lock = new AppLock(file.toFile(), new ListScheduler(), () -> {}, null);
      assertTrue(lock.locked());
      assertTrue(lock.snapshot().getBoolean("enabled"));
      assertEquals(60, lock.snapshot().getInt("delaySeconds"));
      assertEquals(0L, Files.size(file));
    } finally {
      Files.deleteIfExists(file);
      Files.deleteIfExists(file.getParent());
    }
  }

  /**
   * Разблокировка без машины обязана опубликовать новую ревизию полного снимка.
   * Уведомление вне монитора gate позволяет ShellState читать его под собственным монитором.
   */
  @Test
  public void unlockWithoutMachinePublishesOutsideGateMonitor() throws Exception {
    Path root = Files.createTempDirectory("app-lock-state-");
    Path file = root.resolve("app-lock.json");
    java.util.concurrent.atomic.AtomicReference<AppLock> reference =
      new java.util.concurrent.atomic.AtomicReference<>();
    local.grigdesk.client.shell.ShellState[] state = new local.grigdesk.client.shell.ShellState[1];

    try {
      AppLockPreferences.save(file.toFile(), new AppLockPreferences(true, 60));
      AppLock lock = new AppLock(file.toFile(), new ListScheduler(), () -> {
        assertFalse(Thread.holdsLock(reference.get()));
        state[0].changed();
      }, null);
      reference.set(lock);
      local.grigdesk.client.shell.ProfileStore profiles = new local.grigdesk.client.shell.ProfileStore(
        root.resolve("profiles.json").toFile(), port -> true);
      state[0] = new local.grigdesk.client.shell.ShellState(profiles, 0, 1, null, lock::snapshot);
      JSONObject before = state[0].snapshot();

      lock.unlocked();
      JSONObject accepted = state[0].snapshot();

      assertTrue(accepted.getLong("rev") > before.getLong("rev"));
      assertTrue(before.getJSONObject("appLock").getBoolean("locked"));
      assertFalse(accepted.getJSONObject("appLock").getBoolean("locked"));
    } finally {
      Files.deleteIfExists(file);
      Files.deleteIfExists(root);
    }
  }
}
