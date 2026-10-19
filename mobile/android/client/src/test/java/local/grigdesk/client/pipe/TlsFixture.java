package local.grigdesk.client.pipe;

import java.io.BufferedInputStream;
import java.io.InputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.net.ssl.KeyManager;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLServerSocket;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509KeyManager;
import javax.net.ssl.X509TrustManager;
import local.grigdesk.client.key.Pins;

/**
 * Сервер и клиент используют только публичные синтетические PKCS12 этой фикстуры.
 * Сокеты привязаны к случайным loopback-портам; закрытие освобождает все потоки.
 */
final class TlsFixture implements AutoCloseable {
  interface Handler {
    void handle(HttpHead request, InputStream body, java.io.OutputStream output) throws Exception;
  }

  final SSLServerSocket server;
  final List<HttpHead> requests = new CopyOnWriteArrayList<>();
  final List<Socket> sockets = new CopyOnWriteArrayList<>();
  final ExecutorService pool = Executors.newCachedThreadPool(task -> {
    Thread thread = new Thread(task, "fixture-tls");

    thread.setDaemon(true);

    return thread;
  });
  final String pin;
  volatile boolean closed;

  /**
   * Синтетический сервер запрашивает клиентский сертификат на случайном порту.
   * Принятые сокеты учитываются для завершения даже отклонённого handshake.
   */
  TlsFixture(Handler handler) throws Exception {
    this(handler, false);
  }

  TlsFixture(Handler handler, boolean keepAlive) throws Exception {
    SSLContext context = SSLContext.getInstance("TLSv1.3");

    context.init(new KeyManager[] { keys("server") }, new TrustManager[] { new X509TrustManager() {
      public void checkClientTrusted(X509Certificate[] chain, String kind) {
      }
      public void checkServerTrusted(X509Certificate[] chain, String kind) {
      }
      public X509Certificate[] getAcceptedIssuers() {
        return new X509Certificate[0];
      }
    } }, null);
    pin = Pins.sha256Hex(store("server").getCertificate("1").getEncoded());
    server = (SSLServerSocket) context.getServerSocketFactory().createServerSocket(
      0, 16, java.net.InetAddress.getByName("127.0.0.1")
    );
    server.setEnabledProtocols(new String[] { "TLSv1.3" });
    server.setNeedClientAuth(true);
    pool.submit(() -> {
      while (!closed) {
        try {
          SSLSocket socket = (SSLSocket) server.accept();

          sockets.add(socket);
          pool.submit(() -> {
            try (SSLSocket client = socket) {
              client.startHandshake();

              InputStream input = new BufferedInputStream(client.getInputStream());
              while (!closed) {
                HttpHead head = HttpHead.read(input);

                if (head == null) {
                  break;
                }

                requests.add(head);
                handler.handle(head, head.headers.containsKey("upgrade") ? input
                  : BodyFraming.input(head, input), client.getOutputStream());

                if (!keepAlive || head.headers.containsKey("upgrade")) {
                  break;
                }
              }
            } catch (Exception expectedForRejectedHandshake) {
              // Чужой pin прерывает handshake до первого HTTP-байта.
            } finally {
              sockets.remove(socket);
            }
          });
        } catch (Exception exception) {
          if (!closed) {
            throw new IllegalStateException(exception);
          }
        }
      }
    });
  }

  static KeyStore store(String name) throws Exception {
    KeyStore store = KeyStore.getInstance("PKCS12");

    try (InputStream input = TlsFixture.class.getResourceAsStream("/" + name + ".p12")) {
      store.load(input, "fixture-only".toCharArray());
    }

    return store;
  }

  /**
   * Ключ выбирается из публичного тестового PKCS12 без системного Keystore.
   * Отсутствие X509 key manager явно завершает подготовку стенда.
   */
  static X509KeyManager keys(String name) throws Exception {
    KeyManagerFactory factory = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());

    factory.init(store(name), "fixture-only".toCharArray());

    for (KeyManager manager : factory.getKeyManagers()) {
      if (manager instanceof X509KeyManager) {
        return (X509KeyManager) manager;
      }
    }

    throw new IllegalStateException("Нет ключей фикстуры");
  }

  String address() {
    return "https://127.0.0.1:" + server.getLocalPort();
  }

  static void response(java.io.OutputStream output, int status, String version, byte[] body)
    throws Exception {
    output.write(("HTTP/1.1 " + status + " Fixture\r\nX-GrigDesk-Api: " + version
      + "\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n")
      .getBytes(StandardCharsets.US_ASCII));
    output.write(body);
    output.flush();
  }

  /**
   * Закрывается только слушатель и сокеты, созданные этим TLS-стендом.
   * Завершение пула не оставляет обработчики между JVM-сценариями.
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
