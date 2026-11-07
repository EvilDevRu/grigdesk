package local.grigdesk.client.pipe;

import java.io.BufferedInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Supplier;

public final class ClientPipe implements AutoCloseable {
  public interface Shell {
    PipeResponse handle(HttpHead head, InputStream body) throws Exception;
  }

  private final ServerSocket listener;
  private final ExecutorService pool = Executors.newFixedThreadPool(32);
  private final Set<Socket> sockets = ConcurrentHashMap.newKeySet();
  private final String secret;
  private final StaticAssets assets;
  private final Supplier<? extends PipeTransport> upstream;
  private final Shell shell;
  private Supplier<String> unavailable = () -> "offline";
  private volatile boolean closed;

  /**
   * Слушатель доступен только на loopback и не зависит от сети удалённой машины.
   * Разбор HTTP, SSE и туннели разделяют ограниченный пул из 32 работников.
   */
  public ClientPipe(int port, String secret, StaticAssets assets, Supplier<? extends PipeTransport> upstream,
    Shell shell) throws Exception {
    this.secret = secret;
    this.assets = assets;
    this.upstream = upstream;
    this.shell = shell;
    listener = new ServerSocket();
    listener.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 32);

    Thread accept = new Thread(this::accept, "grigdesk-pipe-accept");

    accept.setDaemon(true);
    accept.start();
  }

  public ClientPipe(int port, String secret, StaticAssets assets, Supplier<? extends PipeTransport> upstream,
    Shell shell, Supplier<String> unavailable) throws Exception {
    this(port, secret, assets, upstream, shell);
    this.unavailable = unavailable;
  }

  private PipeResponse unavailable() {
    String status = unavailable.get();

    return PipeResponse.error("locked".equals(status) ? 423 : 503,
      "none".equals(status) ? "no_machine" : status);
  }

  public int port() {
    return listener.getLocalPort();
  }

  /**
   * Каждое локальное соединение получает ограниченный срок чтения заголовков.
   * Ошибка слушателя завершает собственную трубу и освобождает её клиентов.
   */
  private void accept() {
    while (!closed) {
      try {
        Socket socket = listener.accept();

        socket.setSoTimeout(30000);
        sockets.add(socket);
        pool.execute(() -> serve(socket));
      } catch (Exception exception) {
        if (!closed) {
          close();
        }
      }
    }
  }

  /**
   * Cookie сравнивается за постоянное время, а Host и Origin привязаны к этой трубе.
   * Абсолютный request-target никогда не становится способом обратиться к чужому серверу.
   */
  private boolean authorized(HttpHead head) throws Exception {
    String host = "127.0.0.1:" + port();
    String origin = head.headers.get("origin");
    String target = head.target();
    String site = head.headers.get("sec-fetch-site");
    boolean cookieMatches = false;

    for (String part : head.headers.getOrDefault("cookie", "").split(";")) {
      String value = part.trim();

      if (value.startsWith("grigdesk_pipe=")) {
        cookieMatches |= MessageDigest.isEqual(secret.getBytes(StandardCharsets.UTF_8),
          value.substring("grigdesk_pipe=".length()).getBytes(StandardCharsets.UTF_8));
      }
    }

    return host.equals(head.headers.get("host")) && (origin == null || origin.equals("http://" + host))
      && target.startsWith("/") && !target.startsWith("//") && !target.contains("\\")
      && (site == null || site.equals("same-origin") || site.equals("none")) && cookieMatches;
  }

  /**
   * Тела читаются по framing без захвата следующего keep-alive запроса.
   * Незавершённое тело после отказа закрывает сокет вместо разбора его как нового HTTP.
   */
  private void serve(Socket socket) {
    try (Socket front = socket; InputStream input = new BufferedInputStream(front.getInputStream())) {
      while (!closed) {
        HttpHead head = HttpHead.read(input);

        if (head == null) {
          return;
        }

        if (!authorized(head)) {
          write(front.getOutputStream(), head.method(), PipeResponse.error(403, "forbidden"), false);
          return;
        }

        BodyFraming.Frame body = BodyFraming.input(head, input);
        String path = URI.create(head.target()).getRawPath();
        boolean api = path.startsWith("/api/") || path.equals("/api") || path.startsWith("/shots/");
        PipeTransport remote = upstream.get();

        if (head.headers.getOrDefault("upgrade", "").equalsIgnoreCase("websocket")) {
          if (api && remote != null) {
            front.setSoTimeout(0);
            remote.upgrade(head, front, input, pool);
          } else {
            write(front.getOutputStream(), head.method(), unavailable(), false);
          }

          return;
        }

        PipeResponse response;

        if (path.startsWith("/__shell/")) {
          response = shell.handle(head, body);
        } else if (api) {
          response = remote == null ? unavailable() : remote.forward(head, body);
        } else if (head.method().equals("GET") || head.method().equals("HEAD")) {
          response = assets.get(path);
        } else {
          response = PipeResponse.error(404, "not_found");
        }

        boolean keep = !head.headers.getOrDefault("connection", "").equalsIgnoreCase("close")
          && body.complete();

        write(front.getOutputStream(), head.method(), response, keep);

        if (!keep) {
          return;
        }
      }
    } catch (Exception ignored) {
      // Некорректный или оборванный запрос закрывает только собственный сокет трубы.
    } finally {
      sockets.remove(socket);
    }
  }

  /**
   * Служебные и прикладные ответы используют один encoder без Set-Cookie сервера.
   * Неизвестная длина передаётся chunks с flush каждой части для потока событий.
   */
  public static void write(OutputStream output, String method, PipeResponse response, boolean keepAlive)
    throws Exception {
    try (PipeResponse result = response) {
      Map<String, String> headers = new LinkedHashMap<>(result.headers);
      boolean empty = method.equals("HEAD") || result.status == 204 || result.status == 304;

      headers.remove("set-cookie");
      headers.remove("content-length");
      headers.remove("transfer-encoding");
      headers.put("connection", keepAlive ? "keep-alive" : "close");

      if (result.length >= 0) {
        headers.put("content-length", Long.toString(result.length));
      } else if (!empty) {
        headers.put("transfer-encoding", "chunked");
      }

      output.write(new HttpHead("HTTP/1.1 " + result.status + " GrigDesk", headers).encode());
      output.flush();

      if (!empty) {
        BodyFraming.output(result.body, output, result.length);
      }
    }
  }

  /**
   * Закрытие освобождает порт и все принятые соединения этой машины.
   * Ошибка одного сокета не оставляет остальных клиентов и работников в фоне.
   */
  @Override
  public void close() {
    closed = true;

    try {
      listener.close();
    } catch (IOException ignored) {
      // Закрытие слушателя не мешает освободить все активные соединения.
    }

    for (Socket socket : sockets) {
      try {
        socket.close();
      } catch (IOException ignored) {
        // Остальные сокеты закрываются независимо от ошибки одного клиента.
      }
    }

    pool.shutdownNow();
  }
}
