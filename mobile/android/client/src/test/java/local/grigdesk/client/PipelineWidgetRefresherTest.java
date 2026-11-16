package local.grigdesk.client;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.Socket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import local.grigdesk.client.key.MissingDeviceKeyException;
import local.grigdesk.client.pipe.HttpHead;
import local.grigdesk.client.pipe.PipeResponse;
import local.grigdesk.client.pipe.PipeTransport;
import local.grigdesk.client.shell.ProfileStore;
import org.json.JSONObject;
import org.junit.Test;

public class PipelineWidgetRefresherTest {
  private static class FakeTransport implements PipeTransport {
    private final PipeResponse response;

    FakeTransport(PipeResponse response) {
      this.response = response;
    }

    public PipeResponse forward(HttpHead head, InputStream body) throws Exception {
      return response;
    }

    public void upgrade(HttpHead head, Socket downstream, InputStream input, ExecutorService pool) {
    }

    public void probe() {
    }

    public void close() {
    }
  }

  private static JSONObject summary(int running, int waiting, int stalled) throws Exception {
    return new JSONObject()
      .put("running", running)
      .put("waiting", waiting)
      .put("stalled", stalled)
      .put("at", "2026-11-15T10:00:00.000Z");
  }

  /**
   * Фикстура выбранной машины: профиль создаётся и выбирается во временном файле.
   * Возвращает путь к client-profiles.json для обновителя.
   */
  private static Path profiles(Path root) throws Exception {
    ProfileStore store = new ProfileStore(root.resolve("client-profiles.json").toFile(),
      port -> true);
    JSONObject profile = store.add("Машина", "https://machine.example:443", "1".repeat(64));

    store.select(profile.getString("id"));

    return root.resolve("client-profiles.json");
  }

  /**
   * Успешный запрос сохраняет счётчики, а повтор в окне 10 секунд не ходит на машину.
   * После окна запрос проходит снова: шторм событий гасится без потери свежести.
   */
  @Test
  public void fetchStoresCountersAndThrottlesRepeat() throws Exception {
    Path root = Files.createTempDirectory("grigdesk-widget-refresh-");
    Path profilesFile = profiles(root);
    Path cacheFile = root.resolve("pipeline-widget.json");
    List<String> calls = new ArrayList<>();
    long[] clock = { 100000L };
    PipelineWidgetRefresher.TransportFactory factory = profile -> {
      calls.add(profile.getString("id"));

      return new FakeTransport(PipeResponse.json(200, summary(2, 1, 0)));
    };
    PipelineWidgetRefresher refresher = new PipelineWidgetRefresher(profilesFile.toFile(),
      new PipelineWidgetStore(cacheFile.toFile()), factory, () -> clock[0], () -> clock[0],
      millis -> clock[0] += millis, action -> () -> {});

    refresher.run();

    JSONObject cache = new PipelineWidgetStore(cacheFile.toFile()).read();

    assertNotNull(cache);
    assertEquals("ok", cache.getString("state"));
    assertEquals(2, cache.getInt("running"));
    assertEquals(1, cache.getInt("waiting"));
    assertEquals(1, calls.size());

    refresher.run();

    assertEquals(1, calls.size());

    clock[0] += PipelineWidgetRefresher.MIN_INTERVAL_MILLIS;
    refresher.run();

    assertEquals(2, calls.size());

    Files.deleteIfExists(cacheFile);
    Files.deleteIfExists(profilesFile);
    Files.deleteIfExists(root);
  }

