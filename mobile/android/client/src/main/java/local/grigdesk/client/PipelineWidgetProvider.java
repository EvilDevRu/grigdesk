package local.grigdesk.client;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.text.format.DateFormat;
import android.widget.RemoteViews;
import java.io.File;
import java.util.Date;
import local.grigdesk.client.shell.ProfileStore;
import org.json.JSONObject;

/**
 * Виджет конвейера показывает только счётчики: текст задач не покидает сервер.
 * Тап открывает приложение на разделе конвейера через механизм адреса оповещений,
 * блокировка интерфейса при этом продолжает действовать.
 */
public final class PipelineWidgetProvider extends AppWidgetProvider {
  @Override
  public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
    renderAll(context);
    PipelineWidget.refreshNow(context);
  }

  /**
   * Кнопка обновления приходит собственным действием, остальные события системы
   * обрабатывает базовый провайдер (включая APPWIDGET_UPDATE).
   */
  @Override
  public void onReceive(Context context, Intent intent) {
    if (PipelineWidget.REFRESH_ACTION.equals(intent.getAction())) {
      renderAll(context);
      PipelineWidget.refreshNow(context);
      return;
    }

    super.onReceive(context, intent);
  }

  /**
   * Все экземпляры виджета рисуются из одного кэша установки.
   * Отсутствие кэша показывает прочерки и состояние обновления, а не нули.
   */
  public static void renderAll(Context context) {
    PipelineWidgetPublication.run(() -> renderLocked(context));
  }

  /**
   * Чтение selected/cache, создание RemoteViews и updateAppWidget выполняются под одним замком.
   * Ни один вызывающий не строит представление до входа: старый A не публикуется после B.
   */
  private static void renderLocked(Context context) {
    AppWidgetManager manager = AppWidgetManager.getInstance(context);
    int[] ids = manager.getAppWidgetIds(new ComponentName(context, PipelineWidgetProvider.class));

    if (ids.length == 0) {
      return;
    }

    JSONObject cache = null;
    String emptyState = "widgetUpdating";

    try {
      ProfileStore profiles = new ProfileStore(
        new File(context.getFilesDir(), "client-profiles.json"), port -> true);
      String id = profiles.selected == null ? "" : profiles.selected;

      cache = new PipelineWidgetStore(new File(context.getFilesDir(), "pipeline-widget.json")).readFor(id);

      if (profiles.selected == null) {
        emptyState = "widgetStateNoMachine";
      }
    } catch (Exception exception) {
      emptyState = "widgetStateOffline";
    }
    RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.pipeline_widget);

    views.setTextViewText(R.id.widget_title, ClientLocale.text("widgetTitle"));
    views.setTextViewText(R.id.widget_running_label, ClientLocale.text("widgetRunning"));
    views.setTextViewText(R.id.widget_waiting_label, ClientLocale.text("widgetWaiting"));
    views.setTextViewText(R.id.widget_stalled_label, ClientLocale.text("widgetStalled"));
    views.setContentDescription(R.id.widget_refresh, ClientLocale.text("widgetRefresh"));

    views.setTextViewText(R.id.widget_running, PipelineWidgetStore.counterText(cache, "running"));
    views.setTextViewText(R.id.widget_waiting, PipelineWidgetStore.counterText(cache, "waiting"));
    views.setTextViewText(R.id.widget_stalled, PipelineWidgetStore.counterText(cache, "stalled"));

    views.setTextViewText(R.id.widget_state,
      cache == null ? ClientLocale.text(emptyState) : stateText(context, cache));

    views.setOnClickPendingIntent(R.id.widget_root, openApp(context));
    views.setOnClickPendingIntent(R.id.widget_refresh, refreshButton(context));
    manager.updateAppWidget(ids, views);
  }

  /**
   * Подпись состояния: время успешного запроса или причина отсутствия свежих данных.
   * Неизвестное состояние читается как offline: виджет не молчит и не врёт.
   */
  private static String stateText(Context context, JSONObject cache) {
    String state = cache.optString("state");

    if ("ok".equals(state)) {
      long fetchedAt = cache.optLong("fetchedAt");
      String time = fetchedAt > 0
        ? DateFormat.getTimeFormat(context).format(new Date(fetchedAt)) : "";

      return ClientLocale.text("widgetUpdated") + " " + time;
    }

    if ("client_upgrade_required".equals(state)) {
      return ClientLocale.text("widgetStateClientUpgrade");
    }

    if ("server_upgrade_required".equals(state)) {
      return ClientLocale.text("widgetStateServerUpgrade");
    }

    if ("no_machine".equals(state)) {
      return ClientLocale.text("widgetStateNoMachine");
    }

    if ("locked".equals(state)) {
      return ClientLocale.text("widgetStateLocked");
    }

    if ("unpaired".equals(state) || "identityMismatch".equals(state)) {
      return ClientLocale.text("widgetStateUnpaired");
    }

    return ClientLocale.text("widgetStateOffline");
  }

  /**
   * Тап открывает конвейер: адрес переживает холодный старт и блокировку установки.
   * Собственный data URI отличает intent виджета от оповещений: PendingIntent
   * сравнивает intent без extras, и общий компонент не должен перезаписывать чужой адрес.
   */
  private static PendingIntent openApp(Context context) {
    Intent intent = new Intent(context, MainActivity.class);

    intent.setAction(Intent.ACTION_MAIN);
    intent.addCategory(Intent.CATEGORY_LAUNCHER);
    intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK
      | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    intent.setData(Uri.parse("grigdesk://widget/pipeline"));
    intent.putExtra(MainActivity.NOTIFY_URL_EXTRA, "/#/pipeline");

    return PendingIntent.getActivity(context, 0, intent,
      PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }

  /**
   * Кнопка обновления шлёт собственное действие провайдеру, а не открывает приложение.
   * Тип broadcast отличает этот intent от activity-intent оповещений: коллизия невозможна.
   */
  private static PendingIntent refreshButton(Context context) {
    Intent intent = new Intent(context, PipelineWidgetProvider.class);

    intent.setAction(PipelineWidget.REFRESH_ACTION);

    return PendingIntent.getBroadcast(context, 1, intent,
      PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }
}
