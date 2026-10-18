package local.grigdesk.mobile.link;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.function.Consumer;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import org.json.JSONObject;

/**
 * Внешний TLS сверяет relay pin до hello, а строка читается без потери coalesced raw хвоста.
 * Все созданные sockets регистрируются у forwarder до connect и отменяются общим lock.
 */
public final class RelayDialer {

  private final JSONObject relay;

  public RelayDialer(JSONObject relay) throws Exception {
    QrPayload.validateRelay(relay);
    this.relay = new JSONObject(relay.toString());
  }

  /**
   * Таймаут hello снимается после ok, чтобы idle TLS туннель не оборвался через 15 секунд.
   * TLS 1.3 задаётся явно; системный proxy не участвует в подключении.
   */
  public SSLSocket open(Consumer<Socket> track) throws Exception {
    String host = relay.getString("host");
    int port = relay.getInt("port");
    SSLContext context = SSLContext.getInstance("TLSv1.3");

    context.init(
      null,
      new javax.net.ssl.TrustManager[] { new PinnedTrustManager(relay.getString("fp")) },
      null
    );

    Socket raw = new Socket(Proxy.NO_PROXY);

    track.accept(raw);

    try {
      raw.connect(new InetSocketAddress(host, port), 10000);

      SSLSocket socket = (SSLSocket) context.getSocketFactory().createSocket(raw, host, port, true);

      track.accept(socket);
      socket.setEnabledProtocols(new String[] { "TLSv1.3" });
      socket.setSoTimeout(15000);
      socket.setTcpNoDelay(true);
      socket.setKeepAlive(true);
      socket.startHandshake();
      socket.getOutputStream().write(RelayHello.encodeDevice(relay.getString("token")));
      socket.getOutputStream().flush();

      String result = RelayHello.parseReply(readLine(socket.getInputStream()));

      if (!"ok".equals(result)) {
        throw new IllegalStateException(result);
      }

      socket.setSoTimeout(0);

      return socket;
    } catch (Exception exception) {
      raw.close();

      throw exception;
    }
  }

  /**
   * Читается ровно одна LF строка; внутренний TLS остаётся в underlying InputStream.
   * Oversize/EOF закрывает hello до передачи сокета клиенту мозга.
   */
  public static String readLine(InputStream input) throws Exception {
    ByteArrayOutputStream output = new ByteArrayOutputStream();

    for (int count = 0; count <= 2048; count += 1) {
      int value = input.read();

      if (value == '\n') {
        return StandardCharsets.UTF_8.newDecoder()
          .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
          .decode(java.nio.ByteBuffer.wrap(output.toByteArray()))
          .toString();
      }
      if (value < 0 || count == 2048) {
        throw new IllegalStateException("Ответ посредника повреждён");
      }

      output.write(value);
    }

    throw new IllegalStateException("Ответ посредника повреждён");
  }
}