  /**
   * Отказ связи сохраняет последние счётчики и помечает состояние offline.
   * Утраченный ключ даёт unpaired, а не падение обновления.
   */
  @Test
  public void failureKeepsPreviousCountersAndReportsState() throws Exception {
    Path root = Files.createTempDirectory("grigdesk-widget-refresh-fail-");
    Path profilesFile = profiles(root);
    Path cacheFile = root.resolve("pipeline-widget.json");
    long[] clock = { 100000L };
    boolean[] fail = { false };
    PipelineWidgetRefresher.TransportFactory factory = profile -> {
      if (fail[0]) {
        throw new IOException("сеть недоступна");
      }

      return new FakeTransport(PipeResponse.json(200, summary(2, 1, 0)));
    };
    PipelineWidgetRefresher refresher = new PipelineWidgetRefresher(profilesFile.toFile(),
      new PipelineWidgetStore(cacheFile.toFile()), factory, () -> clock[0], () -> clock[0],
      millis -> clock[0] += millis, action -> () -> {});

    refresher.run();

    fail[0] = true;
    clock[0] += PipelineWidgetRefresher.MIN_INTERVAL_MILLIS;
    refresher.run();

    JSONObject cache = new PipelineWidgetStore(cacheFile.toFile()).read();

    assertEquals("offline", cache.getString("state"));
    assertEquals(2, cache.getInt("running"));

    PipelineWidgetRefresher missingKey = new PipelineWidgetRefresher(profilesFile.toFile(),
      new PipelineWidgetStore(cacheFile.toFile()),
      profile -> {
        throw new MissingDeviceKeyException();
      }, () -> clock[0], () -> clock[0], millis -> clock[0] += millis, action -> () -> {});

    clock[0] += PipelineWidgetRefresher.MIN_INTERVAL_MILLIS;
    missingKey.run();

    assertEquals("unpaired", new PipelineWidgetStore(cacheFile.toFile()).read().getString("state"));

    Files.deleteIfExists(cacheFile);
    Files.deleteIfExists(profilesFile);
    Files.deleteIfExists(root);
  }

  /**
   * Без выбранной машины обновление не ходит в сеть и пишет no_machine.
   * Не-200 и битый ответ сервера читаются как offline без порчи счётчиков.
   */
  @Test
  public void noMachineAndBadResponseStoreStates() throws Exception {
    Path root = Files.createTempDirectory("grigdesk-widget-refresh-empty-");
    Path profilesFile = root.resolve("client-profiles.json");
    Path cacheFile = root.resolve("pipeline-widget.json");
    List<String> calls = new ArrayList<>();
    PipelineWidgetRefresher refresher = new PipelineWidgetRefresher(profilesFile.toFile(),
      new PipelineWidgetStore(cacheFile.toFile()),
      profile -> {
        calls.add("call");

        return new FakeTransport(PipeResponse.json(200, summary(1, 0, 0)));
      }, () -> 100000L, () -> 1L, millis -> {}, action -> () -> {});

    refresher.run();

    assertEquals("no_machine",
      new PipelineWidgetStore(cacheFile.toFile()).read().getString("state"));
    assertTrue(calls.isEmpty());

    Path withMachine = profiles(root);
    PipelineWidgetRefresher bad = new PipelineWidgetRefresher(withMachine.toFile(),
      new PipelineWidgetStore(cacheFile.toFile()),
      profile -> new FakeTransport(PipeResponse.error(500, "server_error")), () -> 200000L, () -> 2L,
      millis -> {}, action -> () -> {});

    bad.run();

    assertEquals("offline", new PipelineWidgetStore(cacheFile.toFile()).read().getString("state"));

    Files.deleteIfExists(cacheFile);
    Files.deleteIfExists(withMachine);
    Files.deleteIfExists(root);
  }

