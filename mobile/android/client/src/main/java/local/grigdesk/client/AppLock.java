package local.grigdesk.client;

import java.io.File;
import java.util.Set;
import java.util.function.LongSupplier;
import local.grigdesk.client.shell.ShellApi;
import local.grigdesk.client.shell.ShellLocale;
import org.json.JSONObject;

/**
 * Политика установки считает непрерывный фон монотонными часами, включая сон устройства.
 * Уведомления отправляются после освобождения монитора: ShellState может читать gate под своим.
 */
public final class AppLock implements ShellApi.Gate {
  public interface Scheduler {
    Runnable schedule(Runnable callback, long delayMillis);
  }

  public interface Listener {
    void changed();
  }

  private final File file;
  private final Scheduler scheduler;
  private final Listener listener;
  private final ShellLocale locale;
  private final LongSupplier clock;
  private AppLockPreferences preferences;
  private boolean locked;
  private boolean background;
  private long backgroundSince;
  private long generation;
  private Runnable pendingLock;

  public AppLock(File file, Scheduler scheduler, Listener listener, ShellLocale locale) {
    this(file, scheduler, listener, locale, () -> System.nanoTime() / 1000000L);
  }

  /**
   * Холодный запуск включённой или повреждённой настройки закрыт до подтверждения.
   * Android передаёт elapsedRealtime, а тесты — управляемые часы без реального ожидания.
   */
  public AppLock(File file, Scheduler scheduler, Listener listener, ShellLocale locale, LongSupplier clock) {
    this.file = file;
    this.scheduler = scheduler;
    this.listener = listener;
    this.locale = locale;
    this.clock = clock;

    try {
      preferences = AppLockPreferences.load(file);
    } catch (Exception exception) {
      preferences = new AppLockPreferences(true, AppLockPreferences.DEFAULT_DELAY_SECONDS);
    }

    locked = preferences.enabled;
  }

  @Override
  public synchronized boolean locked() {
    return locked;
  }

  public synchronized long foregroundLimitMillis() {
    return preferences.enabled ? preferences.delaySeconds * 1000L : Long.MAX_VALUE;
  }

  /**
   * Один переход в фон создаёт один срок; повторы не продлевают его.
   * Событие закрытия отправляется вне монитора gate, исключая обратный порядок блокировок.
   */
  public void enterBackground() {
    boolean changed;

    synchronized (this) {
      if (background) {
        return;
      }

      background = true;
      backgroundSince = clock.getAsLong();
      changed = scheduleBackground();
    }

    if (changed) {
      listener.changed();
    }
  }

  /**
   * Возврат сверяет полный срок, даже если Handler не исполнил таймер во сне.
   * Отмена инвалидирует уже доставленный callback и не суммирует короткие выходы.
   */
  public void leaveBackground() {
    boolean changed = false;

    synchronized (this) {
      if (background && preferences.enabled
        && clock.getAsLong() - backgroundSince >= preferences.delaySeconds * 1000L) {
        changed = !locked;
        locked = true;
      }

      background = false;
      cancelPending();
    }

    if (changed) {
      listener.changed();
    }
  }

  /**
   * Старое поколение callback не может закрыть выключенную или возвращённую установку.
   * Новый переход в фон также получает другое поколение независимо от отмены планировщиком.
   */
  private void expire(long expected) {
    boolean changed;

    synchronized (this) {
      if (generation != expected || !background || !preferences.enabled) {
        return;
      }

      pendingLock = null;
      changed = !locked;
      locked = true;
    }

    if (changed) {
      listener.changed();
    }
  }

  /**
   * Поколение меняется даже без зарегистрированного таймера, закрывая запоздалый callback.
   * Физическая отмена планировщика освобождает ресурс, но не служит проверкой актуальности.
   */
  private void cancelPending() {
    generation++;

    if (pendingLock != null) {
      pendingLock.run();
      pendingLock = null;
    }
  }

  /**
   * Вызывается только под монитором gate и рассчитывает срок от начала текущего фона.
   * Возвращает факт нового закрытия; сам слушатель вызывается только снаружи монитора.
   */
  private boolean scheduleBackground() {
    if (!background || !preferences.enabled || locked) {
      return false;
    }

    long remaining = preferences.delaySeconds * 1000L - (clock.getAsLong() - backgroundSince);

    if (remaining <= 0) {
      locked = true;

      return true;
    }

    long expected = generation;

    pendingLock = scheduler.schedule(() -> expire(expected), remaining);

    return false;
  }

  /**
   * Успешное подтверждение открывает gate и публикует отдельную ревизию даже без машины.
   * Если процесс уже ушёл в фон, новый срок начинается от подтверждения.
   */
  @Override
  public void unlocked() {
    synchronized (this) {
      locked = false;
      cancelPending();
      backgroundSince = clock.getAsLong();
      scheduleBackground();
    }

    listener.changed();
  }

  /**
   * Публичный снимок содержит только политику и факт закрытия.
   * Android JSONException проверяемый: преобразование сохраняет контракт Supplier без throws.
   */
  @Override
  public synchronized JSONObject snapshot() {
    try {
      return new JSONObject().put("enabled", preferences.enabled)
        .put("delaySeconds", preferences.delaySeconds).put("locked", locked);
    } catch (org.json.JSONException exception) {
      throw new IllegalStateException(exception);
    }
  }

  /**
   * Политика сохраняется целиком до изменения памяти; отказ не меняет gate и таймер.
   * Передний план никогда не закрывается выбором срока: новое правило действует в фоне.
   */
  @Override
  public void update(JSONObject data) throws Exception {
    synchronized (this) {
      if (data.length() != 2 || !(data.opt("enabled") instanceof Boolean)
        || !(data.opt("delaySeconds") instanceof Integer)
        || !Set.of(0, 60, 300).contains(data.getInt("delaySeconds"))) {
        throw new IllegalArgumentException(ShellLocale.text(locale, "native.appLockInvalid",
          "Неверные поля блокировки приложения."));
      }

      AppLockPreferences value = new AppLockPreferences(data.getBoolean("enabled"),
        data.getInt("delaySeconds"));

      try {
        AppLockPreferences.save(file, value);
      } catch (Exception exception) {
        throw new IllegalStateException(ShellLocale.text(locale, "native.appLockSaveFailure",
          "Не удалось сохранить настройку блокировки."), exception);
      }

      preferences = value;
      cancelPending();

      if (!value.enabled) {
        locked = false;
      }

      scheduleBackground();
    }

    listener.changed();
  }
}
