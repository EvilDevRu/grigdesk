package local.grigdesk.client.pipe;

import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;

/**
 * Управляемый LAN-прокси меняет доступность без смены адреса, профиля и сертификата.
 * Внутренний pinned TLS остаётся настоящим и завершается только целевым сервером.
 */
final class PhoneDirectFixture implements AutoCloseable {
  final ServerSocket server = new ServerSocket(0, 16, InetAddress.getByName("0.0.0.0"));
  final List<Socket> sockets = new CopyOnWriteArrayList<>();
  final AtomicInteger accepted = new AtomicInteger();
  final ExecutorService pool = Executors.newCachedThreadPool(task -> {
    Thread thread = new Thread(task, "phone-direct-fixture");

    thread.setDaemon(true);

    return thread;
  });
  volatile boolean enabled = true;
  volatile boolean stall;
  volatile boolean closed;

  /**
   * Переключатель управляет только собственным случайным портом теста.
   * Режим stall принимает TCP без ответа hello для проверки дедлайна пробного direct.
   */
  PhoneDirectFixture(int targetPort) throws Exception {
    pool.submit(() -> {
      while (!closed) {
        try {
          Socket incoming = server.accept();

          accepted.incrementAndGet();
          sockets.add(incoming);
          pool.submit(() -> serve(incoming, targetPort));
        } catch (Exception error) {
          if (!closed) {
            throw new IllegalStateException(error);
          }
        }
      }
    });
  }

  /**
   * Рабочий direct прокачивает TLS, а выключенный закрывается до API.
   * Зависший peer читается до EOF, чтобы тест мог проверить освобождение пробного сокета.
   */
  private void serve(Socket incoming, int targetPort) {
    try (Socket connection = incoming) {
      if (stall) {
        while (connection.getInputStream().read() != -1) {
          // Прочитывается ClientHello без TLS-ответа; запрос должен завершиться дедлайном owner.
        }

        return;
      }

      if (!enabled) {
        return;
      }

      try (Socket target = new Socket("127.0.0.1", targetPort)) {
        sockets.add(target);
        pool.submit(() -> {
          try {
            PhoneRelayFixture.copy(connection.getInputStream(), target);
          } catch (Exception closedSocket) {
            // Закрытие контролируемого direct прекращает только эту пару.
          }
        });
        PhoneRelayFixture.copy(target.getInputStream(), connection);
        sockets.remove(target);
      }
    } catch (Exception closedSocket) {
      // Смена доступности LAN намеренно разрывает существующие соединения этой фикстуры.
    } finally {
      sockets.remove(incoming);
    }
  }

  JSONObject route() throws Exception {
    return new JSONObject().put("host", PhoneRelayFixture.networkHost()).put("port", server.getLocalPort());
  }

  /**
   * Потеря LAN закрывает существующие соединения, сохраняя слушатель для восстановления.
   * Новый probe позже увидит тот же адрес без повторной привязки.
   */
  void unavailable() throws Exception {
    enabled = false;

    for (Socket socket : sockets) {
      socket.close();
    }
  }

  /**
   * Завершение освобождает только ресурсы изолированного LAN-прокси.
   * Фоновые копировщики не переживают тест и не удерживают JVM.
   */
  @Override
  public void close() throws Exception {
    closed = true;
    server.close();
    unavailable();
    pool.shutdownNow();
  }
}