  /**
   * Битый файл машин и битое тело ответа не роняют обновление и не портят счётчики.
   * Неизвестный источник скрывает числа; битый ответ не создаёт успешного снимка.
   * Восстановленный профиль получает собственную область кэша.
   */
  @Test
  public void damagedProfilesAndBadBodyStoreOffline() throws Exception {
    Path root = Files.createTempDirectory("grigdesk-widget-refresh-damaged-");
    Path profilesFile = profiles(root);
    Path cacheFile = root.resolve("pipeline-widget.json");
    long[] clock = { 100000L };
    PipelineWidgetRefresher ok = new PipelineWidgetRefresher(profilesFile.toFile(),
      new PipelineWidgetStore(cacheFile.toFile()),
      profile -> new FakeTransport(PipeResponse.json(200, summary(3, 2, 1))), () -> clock[0], () -> clock[0],
      millis -> clock[0] += millis, action -> () -> {});

    ok.run();

    Files.write(profilesFile, "{битый json".getBytes(java.nio.charset.StandardCharsets.UTF_8));
    clock[0] += PipelineWidgetRefresher.MIN_INTERVAL_MILLIS;

    PipelineWidgetRefresher damaged = new PipelineWidgetRefresher(profilesFile.toFile(),
      new PipelineWidgetStore(cacheFile.toFile()),
      profile -> new FakeTransport(PipeResponse.json(200, summary(9, 9, 9))), () -> clock[0], () -> clock[0],
      millis -> clock[0] += millis, action -> () -> {});

    damaged.run();

    JSONObject cache = new PipelineWidgetStore(cacheFile.toFile()).read();

    assertEquals("offline", cache.getString("state"));
    assertEquals("–", PipelineWidgetStore.counterText(cache, "running"));

    Files.deleteIfExists(profilesFile);

    Path repaired = profiles(root);
    PipelineWidgetRefresher badBody = new PipelineWidgetRefresher(repaired.toFile(),
      new PipelineWidgetStore(cacheFile.toFile()),
      profile -> new FakeTransport(PipeResponse.json(200, new JSONObject().put("running", 5))),
      () -> clock[0], () -> clock[0], millis -> clock[0] += millis, action -> () -> {});

    clock[0] += PipelineWidgetRefresher.MIN_INTERVAL_MILLIS;
    badBody.run();

    cache = new PipelineWidgetStore(cacheFile.toFile()).read();

    assertEquals("offline", cache.getString("state"));
    assertEquals("–", PipelineWidgetStore.counterText(cache, "running"));

    Files.deleteIfExists(cacheFile);
    Files.deleteIfExists(repaired);
    Files.deleteIfExists(root);
  }

  /**
   * Терминальные состояния транспорта приходят кодом ответа, а не исключением.
   * Причина блокировки ключа сохраняется в кэше, счётчики переживают отказ.
   */
  @Test
  public void terminalResponseCodesKeepReason() throws Exception {
    Path root = Files.createTempDirectory("grigdesk-widget-refresh-terminal-");
    Path profilesFile = profiles(root);
    Path cacheFile = root.resolve("pipeline-widget.json");
    long[] clock = { 100000L };
    PipelineWidgetRefresher ok = new PipelineWidgetRefresher(profilesFile.toFile(),
      new PipelineWidgetStore(cacheFile.toFile()),
      profile -> new FakeTransport(PipeResponse.json(200, summary(2, 1, 0))), () -> clock[0], () -> clock[0],
      millis -> clock[0] += millis, action -> () -> {});

    ok.run();

    String[] codes = { "locked", "unpaired", "identityMismatch", "route_error",
      "device_revoked", "device_unknown", "device_scope_forbidden", "pair_locked",
      "client_upgrade_required", "server_upgrade_required" };
    String[] states = { "locked", "unpaired", "identityMismatch", "offline",
      "unpaired", "unpaired", "unpaired", "unpaired", "client_upgrade_required", "server_upgrade_required" };

    for (int index = 0; index < codes.length; index++) {
      String code = codes[index];
      PipelineWidgetRefresher refresher = new PipelineWidgetRefresher(profilesFile.toFile(),
        new PipelineWidgetStore(cacheFile.toFile()),
        profile -> new FakeTransport(PipeResponse.error(503, code)), () -> clock[0], () -> clock[0],
      millis -> clock[0] += millis, action -> () -> {});

      clock[0] += PipelineWidgetRefresher.MIN_INTERVAL_MILLIS;
      refresher.run();

      JSONObject cache = new PipelineWidgetStore(cacheFile.toFile()).read();

      assertEquals(states[index], cache.getString("state"));
      assertEquals(2, cache.getInt("running"));
    }

    Files.deleteIfExists(cacheFile);
    Files.deleteIfExists(profilesFile);
    Files.deleteIfExists(root);
  }

