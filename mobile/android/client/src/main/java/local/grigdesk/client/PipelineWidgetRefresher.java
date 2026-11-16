package local.grigdesk.client;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.time.Instant;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.LongSupplier;
import local.grigdesk.client.key.KeyFailure;
import local.grigdesk.client.pipe.HttpHead;
import local.grigdesk.client.pipe.PipeResponse;
import local.grigdesk.client.pipe.PipeTransport;
import local.grigdesk.client.pipe.StaticAssets;
import local.grigdesk.client.shell.ProfileStore;
import org.json.JSONObject;

/**
 * Один процессный замок охватывает чтение, запрос и публикацию всех воркеров.
 * Сохранённое поколение объединяет очередь, но не теряет событие во время запроса.
 */
public final class PipelineWidgetRefresher {
  public interface TransportFactory {
    PipeTransport create(JSONObject profile) throws Exception;
  }

  public interface Sleeper {
    void sleep(long millis) throws InterruptedException;
  }

  public interface Deadline {
    AutoCloseable arm(Runnable expired);
  }

  public static final long MIN_INTERVAL_MILLIS = 10000;
  private static final ReentrantLock RUN_LOCK = new ReentrantLock();
  private static final Set<String> PAIRING_CODES = Set.of("unpaired", "revoked", "device_revoked",
    "device_unknown", "device_scope_forbidden", "pair_locked");
  private final File profilesFile;
  private final PipelineWidgetStore store;
  private final TransportFactory factory;
  private final LongSupplier clock;
  private final LongSupplier requests;
  private final Sleeper sleeper;
  private final Deadline deadline;
  private final Object lifecycle = new Object();
  private volatile Thread runner;
  private volatile PipeTransport active;
  private volatile boolean cancelled;
  private volatile boolean expired;

  /**
   * Часы, поколение запроса, ожидание и deadline внедряются для тестов без сна.
   * Android-обёртка владеет настоящим таймером и сигналом остановки WorkManager.
   */
  public PipelineWidgetRefresher(File profilesFile, PipelineWidgetStore store,
    TransportFactory factory, LongSupplier clock, LongSupplier requests, Sleeper sleeper,
    Deadline deadline) {
    this.profilesFile = profilesFile;
    this.store = store;
    this.factory = factory;
    this.clock = clock;
    this.requests = requests;
    this.sleeper = sleeper;
    this.deadline = deadline;
  }

  /**
   * Stop запрещает публикацию и снимает ожидание замка/окна частоты.
   * Активный transport закрывается явно: WorkManager сам не отменяет блокирующий HTTP.
   */
  public void cancel() {
    synchronized (lifecycle) {
      cancelled = true;
    }

    Thread thread = runner;
    PipeTransport transport = active;

    if (thread != null) {
      thread.interrupt();
    }

    if (transport != null) {
      transport.close();
    }
  }

  /**
   * Deadline закрывает собственный HTTP, сохраняя возможность записать offline.
   * В отличие от stop, такой отказ имеет видимое состояние и сохраняет прежние данные.
   */
  private void expire() {
    synchronized (lifecycle) {
      expired = true;
    }

    PipeTransport transport = active;

    if (transport != null) {
      transport.close();
    }
  }

  /**
   * Все экземпляры выполняются последовательно, включая periodic и one-shot.
   * Отмена ожидающего экземпляра не закрывает транспорт другого владельца.
   */
  public void run() throws Exception {
    runner = Thread.currentThread();
    boolean acquired = false;

    try {
      if (cancelled) {
        return;
      }

      RUN_LOCK.lockInterruptibly();
      acquired = true;

      if (!cancelled) {
        runLocked();
      }
    } finally {
      runner = null;

      if (acquired) {
        RUN_LOCK.unlock();
      }
    }
  }

  /**
   * Файл профилей перечитывается до throttle и перед commit.
   * Повреждённый выбор не позволяет выдавать кэш неизвестного источника за текущий.
   */
  private JSONObject selected() throws Exception {
    ProfileStore profiles = new ProfileStore(profilesFile, port -> true);

    return profiles.selected == null ? null : profiles.get(profiles.selected);
  }

  /**
   * Проверка перед публикацией не даёт позднему ответу прежней машины стать текущим.
   * Даже при смене выбора после этой проверки provider фильтрует кэш по свежему id.
   */
  private boolean stillSelected(String id) {
    try {
      JSONObject profile = selected();

      return id.equals(profile == null ? "" : profile.optString("id"));
    } catch (Exception exception) {
      return id.isEmpty();
    }
  }

