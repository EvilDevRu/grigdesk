package local.grigdesk.client;

import java.util.function.LongSupplier;

/**
 * Подсказка locked приходит только после непрерывного фона дольше порога политики.
 * Активная работа внутри приложения срок не расходует, короткие выходы не суммируются.
 */
public final class AppLifecycle {
  public interface Hooks {
    void background();
    void foreground(boolean locked);
  }

  private final LongSupplier clock;
  private final LongSupplier limitMillis;
  private final Hooks hooks;
  private int started;
  private int nativeFlows;
  private boolean rotating;
  private boolean background;
  private Long backgroundSince;

  /**
   * Прежние потребители без политики сохраняют прежний порог 600 секунд,
   * но тоже считают только фон: поведение «время от аутентификации» удалено.
   */
  public AppLifecycle(LongSupplier clock, Hooks hooks) {
    this(clock, hooks, () -> 600000);
  }

  /**
   * Порог приходит от gate установки и может запрещать подсказку совсем
   * максимальным значением: выключенная блокировка не даёт locked от жизненного цикла.
   */
  public AppLifecycle(LongSupplier clock, Hooks hooks, LongSupplier limitMillis) {
    this.clock = clock;
    this.limitMillis = limitMillis;
    this.hooks = hooks;
  }

  public synchronized boolean isBackground() {
    return background;
  }

  /**
   * При возврате измеряется только завершившийся непрерывный фон, затем отметка сбрасывается.
   * Поворот и повторные started не создают новый срок и не расходуют активное время.
   */
  public synchronized void started() {
    started++;
    rotating = false;
    boolean expired = background && backgroundSince != null
      && clock.getAsLong() - backgroundSince > limitMillis.getAsLong();

    backgroundSince = null;

    if (background) {
      background = false;
      hooks.foreground(expired);
    }
  }

  public synchronized void stopped(boolean changingConfiguration) {
    started = Math.max(0, started - 1);
    rotating = changingConfiguration;
    considerBackground();
  }

  public synchronized void nativeFlow(boolean active) {
    nativeFlows = Math.max(0, nativeFlows + (active ? 1 : -1));
    considerBackground();
  }

  /**
   * Системный диалог сохраняет соединения лишь минуту после потери видимости.
   * Домой из picker или сканера больше не оставляет потоки жить в фоне без срока.
   */
  public synchronized void processForeground(boolean foreground) {
    if (foreground) {
      backgroundSince = null;
      return;
    }

    if (started == 0 && !rotating) {
      if (nativeFlows > 0) {
        long now = clock.getAsLong();

        if (backgroundSince == null) {
          backgroundSince = now;
        }

        if (now - backgroundSince < 60000) {
          return;
        }
      }

      enterBackground();
    }
  }

  private void considerBackground() {
    if (started == 0 && nativeFlows == 0 && !rotating) {
      enterBackground();
    }
  }

  /**
   * Момент входа в фон запоминается для счёта непрерывного фона.
   * Возврат обнуляет его до проверки, поэтому активная работа срок не двигает.
   */
  private void enterBackground() {
    if (!background) {
      background = true;
      backgroundSince = clock.getAsLong();
      hooks.background();
    }
  }
}