  /**
   * Фикстура даёт каждому тесту отдельные файлы, внедрённые часы и поколение запроса.
   * Сетевые барьеры управляются тестом; ожидание окна не занимает настоящие десять секунд.
   */
  private static final class Harness implements AutoCloseable {
    final Path root = Files.createTempDirectory("grigdesk-widget-cases-");
    final Path profilesFile = root.resolve("client-profiles.json");
    final PipelineWidgetStore store = new PipelineWidgetStore(root.resolve("pipeline-widget.json").toFile());
    final ProfileStore profiles = new ProfileStore(profilesFile.toFile(), port -> true);
    final java.util.concurrent.atomic.AtomicLong now = new java.util.concurrent.atomic.AtomicLong(100000);
    final java.util.concurrent.atomic.AtomicLong request = new java.util.concurrent.atomic.AtomicLong(1);
    final java.util.concurrent.atomic.AtomicInteger calls = new java.util.concurrent.atomic.AtomicInteger();
    volatile Runnable expiration;
    PipelineWidgetRefresher.TransportFactory factory = profile ->
      new FakeTransport(PipeResponse.json(200, summary(2, 1, 0)));

    Harness() throws Exception {
      profiles.select(profiles.add("A", "https://a.example:443", "1".repeat(64)).getString("id"));
    }

    /**
     * Новый экземпляр использует общие часы и поколение только этой фикстуры.
     * Отложенный deadline вызывается тестом явно и снимается при завершении запроса.
     */
    PipelineWidgetRefresher refresher() {
      return new PipelineWidgetRefresher(profilesFile.toFile(), store, profile -> {
        calls.incrementAndGet();

        return factory.create(profile);
      }, now::get, request::get, millis -> now.addAndGet(millis), action -> {
        expiration = action;

        return () -> expiration = null;
      });
    }

    /**
     * Выбор другой машины сохраняется тем же ProfileStore, что использует shell.
     * Новое поколение соответствует сигналу ClientRuntime.show после выбора.
     */
    String selectB() throws Exception {
      String id = profiles.add("B", "https://b.example:443", "2".repeat(64)).getString("id");

      profiles.select(id);
      request.incrementAndGet();

      return id;
    }

    /**
     * Очистка выполняется после освобождения потоков и сетевых барьеров теста.
     * Фикстура не оставляет записи, которые могли бы влиять на следующий сценарий.
     */
    public void close() throws Exception {
      Files.deleteIfExists(root.resolve("pipeline-widget.json"));
      Files.deleteIfExists(profilesFile);
      Files.deleteIfExists(root);
    }
  }

  /**
   * Последнее поколение внутри окна обязательно обрабатывается после ожидания.
   * Уже покрытые jobs цепочки завершаются без повторного HTTP.
   */
  @Test
  public void finalRequestInsideWindowIsNotLostAndCoveredJobsDoNotFetch() throws Exception {
    try (Harness h = new Harness()) {
      h.refresher().run();
      h.request.incrementAndGet();
      h.factory = profile -> new FakeTransport(PipeResponse.json(200, summary(0, 4, 0)));
      h.refresher().run();

      assertEquals(110000, h.now.get());
      assertEquals(4, h.store.read().getInt("waiting"));
      assertEquals(2, h.calls.get());

      h.refresher().run();

      assertEquals(2, h.calls.get());
    }
  }

  /**
   * Сигнал во время HTTP получает отдельное поколение, которое первый ответ не поглощает.
   * Следующий worker выполняет новое чтение даже без нового внешнего события.
   */
  @Test
  public void requestDuringHttpIsProcessedByFollowingWorker() throws Exception {
    try (Harness h = new Harness()) {
      h.factory = profile -> {
        h.request.incrementAndGet();

        return new FakeTransport(PipeResponse.json(200, summary(1, 0, 0)));
      };
      h.refresher().run();

      assertEquals(1, h.store.read().getLong("requestId"));

      h.factory = profile -> new FakeTransport(PipeResponse.json(200, summary(0, 1, 0)));
      h.refresher().run();

      assertEquals(2, h.store.read().getLong("requestId"));
      assertEquals(1, h.store.read().getInt("waiting"));
    }
  }

  /**
   * Смена на offline B внутри окна A не переносит счётчики или throttle прежней машины.
   * Удаление выбора оставляет причину и прочерки, а не числа удалённого профиля.
   */
  @Test
  public void switchToOfflineMachineAndRemoveSelectionHideOldCounters() throws Exception {
    try (Harness h = new Harness()) {
      h.refresher().run();
      String b = h.selectB();

      assertNull(h.store.readFor(b));

      h.factory = profile -> {
        assertEquals(b, profile.getString("id"));
        throw new IOException("offline B");
      };
      h.refresher().run();

      assertEquals(100000, h.now.get());
      assertEquals("offline", h.store.readFor(b).getString("state"));
      assertEquals("–", PipelineWidgetStore.counterText(h.store.readFor(b), "running"));

      h.profiles.remove(b);
      h.request.incrementAndGet();
      h.refresher().run();

      assertEquals("no_machine", h.store.readFor("").getString("state"));
      assertEquals("–", PipelineWidgetStore.counterText(h.store.readFor(""), "running"));
    }
  }