  /**
   * Новое поколение после недавней попытки ждёт остаток окна, а не теряется.
   * Поколение берётся до HTTP: событие во время запроса оставляет работу следующему worker.
   */
  private void runLocked() throws Exception {
    JSONObject profile;
    boolean profilesBroken = false;

    try {
      profile = selected();
    } catch (Exception exception) {
      profile = null;
      profilesBroken = true;
    }

    String id = profile == null ? "" : profile.getString("id");
    JSONObject previous = store.readFor(id);
    long requestId = requests.getAsLong();
    long now = clock.getAsLong();

    if (previous != null && previous.optLong("requestId") >= requestId) {
      return;
    }

    long age = previous == null ? MIN_INTERVAL_MILLIS : now - previous.optLong("fetchedAt");

    if (age >= 0 && age < MIN_INTERVAL_MILLIS) {
      sleeper.sleep(MIN_INTERVAL_MILLIS - age);
      now = clock.getAsLong();
    }

    if (cancelled || !stillSelected(id)) {
      return;
    }

    JSONObject record = base(previous, now, id, requestId);

    if (profile == null) {
      record.put("state", profilesBroken ? "offline" : "no_machine");
      commit(record, id);
      return;
    }

    try (PipeTransport transport = factory.create(profile)) {
      synchronized (lifecycle) {
        if (cancelled) {
          return;
        }

        active = transport;
      }

      try (AutoCloseable alarm = deadline.arm(this::expire);
        PipeResponse response = transport.forward(
          new HttpHead("GET /api/factory/widget-summary HTTP/1.1", Map.of()),
          new ByteArrayInputStream(new byte[0]))) {
        if (response.status != 200) {
          record.put("state", failureState(response));
        } else {
          JSONObject summary = new JSONObject(StaticAssets.readText(response.body, 65536));

          if (!validSummary(summary)) {
            throw new IllegalArgumentException("Неверная сводка виджета.");
          }

          record.put("running", summary.getInt("running"));
          record.put("waiting", summary.getInt("waiting"));
          record.put("stalled", summary.getInt("stalled"));
          record.put("at", summary.getString("at"));
          record.put("state", "ok");
        }
      }
    } catch (Exception exception) {
      record = base(previous, now, id, requestId);
      record.put("state", KeyFailure.status(exception));
    } finally {
      active = null;
    }

    if (expired) {
      record = base(previous, now, id, requestId);
    }

    commit(record, id);
  }

  /**
   * Публикация атомарна относительно stop этого экземпляра и проверяет текущий источник.
   * Сетевая ошибка, отмена и смена машины не могут подменить успешные данные другой машины.
   */
  private void commit(JSONObject record, String id) throws Exception {
    synchronized (lifecycle) {
      if (!cancelled && stillSelected(id)) {
        if (expired) {
          record = base(store.readFor(id), record.optLong("fetchedAt"), id, record.optLong("requestId"));
        }

        store.save(record);
      }
    }
  }

  /**
   * Wire DTO проверяется до преобразований: строки и дроби не становятся счётчиками.
   * Только успешная непустая ISO-отметка разрешает показывать числовые значения.
   */
  private static boolean validSummary(JSONObject data) {
    if (data.length() != 4 || !(data.opt("at") instanceof String)) {
      return false;
    }

    for (String key : new String[] { "running", "waiting", "stalled" }) {
      if (!(data.opt(key) instanceof Integer) || data.optInt(key) < 0 || data.optInt(key) > 1000000) {
        return false;
      }
    }

    try {
      Instant.parse(data.getString("at"));

      return true;
    } catch (Exception exception) {
      return false;
    }
  }

  /**
   * Body содержит исходный error code, который отличается от статуса RoutedUpstream.
   * Таблица повторяет реальные коды Upstream/VersionGate; неизвестное остаётся offline.
   */
  private static String failureState(PipeResponse response) {
    try {
      JSONObject body = new JSONObject(StaticAssets.readText(response.body, 4096));
      String code = body.optString("error", "");

      if (PAIRING_CODES.contains(code)) {
        return "unpaired";
      }

      if (Set.of("locked", "identityMismatch", "client_upgrade_required",
        "server_upgrade_required").contains(code)) {
        return code;
      }
    } catch (Exception exception) {
      // Пустое либо не-JSON тело не скрывает состояние отсутствующей связи.
    }

    return "offline";
  }

  /**
   * Счётчики копируются только из записи, уже отфильтрованной по profileId.
   * Пустая at оставляет прочерки до первого успеха; requestId отмечает обработанный сигнал.
   */
  private static JSONObject base(JSONObject previous, long now, String id, long requestId)
    throws Exception {
    return new JSONObject()
      .put("running", previous == null ? 0 : previous.optInt("running"))
      .put("waiting", previous == null ? 0 : previous.optInt("waiting"))
      .put("stalled", previous == null ? 0 : previous.optInt("stalled"))
      .put("at", previous == null ? "" : previous.optString("at"))
      .put("fetchedAt", now)
      .put("state", "offline")
      .put("profileId", id)
      .put("requestId", requestId);
  }
}
