package local.grigdesk.client;

public final class PendingNavigation {
  public static final class Entry {
    public final String origin;
    public final boolean reset;

    Entry(String origin, boolean reset) {
      this.origin = origin;
      this.reset = reset;
    }
  }

  private Entry pending;

  /**
   * Runtime публикует переход даже в промежутке между двумя Activity.
   * Новая публикация отменяет прежний ещё не применённый переход.
   */
  public synchronized Entry put(String origin, boolean reset) {
    pending = new Entry(origin, reset);

    return pending;
  }

  public synchronized Entry peek() {
    return pending;
  }

  /**
   * Только действующий callback получает право применить URL один раз.
   * Поворот после успешной загрузки не должен перегружать сохранённый WebView.
   */
  public synchronized boolean take(Entry entry) {
    if (pending != entry) {
      return false;
    }

    pending = null;

    return true;
  }
}
