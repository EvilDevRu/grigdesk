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

  public AndroidActions(Context context, Supplier<MainActivity> activity) {
    this.context = context;
    this.activity = activity;
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
