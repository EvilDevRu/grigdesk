package local.grigdesk.client.shell;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import local.grigdesk.client.pipe.HttpHead;
import local.grigdesk.client.pipe.PipeResponse;
import local.grigdesk.client.pipe.StaticAssets;
import local.grigdesk.client.pipe.Upstream;
import org.json.JSONObject;
import org.junit.Test;

public class ShellApiTest {
  /**
   * Нативное сохранение получает безопасное имя и поток исходного тела.
   * Отказ камеры возвращает читаемую ошибку без успешной привязки.
   */
  @Test
  public void nativeActionsHaveSafeNamesAndReadableCameraError() throws Exception {
    Path root = Files.createTempDirectory("grigdesk-shell-");
    ProfileStore store = new ProfileStore(root.resolve("profiles.json").toFile(), port -> true);
    ShellApi.Native nativeActions = new ShellApi.Native() {
      public String scan() throws Exception {
        throw new java.util.concurrent.ExecutionException(
          new IllegalStateException("На устройстве нет камеры."));
      }
      public void save(String name, String type, InputStream body) {
      }
      public void unlock() {
      }
    };

    try (ShellApi shell = new ShellApi(store, null, null, (callback, delay) -> () -> {}, Runnable::run,
      id -> {}, nativeActions, () -> 0.5, 0, 1)) {
      HttpHead request = new HttpHead("POST /__shell/scan HTTP/1.1", java.util.Map.of());

      try (PipeResponse response = shell.handle(request,
        new ByteArrayInputStream(new byte[0]))) {
        assertEquals(400, response.status);
        assertTrue(StaticAssets.readText(response.body, 4096).contains("На устройстве нет камеры."));
      }

      for (String name : new String[] { "../x", "a/b", "a\\b", "..", "" }) {
        assertThrows(IllegalArgumentException.class, () -> ShellApi.saveName(name));
      }

      assertEquals("отчёт.txt", ShellApi.saveName(" отчёт.txt "));
      assertFalse(shell.state.snapshot().toString().contains("fp"));
    } finally {
      Files.deleteIfExists(root);
    }
  }

  /**
   * Подменённый планировщик проверяет всю последовательность offline-повторов.
   * Ручное отключение и терминальные состояния гасят даже запоздалый callback.
   */
  @Test
  public void retrySequenceAndExplicitDisconnectCancelOldCallbacks() throws Exception {
    Path root = Files.createTempDirectory("grigdesk-shell-retry-");
    Path file = root.resolve("profiles.json");
    ProfileStore store = new ProfileStore(file.toFile(), port -> true);
    String id = store.add("Фикстура", "https://machine.example:443", "1".repeat(64)).getString("id");
    List<Long> delays = new ArrayList<>();
    List<Runnable> callbacks = new ArrayList<>();
    List<ShellApi.Report> reports = new ArrayList<>();

    try (ShellApi shell = new ShellApi(store, null, (profile, gate, report) -> {
      reports.add(report);
      return new ShellApi.Transport() {
        public void probe() {
          report.accept("offline", null);
        }
        public void close() {
        }
        public Upstream pipe() {
          return null;
        }
      };
    }, (callback, delay) -> {
      callbacks.add(callback);
      delays.add(delay);
      return () -> {};
    }, Runnable::run, profile -> {}, null, () -> 0.5, 0, 1)) {
      store.select(id);
      shell.connect(id, true);
      assertTrue(shell.state.snapshot().getJSONObject("detail").getLong("retryAt")
        > System.currentTimeMillis());

      for (int index = 0; index < 6; index++) {
        callbacks.get(index).run();
      }

      assertEquals(List.of(1000L, 2000L, 4000L, 8000L, 16000L, 30000L, 30000L), delays);
      int count = reports.size();

      shell.disconnect(id);
      assertEquals("disconnected", shell.state.snapshot().getJSONObject("detail").getString("code"));
      callbacks.get(callbacks.size() - 1).run();
      reports.get(0).accept("online", null);
      assertEquals(count, reports.size());
      assertEquals("offline", shell.state.snapshot().getString("status"));
      shell.connect(id, true);
      reports.get(reports.size() - 1).accept("revoked", "device_revoked");
      int terminalCount = reports.size();

      callbacks.get(callbacks.size() - 1).run();
      assertEquals(terminalCount, reports.size());
      shell.connect(id, true);
      ShellApi.Report old = reports.get(reports.size() - 1);

      shell.suspend();
      shell.resume(true);
      old.accept("offline", null);
      assertEquals("locked", shell.state.snapshot().getString("status"));
    } finally {
      Files.deleteIfExists(file);
      Files.deleteIfExists(root);
    }
  }
  /**
   * Отсутствие ключа не превращается в бесконечные сетевые попытки.
   * Оболочка требует новой привязки и не назначает повтор.
   */
  @Test
  public void missingKeyRequiresPairingWithoutAutomaticRetry() throws Exception {
    Path root = Files.createTempDirectory("grigdesk-missing-key-");
    Path file = root.resolve("profiles.json");
    ProfileStore store = new ProfileStore(file.toFile(), port -> true);
    String id = store.add("Фикстура", "https://machine.example:443", "1".repeat(64)).getString("id");
    List<Long> retries = new ArrayList<>();

    try (ShellApi shell = new ShellApi(store, null, (profile, gate, report) -> {
      throw new local.grigdesk.client.key.MissingDeviceKeyException();
    }, (callback, delay) -> {
      retries.add(delay);
      return () -> {};
    }, Runnable::run, profile -> {}, null, () -> 0.5, 0, 1)) {
      store.select(id);
      shell.connect(id, true);
      assertEquals("unpaired", shell.state.snapshot().getString("status"));
      assertTrue(retries.isEmpty());
    } finally {
      Files.deleteIfExists(file);
      Files.deleteIfExists(root);
    }
  }

