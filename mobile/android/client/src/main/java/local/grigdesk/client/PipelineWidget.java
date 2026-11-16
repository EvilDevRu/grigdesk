package local.grigdesk.client;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.work.Data;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import java.util.concurrent.TimeUnit;

/**
 * WorkManager сохраняет работы, а requestId позволяет одним чтением поглотить накопленный хвост.
 * Поколение записывается до enqueue; APPEND_OR_REPLACE сохраняет сигнал во время активного worker.
 */
public final class PipelineWidget {
  public static final String REFRESH_ACTION = "local.grigdesk.mobile.WIDGET_REFRESH";
  private static final String PERIODIC_WORK = "pipeline-widget-periodic";
  private static final String ONESHOT_WORK = "pipeline-widget-refresh";

  private PipelineWidget() {
  }

  private static SharedPreferences requests(Context context) {
    return context.getSharedPreferences("pipeline-widget-requests", Context.MODE_PRIVATE);
  }

  /**
   * Поколение монотонно и переживает смерть процесса, в отличие от wall-clock времени.
   * Короткий замок записи не удерживается во время HTTP или ожидания его окончания.
   */
  public static synchronized long nextRequest(Context context) {
    SharedPreferences prefs = requests(context);
    long next = Math.addExact(prefs.getLong("requestId", 0), 1);

    if (!prefs.edit().putLong("requestId", next).commit()) {
      throw new IllegalStateException("Не удалось сохранить запрос обновления виджета.");
    }

    return next;
  }

  public static long requestVersion(Context context) {
    return requests(context).getLong("requestId", 0);
  }

  /**
   * Периодика не требует сети, чтобы записать понятный offline даже без активного network.
   * Интервал 15 минут — минимальный ориентир, Android вправе отложить выполнение.
   */
  public static void schedulePeriodic(Context context) {
    PeriodicWorkRequest request =
      new PeriodicWorkRequest.Builder(PipelineWidgetWorker.class, 15, TimeUnit.MINUTES)
        .setInputData(new Data.Builder().putBoolean("periodic", true).build())
        .build();

    WorkManager.getInstance(context)
      .enqueueUniquePeriodicWork(PERIODIC_WORK, ExistingPeriodicWorkPolicy.KEEP, request);
  }

  /**
   * Разовая работа добавляется к цепочке, а не теряется за активной работой.
   * Worker читает последнее поколение: уже покрытые хвостовые jobs не повторяют HTTP.
   */
  public static void refreshNow(Context context) {
    nextRequest(context);

    OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(PipelineWidgetWorker.class).build();

    WorkManager.getInstance(context)
      .enqueueUniqueWork(ONESHOT_WORK, ExistingWorkPolicy.APPEND_OR_REPLACE, request);
  }

  /**
   * Выбор/удаление машины меняет представление сразу, даже если новый сервер offline.
   * Перерисовка фильтрует старый кэш; сетевой результат придёт отдельной работой.
   */
  public static void selectionChanged(Context context) {
    PipelineWidgetProvider.renderAll(context);
    refreshNow(context);
  }
}
