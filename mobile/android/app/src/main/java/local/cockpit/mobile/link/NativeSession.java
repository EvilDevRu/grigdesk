package local.cockpit.mobile.link;

import java.util.function.LongSupplier;

/**
 * Сессия вычисляет unlock по monotonic времени и поколению, не по сохранённому boolean.
 * Один барьер применяется к request, SSE, pair, media, outbox и обновлению APK.
 */
public final class NativeSession {

  private final LongSupplier clock;
  private long deadline;
  private long generation;
  private boolean foreground = true;
  private boolean unlocked;

  public NativeSession(LongSupplier clock) {
    this.clock = clock;
  }

  public synchronized long unlock() {
    return unlockAt(clock.getAsLong());
  }

  /**
   * Окно доступа начинается от monotonic момента успешной аутентификации.
   * Новое поколение отзывает старые ответы и сохраняет общий десятиминутный deadline.
   */
  public synchronized long unlockAt(long authenticatedAt) {
    generation += 1;
    unlocked = true;
    deadline = authenticatedAt + 600000L;

    return generation;
  }

  /**
   * Переключение посредника меняет поколение, но не продлевает срок аутентификации.
   * Поздние ответы прежнего транспорта теряют право публикации сразу после rotate.
   */
  public synchronized long rotate() {
    capture();
    generation += 1;

    return generation;
  }

  public synchronized long remaining() {
    return isUnlocked() ? Math.max(0, deadline - clock.getAsLong()) : 0;
  }

  public synchronized void lock() {
    unlocked = false;
    deadline = 0;
    generation += 1;
  }

  public synchronized void background() {
    foreground = false;
    lock();
  }

  public synchronized void foreground() {
    foreground = true;
  }

  public synchronized boolean isUnlocked() {
    return foreground && unlocked && clock.getAsLong() < deadline;
  }

  public synchronized long generation() {
    return generation;
  }

  public synchronized long capture() {
    if (!isUnlocked()) {
      throw new IllegalStateException("locked");
    }

    return generation;
  }

  public synchronized boolean isCurrent(long captured) {
    return captured == generation && isUnlocked();
  }

  public synchronized void require(long captured) {
    if (!isCurrent(captured)) {
      throw new IllegalStateException("locked");
    }
  }
}