  /**
   * Уход в фон не закрывает TLS на вызывающем главном потоке.
   * Поколение соединения гасится сразу, сетевое освобождение выполняет работник.
   */
  @Test
  public void suspendClosesTransportOnWorker() throws Exception {
    Path root = Files.createTempDirectory("grigdesk-worker-close-");
    Path file = root.resolve("profiles.json");
    ProfileStore store = new ProfileStore(file.toFile(), port -> true);
    String id = store.add("Фикстура", "https://machine.example:443", "1".repeat(64)).getString("id");
    java.util.concurrent.ExecutorService worker = java.util.concurrent.Executors.newSingleThreadExecutor();
    java.util.concurrent.CountDownLatch probed = new java.util.concurrent.CountDownLatch(1);
    java.util.concurrent.CountDownLatch closed = new java.util.concurrent.CountDownLatch(1);
    java.util.concurrent.atomic.AtomicReference<Thread> closingThread =
      new java.util.concurrent.atomic.AtomicReference<>();
    Thread caller = Thread.currentThread();

    try (ShellApi shell = new ShellApi(store, null, (profile, gate, report) -> new ShellApi.Transport() {
      public void probe() {
        probed.countDown();
      }
      public void close() {
        closingThread.set(Thread.currentThread());
        closed.countDown();
      }
      public Upstream pipe() {
        return null;
      }
    }, (callback, delay) -> () -> {}, worker::execute, profile -> {}, null, () -> 0.5, 0, 1)) {
      store.select(id);
      shell.connect(id, true);
      assertTrue(probed.await(5, java.util.concurrent.TimeUnit.SECONDS));
      shell.suspend();
      assertTrue(closed.await(5, java.util.concurrent.TimeUnit.SECONDS));
      assertNotSame(caller, closingThread.get());
    } finally {
      worker.shutdown();
      worker.awaitTermination(5, java.util.concurrent.TimeUnit.SECONDS);
      Files.deleteIfExists(file);
      Files.deleteIfExists(root);
    }
  }

  /**
   * Состояние работающего транспорта проверяет probe, не ошибки отдельного запроса.
   * Периодическая проверка переиспользует транспорт и прекращается после отключения.
   */
  @Test
  public void onlineHealthProbeKeepsTransportAndStopsOnDisconnect() throws Exception {
    Path root = Files.createTempDirectory("grigdesk-health-");
    Path file = root.resolve("profiles.json");
    ProfileStore store = new ProfileStore(file.toFile(), port -> true);
    String id = store.add("Фикстура", "https://machine.example:443", "1".repeat(64)).getString("id");
    List<Long> delays = new ArrayList<>();
    List<Runnable> callbacks = new ArrayList<>();
    java.util.concurrent.atomic.AtomicInteger probes = new java.util.concurrent.atomic.AtomicInteger();

    try (ShellApi shell = new ShellApi(store, null, (profile, gate, report) -> new ShellApi.Transport() {
      public void probe() {
        probes.incrementAndGet();
        report.accept("online", null);
      }
      public void close() {
      }
      public Upstream pipe() {
        return null;
      }
    }, (callback, delay) -> {
      callbacks.add(callback);
      delays.add(delay);
      return () -> {};
    }, Runnable::run, profile -> {}, null, () -> 0.5, 0, 1)) {
      store.select(id);
      shell.connect(id, true);
      assertEquals(List.of(5000L), delays);
      callbacks.get(0).run();
      assertEquals(2, probes.get());
      shell.disconnect(id);
      callbacks.get(1).run();
      assertEquals(2, probes.get());
    } finally {
      Files.deleteIfExists(file);
      Files.deleteIfExists(root);
    }
  }


  /**
   * Живой транспорт переносит две неудачи фонового hello без закрытия потоков.
   * Третий отказ даёт offline; успешная проверка между отказами сбрасывает счётчик.
   */
  @Test
  public void threeBackgroundFailuresAreRequiredBeforeReconnect() throws Exception {
    Path root = Files.createTempDirectory("grigdesk-health-threshold-");
    Path file = root.resolve("profiles.json");
    ProfileStore store = new ProfileStore(file.toFile(), port -> true);
    String id = store.add("Машина", "https://machine.example:443", "1".repeat(64)).getString("id");
    List<Runnable> callbacks = new ArrayList<>();
    java.util.concurrent.atomic.AtomicBoolean failing = new java.util.concurrent.atomic.AtomicBoolean();
    java.util.concurrent.atomic.AtomicInteger closed = new java.util.concurrent.atomic.AtomicInteger();

    try (ShellApi shell = new ShellApi(store, null, (profile, gate, report) -> new ShellApi.Transport() {
      public void probe() {
        report.accept(failing.get() ? "offline" : "online", null);
      }
      public void close() {
        closed.incrementAndGet();
      }
      public Upstream pipe() {
        return null;
      }
    }, (callback, delay) -> {
      callbacks.add(callback);
      return () -> {};
    }, Runnable::run, profile -> {}, null, () -> 0.5, 0, 1)) {
      store.select(id);
      shell.connect(id, true);
      failing.set(true);
      callbacks.get(callbacks.size() - 1).run();
      assertEquals("online", shell.state.snapshot().getString("status"));
      assertEquals(0, closed.get());
      failing.set(false);
      callbacks.get(callbacks.size() - 1).run();
      failing.set(true);

      for (String expected : List.of("online", "online", "offline")) {
        callbacks.get(callbacks.size() - 1).run();
        assertEquals(expected, shell.state.snapshot().getString("status"));
      }
      assertEquals(0, closed.get());
    } finally {
      Files.deleteIfExists(file);
      Files.deleteIfExists(root);
    }
  }
}
