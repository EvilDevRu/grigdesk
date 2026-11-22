package local.grigdesk.client;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

/**
 * Системные оповещения принадлежат установке, а не документу WebView.
 * WebView не реализует Notification API, поэтому труба вызывает этот канал напрямую.
 * Разрешение Android 13+ и общий тумблер уведомлений читаются одним предикатом.
 */
public final class Notifications {
  public static final String CHANNEL_ID = "grigdesk-alerts";
  private static final String PREFERENCES = "client-notifications";
  private static final java.util.concurrent.atomic.AtomicInteger UNIQUE_IDS =
    new java.util.concurrent.atomic.AtomicInteger(1);

  private Notifications() {
  }

  /**
   * Канал создаётся один раз на установку и переживает обновление приложения.
   * Важность DEFAULT даёт звук и всплывашку без полноэкранного намерения.
   */
  public static void ensureChannel(Context context) {
    NotificationManager manager = context.getSystemService(NotificationManager.class);

    if (manager.getNotificationChannel(CHANNEL_ID) != null) {
      return;
    }

    NotificationChannel channel = new NotificationChannel(CHANNEL_ID,
      ClientLocale.text("notifyChannelName"), NotificationManager.IMPORTANCE_DEFAULT);

    channel.setDescription(ClientLocale.text("notifyChannelDescription"));
    manager.createNotificationChannel(channel);
  }

  /**
   * Состояние повторяет контракт браузера: granted, denied и default до первого запроса.
   * Выключенный тумблер установки считается отказом независимо от версии Android.
   */
  public static String permission(Context context) {
    NotificationManager manager = context.getSystemService(NotificationManager.class);

    if (Build.VERSION.SDK_INT >= 33
      && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
        != PackageManager.PERMISSION_GRANTED) {
      return asked(context) ? "denied" : "default";
    }

    return manager.areNotificationsEnabled() ? "granted" : "denied";
  }

  /**
   * Факт запроса хранится отдельно от системного разрешения: повторный отказ человека
   * должен выглядеть как denied, а не как ещё не заданный вопрос.
   */
  public static void markAsked(Context context) {
    context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
      .edit().putBoolean("asked", true).apply();
  }

  private static boolean asked(Context context) {
    return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
      .getBoolean("asked", false);
  }

  /**
   * Показ возможен только при действующем разрешении; отказ возвращает false без исключения.
   * Одинаковый tag замещает прежнее оповещение, пустой tag получает собственный номер.
   */
  public static boolean show(Context context, String title, String body, String tag, String url) {
    if (!"granted".equals(permission(context))) {
      return false;
    }

    ensureChannel(context);

    Notification.Builder builder = new Notification.Builder(context, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_notification)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(new Notification.BigTextStyle().bigText(body))
      .setAutoCancel(true)
      .setCategory(Notification.CATEGORY_MESSAGE)
      .setContentIntent(openApp(context, tag, url));
    NotificationManager manager = context.getSystemService(NotificationManager.class);

    if (tag.isEmpty()) {
      manager.notify(UNIQUE_IDS.getAndIncrement(), builder.build());
    } else {
      manager.notify(tag, tag.hashCode(), builder.build());
    }

    return true;
  }

  /**
   * Закрытие по tag гасит то же оповещение, что показал общий центр тостов.
   * Отсутствие живого оповещения не считается ошибкой канала.
   */
  public static void cancel(Context context, String tag) {
    if (tag.isEmpty()) {
      return;
    }

    context.getSystemService(NotificationManager.class).cancel(tag, tag.hashCode());
  }

  /**
   * Тап возвращает существующую задачу приложения, а не создаёт вторую копию.
   * Адрес цели передаётся отдельно и применяется только после загрузки документа.
   */
  private static PendingIntent openApp(Context context, String tag, String url) {
    Intent intent = MainActivity.launchIntent(context);

    intent.setAction(Intent.ACTION_MAIN);
    intent.addCategory(Intent.CATEGORY_LAUNCHER);
    intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

    if (!url.isEmpty()) {
      intent.putExtra(MainActivity.NOTIFY_URL_EXTRA, url);
    }

    int requestCode = tag.isEmpty() ? UNIQUE_IDS.getAndIncrement() : tag.hashCode();

    return PendingIntent.getActivity(context, requestCode, intent,
      PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }
}