  /**
   * Поздний ответ A отбрасывается, если во время HTTP выбран B.
   * Provider использует тот же readFor и не показывает остаток A даже до нового запроса.
   */
  @Test
  public void selectionChangedDuringHttpRejectsOldAnswer() throws Exception {
    try (Harness h = new Harness()) {
      h.factory = profile -> new FakeTransport(PipeResponse.json(200, summary(99, 0, 0))) {
        public PipeResponse forward(HttpHead head, InputStream body) throws Exception {
          h.selectB();

          return super.forward(head, body);
        }
      };
      h.refresher().run();

      assertNull(h.store.readFor(h.profiles.selected));
      assertEquals("–", PipelineWidgetStore.counterText(h.store.readFor(h.profiles.selected), "running"));
    }
  }

  /**
   * Даже два экземпляра обновителя не входят в HTTP одновременно.
   * Барьер удерживает первый запрос, второй обязан дождаться общего замка и читать новый previous.
   */
  @Test
  public void periodicAndOneShotSerializeTheirWholeTransaction() throws Exception {
    try (Harness h = new Harness()) {
      var entered = new java.util.concurrent.CountDownLatch(1);
      var secondEntered = new java.util.concurrent.CountDownLatch(1);
      var secondStarted = new java.util.concurrent.CountDownLatch(1);
      var release = new java.util.concurrent.CountDownLatch(1);
      var pool = java.util.concurrent.Executors.newFixedThreadPool(2);

      h.factory = profile -> new FakeTransport(PipeResponse.json(200, summary(h.calls.get(), 0, 0))) {
        public PipeResponse forward(HttpHead head, InputStream body) throws Exception {
          if (h.calls.get() == 1) {
            entered.countDown();
            assertTrue(release.await(5, java.util.concurrent.TimeUnit.SECONDS));
          } else {
            secondEntered.countDown();
          }

          return super.forward(head, body);
        }
      };

      try {
        var first = pool.submit(() -> {
          h.refresher().run();

          return null;
        });

        assertTrue(entered.await(5, java.util.concurrent.TimeUnit.SECONDS));
        h.request.incrementAndGet();

        var second = pool.submit(() -> {
          secondStarted.countDown();
          h.refresher().run();

          return null;
        });

        assertTrue(secondStarted.await(5, java.util.concurrent.TimeUnit.SECONDS));
        assertFalse(secondEntered.await(200, java.util.concurrent.TimeUnit.MILLISECONDS));
        release.countDown();
        first.get(5, java.util.concurrent.TimeUnit.SECONDS);
        second.get(5, java.util.concurrent.TimeUnit.SECONDS);

        assertEquals(2, h.store.read().getInt("running"));
        assertEquals(2, h.store.read().getLong("requestId"));
      } finally {
        release.countDown();
        pool.shutdownNow();
        assertTrue(pool.awaitTermination(5, java.util.concurrent.TimeUnit.SECONDS));
      }
    }
  }


