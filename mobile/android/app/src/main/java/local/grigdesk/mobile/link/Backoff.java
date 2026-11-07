package local.grigdesk.mobile.link;

import java.util.Random;

public final class Backoff {

  private final Random random;
  private int attempt;

  public Backoff(Random random) {
    this.random = random;
  }

  public long next() {
    long delay = Math.min(30000L, 1000L << Math.min(attempt++, 5));

    return Math.round(delay * (0.8 + random.nextDouble() * 0.4));
  }

  public void reset() {
    attempt = 0;
  }
}
