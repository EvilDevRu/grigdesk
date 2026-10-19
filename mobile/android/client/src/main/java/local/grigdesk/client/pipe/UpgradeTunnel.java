package local.grigdesk.client.pipe;

import java.io.IOException;
import java.io.InputStream;
import java.net.Socket;
import java.util.concurrent.ExecutorService;

public final class UpgradeTunnel {
  private UpgradeTunnel() {
  }

  /**
   * Обе стороны передаются байт в байт, без понимания WebSocket и перекодировки текста.
   * Закрытие одного направления закрывает пару и освобождает оба работника пула.
   */
  public static void run(Socket front, InputStream frontInput, Socket back, InputStream backInput,
    ExecutorService pool) {
    pool.execute(() -> pump(frontInput, back, front));
    pump(backInput, front, back);
  }

  /**
   * Каждое направление передаёт байты независимо, сохраняя бинарные кадры.
   * Завершение или ошибка одного направления закрывает обе стороны туннеля.
   */
  private static void pump(InputStream input, Socket destination, Socket other) {
    try {
      byte[] bytes = new byte[8192];
      int count;

      while ((count = input.read(bytes)) != -1) {
        destination.getOutputStream().write(bytes, 0, count);
        destination.getOutputStream().flush();
      }
    } catch (IOException ignored) {
      // Обрыв одного направления завершает весь туннель.
    } finally {
      try {
        destination.close();
        other.close();
      } catch (IOException ignored) {
        // Закрытый сокет уже не удерживает поток.
      }
    }
  }
}
