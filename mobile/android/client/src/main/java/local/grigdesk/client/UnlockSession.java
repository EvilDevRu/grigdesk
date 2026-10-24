package local.grigdesk.client;

import java.util.concurrent.CompletableFuture;
import java.util.function.Consumer;

/**
 * Один системный запрос принадлежит приложению и переживает смену Activity.
 * Все методы вызываются в UI-потоке; повторное нажатие ждёт тот же результат.
 */
public final class UnlockSession {
  private final Runnable authenticated;
  private final Consumer<Boolean> nativeFlow;
  private CompletableFuture<Void> pending;

  public UnlockSession(Runnable authenticated, Consumer<Boolean> nativeFlow) {
    this.authenticated = authenticated;
    this.nativeFlow = nativeFlow;
  }

  /**
   * Повтор не открывает второй prompt и не увеличивает счётчик системных переходов.
   * Синхронный отказ показа освобождает запрос так же, как отмена Android.
   */
  public CompletableFuture<Void> request(Runnable showPrompt) {
    if (pending != null) {
      return pending;
    }

    CompletableFuture<Void> result = new CompletableFuture<>();

    pending = result;
    nativeFlow.accept(true);

    try {
      showPrompt.run();
    } catch (RuntimeException exception) {
      failed(exception);
    }

    return result;
  }

  /**
   * Только ожидаемое успешное подтверждение продлевает доступ к ключу.
   * Повторный callback после завершения не изменяет срок аутентификации.
   */
  public void succeeded() {
    if (pending == null) {
      return;
    }

    authenticated.run();
    finish(null);
  }

  public void failed(Throwable failure) {
    finish(failure);
  }

  /**
   * Ожидание снимается до публикации результата, поэтому callback может начать новый вход.
   * Счётчик nativeFlow уменьшается ровно один раз при любом исходе.
   */
  private void finish(Throwable failure) {
    CompletableFuture<Void> result = pending;

    if (result == null) {
      return;
    }

    pending = null;
    nativeFlow.accept(false);

    if (failure == null) {
      result.complete(null);
    } else {
      result.completeExceptionally(failure);
    }
  }
}
