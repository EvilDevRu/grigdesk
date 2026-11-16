package local.grigdesk.client;

/**
 * Короткий общий замок относится к публикации, отдельно от долгого сетевого запроса.
 * Все источники виджета читают выбранную машину и публикуют результат в одном порядке.
 */
public final class PipelineWidgetPublication {
  private PipelineWidgetPublication() {
  }

  /**
   * Операция включает чтение источника и публикацию: заранее готовый снимок не передаётся.
   * Следующий вызывающий увидит актуальный выбор после завершения прежнего рендера.
   */
  public static synchronized void run(Runnable operation) {
    operation.run();
  }
}
