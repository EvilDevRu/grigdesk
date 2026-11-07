package local.grigdesk.mobile.link;

import java.io.File;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.Comparator;

public final class MediaCache {

  private MediaCache() {
  }

  /**
   * LRU учитывает соседний ETag и удаляет сначала самые старые изображения.
   * Metadata без своего изображения не остаётся доказательством успешного 304.
   */
  public static void evict(File directory, long limitBytes) throws Exception {
    File[] files = directory.listFiles((parent, name) -> name.matches("[a-f0-9]{64}"));

    if (files == null) {
      return;
    }

    Arrays.sort(files, Comparator.comparingLong(File::lastModified));

    long total = 0;

    for (File file : files) {
      total += file.length() + new File(file.getPath() + ".etag").length();
    }
    for (File file : files) {
      if (total <= limitBytes) {
        break;
      }

      File etag = new File(file.getPath() + ".etag");

      total -= file.length() + etag.length();
      Files.deleteIfExists(file.toPath());
      Files.deleteIfExists(etag.toPath());
    }
  }

  /**
   * Очистка ограничена собственным cacheDir, не следует symlink и не касается установщика APK.
   * После lock локальные изображения нельзя прочитать через старый WebView URL.
   */
  public static void clear(File directory) {
    File[] files = directory.listFiles();

    if (files != null) {
      for (File file : files) {
        file.delete();
      }
    }

    directory.delete();
  }
}
