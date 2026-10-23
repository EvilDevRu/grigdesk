package local.grigdesk.client.pipe;

import java.io.BufferedInputStream;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import javax.net.ssl.KeyManager;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLServerSocket;
import javax.net.ssl.SSLSocket;
import local.grigdesk.client.key.Pins;
import org.json.JSONObject;

/**
 * Настоящий внешний TLS v2 сохраняет непрочитанный хвост внутреннего TLS.
 * Синтетический token и сертификат используются только на случайных портах стенда.
 */
final class PhoneRelayFixture implements AutoCloseable {
  final SSLServerSocket server;
  final String pin;
  final String token = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
  final AtomicInteger hellos = new AtomicInteger();
  final List<Socket> sockets = new CopyOnWriteArrayList<>();
  final ExecutorService pool = Executors.newCachedThreadPool(task -> {
    Thread thread = new Thread(task, "phone-relay-fixture");

    thread.setDaemon(true);

    return thread;
  });
  volatile boolean closed;
  volatile boolean unsupported;
  // Отказ ретранслятора (например, brain_offline или unauthorized) и задержка его ACK.
  volatile String error;
  volatile long delay;

  /**
   * Внешний сертификат отличается от внутреннего server.p12, чтобы перестановка pin выявлялась.
   * Relay не расшифровывает внутренний HTTP и не знает ключ установки телефона.
   */
  PhoneRelayFixture(int targetPort) throws Exception {
    SSLContext context = SSLContext.getInstance("TLSv1.3");

    context.init(new KeyManager[] { TlsFixture.keys("client") }, null, null);
    pin = Pins.sha256Hex(TlsFixture.store("client").getCertificate("1").getEncoded());
    server = (SSLServerSocket) context.getServerSocketFactory().createServerSocket(
      0, 16, InetAddress.getByName("0.0.0.0"));
    server.setEnabledProtocols(new String[] { "TLSv1.3" });
    pool.submit(() -> {
      while (!closed) {
        try {
          SSLSocket outer = (SSLSocket) server.accept();

          sockets.add(outer);
          pool.submit(() -> serve(outer, targetPort));
        } catch (Exception error) {
          if (!closed) {
            throw new IllegalStateException(error);
          }
        }
      }
    });
  }

  /**
   * Ограниченная строка hello вычитывается до начала прокачки бинарного inner TLS.
   * Неверный pin клиента должен закрыть соединение ещё до увеличения счётчика hello.
   */
  private void serve(SSLSocket outer, int targetPort) {
    try (SSLSocket connection = outer) {
      connection.setSoTimeout(3000);
      connection.startHandshake();

      InputStream input = new BufferedInputStream(connection.getInputStream());
      String line = readHello(input);

      if (line == null) {
        return;
      }

      hellos.incrementAndGet();

      if (delay > 0) {
        Thread.sleep(delay);
      }

      if (error != null) {
        connection.getOutputStream().write((new JSONObject().put("ok", false).put("error", error)
          + "\n").getBytes(StandardCharsets.UTF_8));
        connection.getOutputStream().flush();

        return;
      }

      JSONObject hello = new JSONObject(line);

      if (unsupported) {
        connection.getOutputStream().write("{\"ok\":false,\"error\":\"bad_version\"}\n"
          .getBytes(StandardCharsets.US_ASCII));
        connection.getOutputStream().flush();

        return;
      }

      if (hello.getInt("v") != 2 || !hello.getString("target").equals("client")
        || !hello.getString("role").equals("device") || !hello.getString("token").equals(token)) {
        connection.getOutputStream().write("{\"ok\":false,\"error\":\"bad_hello\"}\n"
          .getBytes(StandardCharsets.US_ASCII));

        return;
      }

      try (Socket target = new Socket("127.0.0.1", targetPort)) {
        sockets.add(target);
        connection.getOutputStream().write("{\"ok\":true}\n".getBytes(StandardCharsets.US_ASCII));
        connection.getOutputStream().flush();
        connection.setSoTimeout(0);
        pool.submit(() -> copy(input, target));
        copy(target.getInputStream(), connection);
        sockets.remove(target);
      }
    } catch (Exception rejectedOrClosed) {
      // Прерывание pin-проверки и управляемое закрытие являются частью отрицательных сценариев.
    } finally {
      sockets.remove(outer);
    }
  }

  /**
   * Внешний wire заканчивается LF, в отличие от HTTP CRLF.
   * Лимит применяется до JSON и не поглощает первый байт следующего TLS-слоя.
   */
  private String readHello(InputStream input) throws Exception {
    java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();

    for (int index = 0; index <= 2048; index++) {
      int value = input.read();

      if (value == -1) {
        return null;
      }

      if (value == 10) {
        return bytes.toString(StandardCharsets.UTF_8);
      }

      bytes.write(value);
    }

    throw new IllegalArgumentException("Слишком длинный hello тестового relay");
  }

  /**
   * Копирование использует ограниченный буфер InputStream, не накапливая тело запроса.
   * Закрытие одного направления освобождает пару, включая незавершённое рукопожатие.
   */
  static void copy(InputStream input, Socket target) {
    try {
      input.transferTo(target.getOutputStream());
      target.getOutputStream().flush();
    } catch (Exception closedSocket) {
      // Отмена с другой стороны пары прекращает копирование без повтора байтов.
    } finally {
      try {
        target.close();
      } catch (Exception alreadyClosed) {
        // Повторная очистка пары безопасна.
      }
    }
  }

  JSONObject route() throws Exception {
    return new JSONObject().put("id", "r12345678").put("name", "Тестовый relay")
      .put("host", networkHost()).put("port", server.getLocalPort()).put("fp", pin)
      .put("token", token).put("protocol", 2);
  }

  /**
   * Адрес тестового интерфейса берётся у машины стенда, а не из адреса окна браузера.
   * Loopback не подставляется в новый телефонный QR даже в синтетическом сценарии.
   */
  static String networkHost() throws Exception {
    java.util.Enumeration<java.net.NetworkInterface> interfaces =
      java.net.NetworkInterface.getNetworkInterfaces();

    while (interfaces.hasMoreElements()) {
      java.util.Enumeration<InetAddress> addresses = interfaces.nextElement().getInetAddresses();

      while (addresses.hasMoreElements()) {
        InetAddress address = addresses.nextElement();

        if (address instanceof java.net.Inet4Address && !address.isLoopbackAddress()) {
          return address.getHostAddress();
        }
      }
    }

    throw new IllegalStateException("Стенду нужен сетевой IPv4-интерфейс");
  }

  /**
   * Стенд закрывает только собственные TLS/TCP и исполнителей.
   * Никакие службы relay или Android-приложения машины не используются.
   */
  @Override
  public void close() throws Exception {
    closed = true;
    server.close();

    for (Socket socket : sockets) {
      socket.close();
    }

    pool.shutdownNow();
  }
}
