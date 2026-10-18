package local.grigdesk.mobile.link;

import android.graphics.BitmapFactory;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

public final class RasterValidation {

  private RasterValidation() {
  }

  /**
   * MIME и signature проверяются до bitmap bounds, SVG не допускается в локальный WebView cache.
   * Bounds декодируются без выделения bitmap, а площадь ограничивается 24 мегапикселями.
   */
  public static void validate(File file, String mime) throws IOException {
    byte[] header = new byte[16];
    int count;

    try (FileInputStream stream = new FileInputStream(file)) {
      count = stream.read(header);
    }

    String type = mime.split(";", 2)[0];
    boolean valid =
      count >= 8 &&
      "image/png".equals(type) &&
      header[0] == (byte) 0x89 &&
      header[1] == 'P' &&
      header[2] == 'N' &&
      header[3] == 'G' &&
      header[4] == 13 &&
      header[5] == 10 &&
      header[6] == 26 &&
      header[7] == 10;

    valid |=
      count >= 3 &&
      "image/jpeg".equals(type) &&
      header[0] == (byte) 255 &&
      header[1] == (byte) 216 &&
      header[2] == (byte) 255;
    valid |=
      count >= 6 &&
      "image/gif".equals(type) &&
      new String(header, 0, 6, StandardCharsets.US_ASCII).matches("GIF8[79]a");
    valid |=
      count >= 12 &&
      "image/webp".equals(type) &&
      new String(header, 0, 4, StandardCharsets.US_ASCII).equals("RIFF") &&
      new String(header, 8, 4, StandardCharsets.US_ASCII).equals("WEBP");

    if (!valid || file.length() > 10000000L) {
      throw new IOException("media_type");
    }

    BitmapFactory.Options options = new BitmapFactory.Options();

    options.inJustDecodeBounds = true;
    BitmapFactory.decodeFile(file.getPath(), options);

    if (
      options.outWidth < 1 ||
      options.outHeight < 1 ||
      (long) options.outWidth * options.outHeight > 24000000L
    ) {
      throw new IOException("media_type");
    }
  }
}
