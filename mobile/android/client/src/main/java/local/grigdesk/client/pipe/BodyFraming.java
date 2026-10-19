package local.grigdesk.client.pipe;

import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

public final class BodyFraming {
  private BodyFraming() {
  }

  public abstract static class Frame extends InputStream {
    public abstract boolean complete();

    @Override
    public int read() throws IOException {
      byte[] data = new byte[1];
      int count = read(data, 0, 1);

      return count < 0 ? -1 : data[0] & 255;
    }
  }

  /**
   * Framing определяется до передачи тела; CL+TE и неизвестные кодировки запрещены.
   * Обёртка не закрывает вход сокета, чтобы следующий keep-alive запрос оставался доступным.
   */
  public static Frame input(HttpHead head, InputStream input) throws IOException {
    String encoding = head.headers.get("transfer-encoding");
    String length = head.headers.get("content-length");

    if (encoding != null) {
      if (length != null || !encoding.equalsIgnoreCase("chunked")) {
        throw new IOException("Неоднозначное тело HTTP");
      }

      return new Chunks(input);
    }

    if (length != null && !length.matches("0|[1-9][0-9]*")) {
      throw new IOException("Неверная длина тела");
    }

    try {
      return new Fixed(input, length == null ? 0 : Long.parseLong(length));
    } catch (NumberFormatException exception) {
      throw new IOException("Слишком большая длина тела", exception);
    }
  }

  private static final class Fixed extends Frame {
    private final InputStream input;
    private long remaining;

    Fixed(InputStream input, long remaining) {
      this.input = input;
      this.remaining = remaining;
    }

    @Override
    public int read(byte[] data, int offset, int length) throws IOException {
      if (length == 0) {
        return 0;
      }

      if (remaining == 0) {
        return -1;
      }

      int count = input.read(data, offset, (int) Math.min(length, remaining));

      if (count < 0) {
        throw new EOFException("Неполное тело HTTP");
      }

      remaining -= count;

      return count;
    }

    @Override
    public boolean complete() {
      return remaining == 0;
    }
  }

  private static final class Chunks extends Frame {
    private final InputStream input;
    private boolean first = true;
    private boolean done;
    private long remaining;

    Chunks(InputStream input) {
      this.input = input;
    }

    /**
     * Граница каждого chunk читается отдельно и не поглощает следующий HTTP-запрос.
     * Хвост и размер также ограничены, чтобы не обойти лимит заголовка через trailers.
     */
    @Override
    public int read(byte[] data, int offset, int length) throws IOException {
      if (length == 0) {
        return 0;
      }

      if (done) {
        return -1;
      }

      if (remaining == 0) {
        if (!first && !"".equals(HttpHead.line(input, 2))) {
          throw new IOException("Неверный конец chunk");
        }

        first = false;

        String line = HttpHead.line(input, 8192);
        String size = line == null ? "" : line.split(";", 2)[0];

        if (!size.matches("[0-9a-fA-F]{1,15}")) {
          throw new IOException("Неверный размер chunk");
        }

        remaining = Long.parseLong(size, 16);

        if (remaining == 0) {
          int total = 0;

          while (true) {
            String trailer = HttpHead.line(input, 65536 - total);

            if (trailer == null) {
              throw new EOFException("Неполный trailer");
            }

            total += trailer.length() + 2;

            if (trailer.isEmpty()) {
              break;
            }
          }

          done = true;

          return -1;
        }
      }

      int count = input.read(data, offset, (int) Math.min(length, remaining));

      if (count < 0) {
        throw new EOFException("Неполный chunk");
      }

      remaining -= count;

      return count;
    }

    @Override
    public boolean complete() {
      return done;
    }
  }

  /**
   * Ответ неизвестной длины кодируется chunks и flush после каждой части сохраняет SSE.
   * Тела известной длины проверяются на обрыв без накопления файла в памяти.
   */
  public static void output(InputStream input, OutputStream output, long length) throws IOException {
    byte[] buffer = new byte[8192];
    long written = 0;
    int count;

    while ((count = input.read(buffer)) != -1) {
      if (length < 0) {
        output.write((Integer.toHexString(count) + "\r\n").getBytes(StandardCharsets.US_ASCII));
      }

      output.write(buffer, 0, count);
      written += count;

      if (length < 0) {
        output.write("\r\n".getBytes(StandardCharsets.US_ASCII));
      }

      output.flush();
    }

    if (length >= 0 && written != length) {
      throw new EOFException("Неполное тело ответа");
    }

    if (length < 0) {
      output.write("0\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
    }

    output.flush();
  }
}
