package local.grigdesk.client.key;

import java.io.IOException;
import java.net.InetAddress;
import java.net.Socket;
import java.security.SecureRandom;
import javax.net.ssl.KeyManager;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509KeyManager;

/**
 * Каждый новый сокет получает отдельный SSLContext без прежних TLS-сессий.
 * HTTP и upgrade используют одну pin-политику и один неэкспортируемый ключ установки.
 */
public final class PinnedSocketFactory extends SSLSocketFactory {
  private final X509KeyManager keys;
  private final PinnedTrustManager trust;

  public PinnedSocketFactory(X509KeyManager keys, PinnedTrustManager trust) {
    this.keys = keys;
    this.trust = trust;
  }

  /**
   * Новый сокет получает отдельный TLS-контекст, исключая повтор старой сессии.
   * Проверка pin выполняется trust manager до передачи HTTP-байтов.
   */
  private SSLSocketFactory fresh() throws IOException {
    try {
      KeyFailure.check(keys);

      SSLContext context = SSLContext.getInstance("TLSv1.3");

      context.init(new KeyManager[] { keys }, new TrustManager[] { trust }, new SecureRandom());
      context.getClientSessionContext().setSessionTimeout(1);

      return context.getSocketFactory();
    } catch (Exception exception) {
      throw new IOException("Не удалось создать TLS", exception);
    }
  }

  private Socket restrict(Socket socket) throws java.net.SocketException {
    socket.setSoTimeout(3000);
    ((SSLSocket) socket).setEnabledProtocols(new String[] { "TLSv1.3" });

    return socket;
  }

  @Override
  public String[] getDefaultCipherSuites() {
    try {
      return fresh().getDefaultCipherSuites();
    } catch (IOException exception) {
      throw new IllegalStateException(exception);
    }
  }

  @Override
  public String[] getSupportedCipherSuites() {
    return getDefaultCipherSuites();
  }

  @Override
  public Socket createSocket() throws IOException {
    return restrict(fresh().createSocket());
  }

  @Override
  public Socket createSocket(Socket socket, String host, int port, boolean close) throws IOException {
    return restrict(fresh().createSocket(socket, host, port, close));
  }

  @Override
  public Socket createSocket(String host, int port) throws IOException {
    return restrict(fresh().createSocket(host, port));
  }

  @Override
  public Socket createSocket(String host, int port, InetAddress local, int localPort) throws IOException {
    return restrict(fresh().createSocket(host, port, local, localPort));
  }

  @Override
  public Socket createSocket(InetAddress host, int port) throws IOException {
    return restrict(fresh().createSocket(host, port));
  }

  @Override
  public Socket createSocket(InetAddress host, int port, InetAddress local, int localPort)
    throws IOException {
    return restrict(fresh().createSocket(host, port, local, localPort));
  }
}
