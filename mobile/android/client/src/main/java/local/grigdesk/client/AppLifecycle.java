package local.grigdesk.client;

import java.util.function.LongSupplier;

public final class AppLifecycle {
  public interface Hooks {
    void background();
    void foreground(boolean locked);
  }

  private final LongSupplier clock;
  private final Hooks hooks;
  private int started;
  private int nativeFlows;
  private boolean rotating;
  private boolean background;
  private Long authenticatedAt;
  private Long invisibleSince;

  public AppLifecycle(LongSupplier clock, Hooks hooks) {
    this.clock = clock;
    this.hooks = hooks;
  }

  public synchronized boolean isBackground() {
    return background;
  }

  public synchronized void authenticated() {
    authenticatedAt = clock.getAsLong();
  }

  /**
   * Несколько Activity считаются одним приложением, поворот не создаёт новый вход.
   * Возврат проверяет срок последней аутентификации независимо от сохранённого WebView.
   */
  public synchronized void started() {
    started++;
    rotating = false;
    invisibleSince = null;

    if (background) {
      background = false;
      hooks.foreground(authenticatedAt != null && clock.getAsLong() - authenticatedAt > 600000);
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
      invisibleSince = null;
      return;
    }

    if (started == 0 && !rotating) {
      if (nativeFlows > 0) {
        long now = clock.getAsLong();

        if (invisibleSince == null) {
          invisibleSince = now;
        }

        if (now - invisibleSince < 60000) {
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

  private void enterBackground() {
    if (!background) {
      background = true;
      hooks.background();
    }
  }
}
