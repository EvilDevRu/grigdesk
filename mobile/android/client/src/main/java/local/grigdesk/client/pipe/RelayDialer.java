package local.grigdesk.client.pipe;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import local.grigdesk.client.key.PinnedTrustManager;
import org.json.JSONObject;

/**
 * Внешний TLS проверяет pin ретранслятора прежде передачи общего device token.
 * Незавершённые dial принадлежат поколению и закрываются при suspend или отзыве.
 */
public final class RelayDialer implements AutoCloseable {
  private final JSONObject relay;
  private final Set<Socket> sockets = ConcurrentHashMap.newKeySet();
  private volatile boolean closed;

  public RelayDialer(JSONObject relay) {
    this.relay = relay;
  }

  /**
   * ACK вычитывается побайтно с жёстким пределом, оставляя inner TLS нетронутым.
   * Отказ версии выключает только путь relay и никогда не переводит client на mobile-v1.
   */
  public SSLSocket connect() throws Exception {
    SSLContext context = SSLContext.getInstance("TLSv1.3");

    context.init(null, new TrustManager[] { new PinnedTrustManager(relay.getString("fp")) }, null);

    SSLSocket socket = (SSLSocket) context.getSocketFactory().createSocket();

    sockets.add(socket);

    try {
      if (closed) {
        throw new IOException("offline");
      }

      socket.setEnabledProtocols(new String[] { "TLSv1.3" });
      socket.connect(new InetSocketAddress(relay.getString("host"), relay.getInt("port")), 3000);
      socket.setSoTimeout(5000);
      socket.startHandshake();
      socket.getOutputStream().write((new JSONObject().put("v", 2).put("target", "client")
        .put("role", "device").put("token", relay.getString("token")).toString() + "\n")
        .getBytes(StandardCharsets.UTF_8));
      socket.getOutputStream().flush();

      // Сервер дозванивается после device hello; настройка relay допускает до 60 секунд.
      // ACK имеет отдельный предел и не расходует трёхсекундный direct deadline.
      socket.setSoTimeout(65000);

      ByteArrayOutputStream bytes = new ByteArrayOutputStream();
      int next;

      while ((next = socket.getInputStream().read()) != 10) {
        if (next < 0 || bytes.size() >= 2048) {
          throw new IOException("relay_bad_reply");
        }

        bytes.write(next);
      }

      JSONObject ack = new JSONObject(bytes.toString("UTF-8"));

      if (!ack.optBoolean("ok")) {
        String code = ack.optString("error");

        if (Set.of("bad_version", "client_unavailable", "bad_hello").contains(code)) {
          throw new IOException("relay_upgrade_required");
        }

        // Отказ токена относится к ретранслятору, а не к привязке устройства на сервере.
        throw new IOException(code.equals("unauthorized") ? "relay_unauthorized" : "offline");
      }

      socket.setSoTimeout(0);

      return socket;
    } catch (Exception failure) {
      sockets.remove(socket);
      socket.close();
      throw failure;
    }
  }

  public void release(Socket socket) {
    sockets.remove(socket);
  }

  /**
   * Поколение владеет также сокетами, которые ещё выполняют connect или handshake.
   * Закрытый dialer не может опубликовать позднее успешное соединение.
   */
  @Override
  public void close() {
    closed = true;

    for (Socket socket : sockets) {
      try {
        socket.close();
      } catch (IOException ignored) {
        // Следующие сокеты также должны быть закрыты.
      }
    }

    sockets.clear();
  }
}
