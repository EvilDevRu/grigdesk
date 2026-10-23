package local.grigdesk.client.pipe;

import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;
import org.json.JSONObject;

/**
 * Loopback forwarder переносит только зашифрованный внутренний TLS к выбранному relay.
 * HTTP, файлы, SSE и upgrade продолжают использовать прежний codec Upstream.
 */
public final class RelayForwarder implements AutoCloseable {
  // Шесть HTTP WebView, SSE, WS и пять idle OkHttp укладываются с запасом.
  // Лимит ниже серверных 24 соединений на сертификат и 32 пар одной ссылки.
  private static final int MAX_CONNECTIONS = 16;
  private final ServerSocket server;
  private final RelayDialer dialer;
  private final Set<Socket> locals = ConcurrentHashMap.newKeySet();
  private final ExecutorService pool = Executors.newFixedThreadPool(1 + 2 * MAX_CONNECTIONS, task -> {
    Thread thread = new Thread(task, "client-relay");

    thread.setDaemon(true);

    return thread;
  });
  private volatile boolean closed;

  /**
   * Один loopback listener принадлежит конкретному child выбранного профиля.
   * Учёт начинается до dial; лимит исключает неограниченный рост принятых пар.
   */
  public RelayForwarder(JSONObject relay, Consumer<Exception> failure) throws Exception {
    dialer = new RelayDialer(relay);
    server = new ServerSocket(0, MAX_CONNECTIONS, InetAddress.getByName("127.0.0.1"));
    pool.execute(() -> {
      while (!closed) {
        try {
          Socket local = server.accept();

          if (locals.size() >= MAX_CONNECTIONS || closed) {
            local.close();
            continue;
          }

          locals.add(local);
          pool.execute(() -> serve(local, failure));
        } catch (IOException stopped) {
          if (!closed) {
            failure.accept(stopped);
          }
        }
      }
    });
  }

  public String address() {
    return "https://127.0.0.1:" + server.getLocalPort();
  }

  /**
   * Оба направления используют ограниченный буфер и освобождают собственную пару.
   * Ошибка наружного TLS передаётся owner до EOF внутреннего, сохраняя причину отказа.
   */
  private void serve(Socket local, Consumer<Exception> failure) {
    Socket outer = null;

    try {
      outer = dialer.connect();
      Socket remote = outer;

      pool.execute(() -> copy(local, remote));
      copy(remote, local);
    } catch (Exception rejected) {
      if (!closed) {
        failure.accept(rejected);
      }
    } finally {
      locals.remove(local);
      closeSocket(local);

      if (outer != null) {
        dialer.release(outer);
        closeSocket(outer);
      }
    }
  }

  private static void closeSocket(Socket socket) {
    try {
      socket.close();
    } catch (IOException ignored) {
      // Повторное закрытие не препятствует очистке остальных соединений.
    }
  }

  /**
   * Поток передаётся частями без копии всего тела файла в памяти.
   * Закрытие любого направления освобождает обе стороны без replay.
   */
  private static void copy(Socket source, Socket target) {
    try {
      InputStream input = source.getInputStream();
      byte[] bytes = new byte[8192];
      int count;

      while ((count = input.read(bytes)) >= 0) {
        target.getOutputStream().write(bytes, 0, count);
        target.getOutputStream().flush();
      }
    } catch (IOException closedPair) {
      // Обрыв завершает пару; байты никогда не отправляются повторно.
    } finally {
      closeSocket(source);
      closeSocket(target);
    }
  }

  /**
   * Отмена охватывает listener, незавершённый outer dial и открытые пары.
   * Владелец вызывает её также при терминальном отказе всего профиля.
   */
  @Override
  public void close() {
    closed = true;
    closeServer();
    dialer.close();

    for (Socket socket : locals) {
      closeSocket(socket);
    }

    pool.shutdownNow();
  }

  private void closeServer() {
    try {
      server.close();
    } catch (IOException ignored) {
      // Закрытие уже остановленного listener безопасно.
    }
  }
}
