package local.grigdesk.client;

import java.util.function.Consumer;

/**
 * Видимость удерживаемого документа принадлежит нативному окну, а не long-poll.
 * Возврат сначала сверяет срок gate и только потом разрешает показ прежнего документа.
 */
public final class AppLockScreen {
  private final AppLock lock;
  private final Consumer<Boolean> visibility;
  private boolean foreground;

  /**
   * Новый владелец сразу скрывает удерживаемый документ до подтверждения видимости Activity.
   * Начальная публикация не зависит от загрузки страницы или готовности локальной трубы.
   */
  public AppLockScreen(AppLock lock, Consumer<Boolean> visibility) {
    this.lock = lock;
    this.visibility = visibility;
    refresh();
  }

  /**
   * Проверка прошедшего фона выполняется до первого разрешения показа документа.
   * Даже задержанный таймер не оставляет промежуток с видимым закрытым интерфейсом.
   */
  public void started() {
    lock.leaveBackground();
    foreground = true;
    refresh();
  }

  /**
   * Документ скрывается до передачи окна системе, включая переход в нативный диалог.
   * Сам факт остановки Activity не меняет политику: настоящий фон считает AppLifecycle.
   */
  public void stopped() {
    foreground = false;
    refresh();
  }

  public void refresh() {
    visibility.accept(foreground && !lock.locked());
  }
}
