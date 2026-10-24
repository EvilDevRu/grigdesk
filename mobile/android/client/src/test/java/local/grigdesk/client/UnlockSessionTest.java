package local.grigdesk.client;

import static org.junit.Assert.*;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;

public class UnlockSessionTest {
  /**
   * Повтор с новой Activity ждёт тот же результат и не открывает второй системный диалог.
   * Новый callback завершает старое ожидание, не удерживая первоначальный launcher.
   */
  @Test
  public void recreatedActivityCompletesOriginalRequestAndRepeatedTapJoinsIt() {
    List<Boolean> flows = new ArrayList<>();
    AtomicInteger authenticated = new AtomicInteger();
    AtomicInteger prompts = new AtomicInteger();
    UnlockSession session = new UnlockSession(authenticated::incrementAndGet, flows::add);
    CompletableFuture<Void> original = session.request(prompts::incrementAndGet);
    CompletableFuture<Void> repeated = session.request(prompts::incrementAndGet);

    assertSame(original, repeated);
    assertFalse(original.isDone());
    assertEquals(1, prompts.get());

    session.succeeded();

    assertNull(original.join());
    assertNull(repeated.join());
    assertEquals(1, authenticated.get());
    assertEquals(List.of(true, false), flows);
  }

  /**
   * Ошибка authenticate прежде оставляла вечный pending и сообщение «уже открыта».
   * Теперь отказ возвращается ожидающему, а следующая попытка запускает новый prompt.
   */
  @Test
  public void launchFailureReleasesRequestAndAllowsRetry() {
    List<Boolean> flows = new ArrayList<>();
    AtomicInteger authenticated = new AtomicInteger();
    UnlockSession session = new UnlockSession(authenticated::incrementAndGet, flows::add);
    IllegalStateException failure = new IllegalStateException("Не удалось открыть системный диалог");
    CompletableFuture<Void> first = session.request(() -> {
      throw failure;
    });

    assertTrue(first.isCompletedExceptionally());
    assertSame(failure, assertThrows(java.util.concurrent.CompletionException.class, first::join).getCause());
    assertEquals(0, authenticated.get());

    CompletableFuture<Void> retry = session.request(() -> {
    });

    assertNotSame(first, retry);
    assertFalse(retry.isDone());
    session.succeeded();
    assertNull(retry.join());
    assertEquals(1, authenticated.get());
    assertEquals(List.of(true, false, true, false), flows);
  }

  /**
   * Отмена или окончательное закрытие Activity не оставляют запрос в приложении.
   * Повторные терминальные callbacks не продлевают срок доступа и не уменьшают чужой flow.
   */
  @Test
  public void cancellationIsTerminalAndDuplicateCallbacksDoNotAuthenticate() {
    List<Boolean> flows = new ArrayList<>();
    AtomicInteger authenticated = new AtomicInteger();
    UnlockSession session = new UnlockSession(authenticated::incrementAndGet, flows::add);
    CompletableFuture<Void> cancelled = session.request(() -> {
    });

    session.failed(new IllegalStateException("Отмена"));
    session.failed(new IllegalStateException("Повторная отмена"));
    session.succeeded();

    assertTrue(cancelled.isCompletedExceptionally());
    assertEquals(0, authenticated.get());
    assertEquals(List.of(true, false), flows);

    CompletableFuture<Void> retry = session.request(() -> {
    });

    session.succeeded();
    session.succeeded();
    assertNull(retry.join());
    assertEquals(1, authenticated.get());
    assertEquals(List.of(true, false, true, false), flows);
  }

  /**
   * Публикация результата может синхронно инициировать следующую попытку.
   * Старое завершение не должно затереть новый запрос или оставить счётчик открытым.
   */
  @Test
  public void completionCanStartAnotherRequestWithoutLosingIt() {
    List<Boolean> flows = new ArrayList<>();
    UnlockSession session = new UnlockSession(() -> {
    }, flows::add);
    CompletableFuture<Void> first = session.request(() -> {
    });
    CompletableFuture<CompletableFuture<Void>> next = first.thenApply(value -> session.request(() -> {
    }));

    session.succeeded();

    CompletableFuture<Void> second = next.join();

    assertFalse(second.isDone());
    session.succeeded();
    assertNull(second.join());
    assertEquals(List.of(true, false, true, false), flows);
  }
}
