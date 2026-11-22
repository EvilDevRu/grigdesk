package local.grigdesk.client;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * Foreground-сервис удерживает процесс и CPU живыми, пока включена фоновая связь.
 * Данные продолжает доставлять живая труба и WebView; сервис лишь не даёт системе
 * усыпить процесс и показывает постоянное уведомление о работе в фоне.
 */
public final class LinkService extends Service {
  public static final String CHANNEL_ID = "grigdesk-link";
  private static final int NOTIFY_ID = 2;
  private PowerManager.WakeLock wakeLock;

  /**
   * Запуск допускается из видимой Activity: тумблер настройки или старт приложения.
   * Повторный запуск живого сервиса не создаёт второе уведомление и wake lock.
   */
  public static void start(Context context) {
    context.startForegroundService(new Intent(context, LinkService.class));
  }

  public static void stop(Context context) {
    context.stopService(new Intent(context, LinkService.class));
  }

  /**
   * Канал важности LOW показывает постоянное уведомление без звука и всплывашки.
   * Тап возвращает приложение тем же намерением, что и системные оповещения.
   */
  private void ensureChannel() {
    NotificationManager manager = getSystemService(NotificationManager.class);

    if (manager.getNotificationChannel(CHANNEL_ID) != null) {
      return;
    }

    NotificationChannel channel = new NotificationChannel(CHANNEL_ID,
      ClientLocale.text("linkChannelName"), NotificationManager.IMPORTANCE_LOW);

    channel.setDescription(ClientLocale.text("linkChannelDescription"));
    manager.createNotificationChannel(channel);
  }

  private Notification buildNotification() {
    Intent intent = MainActivity.launchIntent(this);

    intent.setAction(Intent.ACTION_MAIN);
    intent.addCategory(Intent.CATEGORY_LAUNCHER);
    intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

    PendingIntent pending = PendingIntent.getActivity(this, 0, intent,
      PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

    return new Notification.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_notification)
      .setContentTitle(ClientLocale.text("linkServiceTitle"))
      .setContentText(ClientLocale.text("linkServiceText"))
      .setOngoing(true)
      .setCategory(Notification.CATEGORY_SERVICE)
      .setContentIntent(pending)
      .build();
  }

  /**
   * Частичный wake lock держит CPU для таймеров WebView и сети при погашенном экране.
   * Освобождение принадлежит onDestroy, повторный acquire не накапливает счётчик.
   */
  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    ensureChannel();
    startForeground(NOTIFY_ID, buildNotification());

    if (wakeLock == null) {
      PowerManager power = getSystemService(PowerManager.class);

      wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "grigdesk:link");
      wakeLock.acquire();
    }

    return START_STICKY;
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  @Override
  public void onDestroy() {
    if (wakeLock != null && wakeLock.isHeld()) {
      wakeLock.release();
    }

    wakeLock = null;
    stopForeground(STOP_FOREGROUND_REMOVE);
    super.onDestroy();
  }
}