  /**
   * Управляемый блокирующий HTTP завершается только после явного close транспорта.
   * Сигналы stop/deadline приходят с другого потока, поздний success не заменяет снимок.
   */
  @Test
  public void blockedHttpIsReleasedByStopAndDeadline() throws Exception {
    for (boolean stop : new boolean[] { true, false }) {
      try (Harness h = new Harness()) {
        h.refresher().run();
        h.request.incrementAndGet();

        var entered = new java.util.concurrent.CountDownLatch(1);
        var released = new java.util.concurrent.CountDownLatch(1);
        var closed = new java.util.concurrent.atomic.AtomicBoolean();
        var pool = java.util.concurrent.Executors.newSingleThreadExecutor();
        PipelineWidgetRefresher current = h.refresher();

        h.factory = profile -> new FakeTransport(PipeResponse.json(200, summary(99, 0, 0))) {
          public PipeResponse forward(HttpHead head, InputStream body) throws Exception {
            entered.countDown();

            while (!closed.get()) {
              try {
                assertTrue(released.await(5, java.util.concurrent.TimeUnit.SECONDS));
              } catch (InterruptedException exception) {
                // Одного interrupt недостаточно: тест ждёт явного закрытия I/O.
              }
            }

            return super.forward(head, body);
          }
          public void close() {
            closed.set(true);
            released.countDown();
          }
        };

        try {
          var job = pool.submit(() -> {
            current.run();

            return null;
          });

          assertTrue(entered.await(5, java.util.concurrent.TimeUnit.SECONDS));

          if (stop) {
            current.cancel();
          } else {
            h.expiration.run();
          }

          job.get(5, java.util.concurrent.TimeUnit.SECONDS);

          assertTrue(closed.get());
          assertEquals(2, h.store.read().getInt("running"));
          assertEquals(stop ? 1 : 2, h.store.read().getLong("requestId"));
        } finally {
          current.cancel();
          released.countDown();
          pool.shutdownNow();
          assertTrue(pool.awaitTermination(5, java.util.concurrent.TimeUnit.SECONDS));
        }

        h.request.incrementAndGet();
        h.factory = profile -> new FakeTransport(PipeResponse.json(200, summary(3, 0, 0)));
        h.refresher().run();

        assertEquals(3, h.store.read().getInt("running"));
      }
    }
  }

  /**
   * Deadline и stop закрывают именно активный транспорт и не принимают его поздний ответ.
   * После stop следующий экземпляр получает замок и успешно обновляется.
   */
  @Test
  public void deadlineAndStopCloseTransportAndRejectLateSuccess() throws Exception {
    try (Harness h = new Harness()) {
      h.refresher().run();
      h.request.incrementAndGet();
      var closed = new java.util.concurrent.atomic.AtomicInteger();

      h.factory = profile -> new FakeTransport(PipeResponse.json(200, summary(99, 0, 0))) {
        public PipeResponse forward(HttpHead head, InputStream body) throws Exception {
          h.expiration.run();

          assertTrue(closed.get() > 0);
          return super.forward(head, body);
        }
        public void close() {
          closed.incrementAndGet();
        }
      };
      h.refresher().run();

      assertEquals("offline", h.store.read().getString("state"));
      assertEquals(2, h.store.read().getInt("running"));
      h.request.incrementAndGet();

      PipelineWidgetRefresher stopped = h.refresher();
      h.factory = profile -> new FakeTransport(PipeResponse.json(200, summary(88, 0, 0))) {
        public PipeResponse forward(HttpHead head, InputStream body) throws Exception {
          stopped.cancel();

          return super.forward(head, body);
        }
        public void close() {
          closed.incrementAndGet();
        }
      };

      try {
        stopped.run();
      } finally {
        Thread.interrupted();
      }

      assertEquals(2, h.store.read().getInt("running"));
      assertEquals(2, h.store.read().getLong("requestId"));
      h.factory = profile -> new FakeTransport(PipeResponse.json(200, summary(3, 0, 0)));
      h.refresher().run();

      assertEquals(3, h.store.read().getInt("running"));
    }
  }

  /**
   * Отсутствующая отметка, строка и дробь не нормализуются в успешную сводку.
   * При каждом отказе сохраняется успешный снимок той же машины.
   */
  @Test
  public void malformedSuccessKeepsPreviousSnapshot() throws Exception {
    try (Harness h = new Harness()) {
      h.refresher().run();

      JSONObject missingAt = summary(9, 8, 7);

      missingAt.remove("at");

      JSONObject[] invalid = {
        missingAt,
        summary(9, 8, 7).put("running", "9"),
        summary(9, 8, 7).put("running", 1.5),
      };

      for (JSONObject body : invalid) {
        h.request.incrementAndGet();
        h.factory = profile -> new FakeTransport(PipeResponse.json(200, body));
        h.refresher().run();

        assertEquals("offline", h.store.read().getString("state"));
        assertEquals(2, h.store.read().getInt("running"));
      }
    }
  }

}
