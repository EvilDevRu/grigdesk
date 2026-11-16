package local.grigdesk.client;

import android.content.ContentValues;
import android.content.Context;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.provider.MediaStore;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.function.Supplier;
import local.grigdesk.client.shell.ShellApi;

public final class AndroidActions implements ShellApi.Native {
  private final Context context;
  private final Supplier<MainActivity> activity;
  private final BackgroundLink backgroundLink;

  public AndroidActions(Context context, Supplier<MainActivity> activity, BackgroundLink backgroundLink) {
    this.context = context;
    this.activity = activity;
    this.backgroundLink = backgroundLink;
  }

  @Override
  public String scan() throws Exception {
    if (!context.getPackageManager().hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {
      throw new IllegalStateException(ClientLocale.text("noCamera"));
    }

    return local.grigdesk.client.shell.ClientFailure.await(activity.get().scan());
  }

  @Override
  public void unlock() throws Exception {
    local.grigdesk.client.shell.ClientFailure.await(activity.get().unlock());
  }

  @Override
  public String notifyPermission() {
    return Notifications.permission(context);
  }

  /**
   * Системный запрос разрешения принадлежит видимой Activity и жесту человека.
   * Отказ возвращается состоянием, а не ошибкой трубы: интерфейс покажет причину.
   */
  @Override
  public String requestNotifyPermission() throws Exception {
    return local.grigdesk.client.shell.ClientFailure.await(activity.get().requestNotifyPermission());
  }

  @Override
  public boolean notify(String title, String body, String tag, String url) {
    return Notifications.show(context, title, body, tag, url);
  }

  @Override
  public void cancelNotification(String tag) {
    Notifications.cancel(context, tag);
  }

  /**
   * Выбор человека сохраняется до управления сервисом: отказ записи не меняет фон.
   * Включение поднимает foreground-сервис, выключение останавливает его сразу.
   */
  @Override
  public void setBackgroundLink(boolean enabled) throws Exception {
    backgroundLink.set(enabled);

    if (enabled) {
      LinkService.start(context);
    } else {
      LinkService.stop(context);
    }
  }

  /**
   * Запрос обновления виджета не ждёт воркера: труба отвечает сразу,
   * счётчики доезжают до главного экрана после фонового запроса.
   */
  @Override
  public void refreshWidget() {
    PipelineWidget.refreshNow(context);
  }

  /**
   * Файл становится виден в Загрузках только после успешной потоковой записи.
   * Ошибка удаляет незавершённую запись, а имя не может содержать путь.
   */
  @Override
  public void save(String name, String type, InputStream body) throws Exception {
    ContentValues values = new ContentValues();

    values.put(MediaStore.Downloads.DISPLAY_NAME, ShellApi.saveName(name));
    values.put(MediaStore.Downloads.MIME_TYPE, type.matches("[a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+")
      ? type : "application/octet-stream");
    values.put(MediaStore.Downloads.IS_PENDING, 1);

    Uri uri = context.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);

    if (uri == null) {
      throw new IllegalStateException(ClientLocale.text("createFileFailure"));
    }

    try {
      try (OutputStream output = context.getContentResolver().openOutputStream(uri)) {
        if (output == null) {
          throw new IllegalStateException(ClientLocale.text("openFileFailure"));
        }

        byte[] bytes = new byte[8192];
        int count;

        while ((count = body.read(bytes)) != -1) {
          output.write(bytes, 0, count);
        }
      }

      values.clear();
      values.put(MediaStore.Downloads.IS_PENDING, 0);
      context.getContentResolver().update(uri, values, null, null);
    } catch (Exception exception) {
      context.getContentResolver().delete(uri, null, null);
      throw exception;
    }
  }
}
