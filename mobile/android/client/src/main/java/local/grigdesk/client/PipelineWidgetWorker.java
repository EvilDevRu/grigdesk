package local.grigdesk.client;

import android.content.ComponentName;
import android.content.Context;
import android.appwidget.AppWidgetManager;
import android.net.ConnectivityManager;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.File;
import java.io.IOException;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import local.grigdesk.client.key.DeviceKey;
import local.grigdesk.client.key.DeviceKeyManager;
import local.grigdesk.client.key.MissingDeviceKeyException;
import local.grigdesk.client.pipe.RoutedUpstream;
import local.grigdesk.client.pipe.StaticAssets;
import local.grigdesk.client.pipe.VersionGate;
import org.json.JSONObject;

/**
 * Worker владеет отдельным mTLS-транспортом, таймером и сигналом остановки.
 * Виджет не создаёт собственную SSE-сессию и не меняет транспорт WebView.
 */
public final class PipelineWidgetWorker extends Worker {
  private volatile PipelineWidgetRefresher refresher;

  public PipelineWidgetWorker(@NonNull Context context, @NonNull WorkerParameters params) {
    super(context, params);
  }

  /**
   * Остановка явно закрывает активный транспорт и запрещает позднюю публикацию.
   * Сигнал до назначения refresher повторно проверяется перед run().
   */
  @Override
  public void onStopped() {
    PipelineWidgetRefresher current = refresher;

    if (current != null) {
      current.cancel();
    }
  }

  /**
   * Нет размещённых виджетов — нет HTTP; периодика остаётся зарегистрированной.
   * Отказы сети сохраняются самим обновителем, ошибки инфраструктуры журналируются.
   */
  @NonNull
  @Override
  public Result doWork() {
    Context context = getApplicationContext();
    int[] ids = AppWidgetManager.getInstance(context)
      .getAppWidgetIds(new ComponentName(context, PipelineWidgetProvider.class));

    if (ids.length == 0 || isStopped()) {
      return Result.success();
    }

    ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor();

    try {
      if (getInputData().getBoolean("periodic", false)) {
        PipelineWidget.nextRequest(context);
      }

      JSONObject api = new JSONObject(StaticAssets.readText(
        context.getAssets().open("ui/api-version.json"), 1024));
      VersionGate version = new VersionGate(api.getInt("major"), api.getInt("minor"));
      DeviceKey legacyKey = new DeviceKey();
      DeviceKey modernKey = new DeviceKey(DeviceKey.ALIAS_V2);
      PipelineWidgetRefresher.TransportFactory factory = profile -> {
        ConnectivityManager connectivity = context.getSystemService(ConnectivityManager.class);

        if (connectivity == null || connectivity.getActiveNetwork() == null) {
          throw new IOException("Сеть недоступна.");
        }

        int clientKey = profile.optInt("clientKey", 1);
        DeviceKey key = clientKey >= 2 ? modernKey : legacyKey;

        if (!key.exists()) {
          throw new MissingDeviceKeyException();
        }

        return new RoutedUpstream(profile, new DeviceKeyManager(key), version, (status, code) -> {});
      };

      refresher = new PipelineWidgetRefresher(
        new File(context.getFilesDir(), "client-profiles.json"),
        new PipelineWidgetStore(new File(context.getFilesDir(), "pipeline-widget.json")),
        factory, System::currentTimeMillis, () -> PipelineWidget.requestVersion(context), Thread::sleep,
        expired -> {
          var future = timer.schedule(expired, 90, TimeUnit.SECONDS);

          return () -> future.cancel(false);
        });

      if (isStopped()) {
        refresher.cancel();
      }

      refresher.run();

      if (!isStopped()) {
        PipelineWidgetProvider.renderAll(context);
      }
    } catch (InterruptedException exception) {
      Thread.currentThread().interrupt();
    } catch (Exception exception) {
      android.util.Log.e("GrigDesk", "Не удалось обновить виджет конвейера", exception);
    } finally {
      timer.shutdownNow();
    }

    return Result.success();
  }
}
