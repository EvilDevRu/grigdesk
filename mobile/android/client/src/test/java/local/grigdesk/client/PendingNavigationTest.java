package local.grigdesk.client;

import static org.junit.Assert.*;
import org.junit.Test;

public class PendingNavigationTest {
  /**
   * Готовность runtime может наступить между уничтожением и созданием Activity.
   * Только текущая навигация применяется один раз, старый callback не затирает новую машину.
   */
  @Test
  public void navigationSurvivesGapAndIsConsumedOnce() {
    PendingNavigation pending = new PendingNavigation();
    PendingNavigation.Entry old = pending.put("http://127.0.0.1:47101", true);

    assertSame(old, pending.peek());
    PendingNavigation.Entry current = pending.put("http://127.0.0.1:47102", false);

    assertFalse(pending.take(old));
    assertSame(current, pending.peek());
    assertTrue(pending.take(current));
    assertNull(pending.peek());
    assertFalse(pending.take(current));
  }
}
