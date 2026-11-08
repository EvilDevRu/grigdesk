package local.grigdesk.client.pipe;

import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.Socket;
import java.net.URI;
import java.security.cert.CertificateException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.BiConsumer;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.X509KeyManager;
import local.grigdesk.client.key.PinnedSocketFactory;
import local.grigdesk.client.key.PinnedTrustManager;
import okhttp3.Call;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okio.BufferedSink;
import org.json.JSONObject;

public final class Upstream implements PipeTransport {
  private static final java.util.regex.Pattern TIMING =
    java.util.regex.Pattern.compile("(?:^|,)\\s*grigdesk;dur=[0-9]");
  private static final Set<String> FORBIDDEN = Set.of("cookie", "host", "origin", "connection",
    "proxy-connection", "keep-alive", "transfer-encoding", "upgrade", "x-grigdesk-token",
    "x-grigdesk-internal", "x-grigdesk-window-key", "forwarded", "proxy-authorization");
  public final VersionGate version;
  private final URI address;
  private final X509KeyManager keys;
  private final OkHttpClient client;
  private static final int PROBE_READ_SECONDS = 10;
  private final int probeTimeoutSeconds;
  private final PinnedSocketFactory sockets;
  private final BiConsumer<String, String> listener;
  private final Set<Call> calls = ConcurrentHashMap.newKeySet();
  private final Set<Socket> tunnels = ConcurrentHashMap.newKeySet();
  private volatile String terminal;
  private volatile int rejection = 503;
  private volatile boolean closed;
  private volatile boolean retiring;
  private volatile Runnable onRetired;

  /**
   * Ключ передаётся извне: JVM использует программный сертификат, Android — Keystore.
   * Pin проверяется во время TLS до HTTP, а потоки не получают общего таймаута чтения.
   */
  public Upstream(String address, String pin, X509KeyManager keys, VersionGate version,
    BiConsumer<String, String> listener) {
    this(address, pin, keys, version, listener, 3);
  }

  /**
   * Relay включает внешний TLS и ожидание дозвона сервера перед внутренним handshake.
   * Его ограниченный deadline больше direct, потоки API по-прежнему не имеют общего таймаута.
   */
  public Upstream(String address, String pin, X509KeyManager keys, VersionGate version,
    BiConsumer<String, String> listener, int probeTimeoutSeconds) {
    this.probeTimeoutSeconds = probeTimeoutSeconds;
    this.address = URI.create(address);
    this.keys = keys;
    this.version = version;
    this.listener = listener;

    if (!this.address.getScheme().equals("https") || this.address.getHost() == null
      || this.address.getUserInfo() != null || this.address.getRawQuery() != null
      || this.address.getRawFragment() != null || !List.of("", "/").contains(this.address.getPath())) {
      throw new IllegalArgumentException("Нужен адрес HTTPS без пути");
    }

    PinnedTrustManager trust = new PinnedTrustManager(pin);

    sockets = new PinnedSocketFactory(keys, trust, probeTimeoutSeconds * 1000);
    client = new OkHttpClient.Builder().sslSocketFactory(sockets, trust)
      .hostnameVerifier((host, session) -> true).protocols(List.of(Protocol.HTTP_1_1))
      .proxy(Proxy.NO_PROXY).followRedirects(false).followSslRedirects(false)
      .retryOnConnectionFailure(false).connectionPool(new okhttp3.ConnectionPool(5, 60, TimeUnit.SECONDS))
      .connectTimeout(probeTimeoutSeconds, TimeUnit.SECONDS)
      .readTimeout(0, TimeUnit.MILLISECONDS).writeTimeout(0, TimeUnit.MILLISECONDS).build();
  }

  /**
   * Заголовки renderer не могут перенести cookie, полномочия или чужой Host наверх.
   * Явный Accept-Encoding отключает автоматическую распаковку OkHttp, сохраняя тело.
   */
  private Map<String, String> headers(HttpHead head, boolean upgrade) {
    Map<String, String> result = new LinkedHashMap<>();
    Set<String> hop = new java.util.HashSet<>(java.util.Arrays.asList(
      head.headers.getOrDefault("connection", "").toLowerCase(java.util.Locale.ROOT)
        .split("\\s*,\\s*", -1)));

    for (Map.Entry<String, String> item : head.headers.entrySet()) {
      String name = item.getKey();

      if (!FORBIDDEN.contains(name) && !name.startsWith("x-forwarded-") && !hop.contains(name)) {
        result.put(name, item.getValue());
      }
    }

    result.put("host", address.getRawAuthority());
    result.putIfAbsent("accept-encoding", "identity");

    if (head.headers.containsKey("origin")) {
      result.put("origin", address.getScheme() + "://" + address.getRawAuthority());
    }

    if (upgrade) {
      result.put("connection", "Upgrade");
      result.put("upgrade", "websocket");
    }

    return result;
  }

  /**
   * Внешний адрес берётся только из уже проверенного профиля машины.
   * Относительный путь не может заменить host или открыть другой сетевой ресурс.
   */
  private URI target(HttpHead head) throws IOException {
    String path = head.target();

    if (!path.startsWith("/") || path.startsWith("//") || path.contains("\\")) {
      throw new IOException("Неверный путь запроса");
    }

    return URI.create(address.toString().replaceAll("/$", "") + path);
  }

  /**
   * Тело запроса читается однократно и напрямую передаётся в сокет OkHttp.
   * Длина неизвестного chunked тела остаётся неизвестной без буферизации файла.
   */
  private Request request(HttpHead head, InputStream body) throws IOException {
    Request.Builder builder = new Request.Builder().url(target(head).toString());

    headers(head, false).forEach(builder::header);

    RequestBody data = null;

    // Мутации без объявленного тела (DELETE без Content-Length и chunked) уходят на машину
    // без тела: произвольный RequestBody OkHttp пометил бы chunked без Content-Type, и
    // Fastify ответил бы 415 ещё до обработчика. POST/PUT/PATCH требуют тело в OkHttp,
    // поэтому для них поведение прежнее, включая настоящее chunked-пересылание.
    boolean declaredBody = head.headers.containsKey("content-length")
      || head.headers.containsKey("transfer-encoding");
    boolean bodyRequiringMethod = head.method().equals("POST") || head.method().equals("PUT")
      || head.method().equals("PATCH");

    if (!head.method().equals("GET") && !head.method().equals("HEAD")
      && (declaredBody || bodyRequiringMethod)) {
      data = new RequestBody() {
        @Override
        public MediaType contentType() {
          return null;
        }

        @Override
        public long contentLength() {
          return Long.parseLong(head.headers.getOrDefault("content-length", "-1"));
        }

        @Override
        public boolean isOneShot() {
          return true;
        }

        @Override
        public void writeTo(BufferedSink sink) throws IOException {
          byte[] bytes = new byte[8192];
          int count;

          while ((count = body.read(bytes)) != -1) {
            sink.write(bytes, 0, count);
          }
        }
      };
    }

    return builder.method(head.method(), data).build();
  }

  /**
   * Терминальная причина не заменяется поздним успешным ответом другого запроса.
   * Все начатые потоки и туннели закрываются сразу после несовместимости или отзыва.
   */
  private synchronized void state(String status, String code, int response) {
    if (terminal != null || closed) {
      return;
    }

    if (Set.of("incompatible", "identityMismatch", "unpaired", "revoked", "locked").contains(status)) {
      terminal = code == null ? status : code;
      rejection = response;
      cancelTraffic();
    }

    listener.accept(status, code);
  }

  /**
   * Только ответ об устройстве меняет привязку; обычный запрет API сохраняет соединение.
   * Версия проверяется до чтения тела и остаётся защёлкнутой до явного подключения.
   */
  private boolean inspect(Response response, boolean probe) throws Exception {
    String failure = version.check(response.header("x-grigdesk-api"), response.code());

    if (failure != null) {
      state("incompatible", failure, 426);

      return false;
    }

    String code = "";

    if (response.code() == 401 || response.code() == 403 || response.code() == 429) {
      try {
        code = new JSONObject(response.peekBody(65536).string()).optString("error");
      } catch (Exception ignored) {
        // Тело обычного запрета может быть не JSON; оно не отменяет привязку.
      }
    }

    if (response.code() == 403 && code.equals("device_revoked")) {
      state("revoked", code, 403);
    } else if (response.code() == 429 && code.equals("pair_locked")) {
      state("unpaired", code, 429);
    } else if ((response.code() == 401 || response.code() == 403)
      && Set.of("device_scope_forbidden", "pair_locked").contains(code)) {
      state("unpaired", code, response.code());
    } else if ((response.code() == 401 || response.code() == 403)
      && Set.of("unpaired", "device_unknown").contains(code)) {
      state("unpaired", code, 401);
    }

    return terminal == null;
  }

  /**
   * Причина недоступного ключа распознаётся во всей цепочке исключений Keystore.
   * Ошибки pin терминальны; сетевой обрыв допускает повтор решением оболочки.
   */
  private void failed(Exception exception, boolean probe) {
    String status = local.grigdesk.client.key.KeyFailure.status(exception);

    if (probe || !status.equals("offline")) {
      state(status, null, status.equals("locked") ? 423 : 503);
    }
  }

  public PipeResponse forward(HttpHead head, InputStream body) throws Exception {
    return forward(head, body, false);
  }

  /**
   * Активный вызов остаётся учтённым до закрытия тела ответа, включая SSE.
   * Проверка версии и отзыва выполняется прежде передачи заголовков WebView.
   */
  private PipeResponse forward(HttpHead head, InputStream body, boolean probe) throws Exception {
    long diagnosticStart = System.nanoTime();

    if (closed || terminal != null) {
      return PipeResponse.error(rejection, terminal == null ? "offline" : terminal);
    }

    // Длинный deadline relay нужен только новому соединению: рукопожатие ждёт дозвона
    // сервера под soTimeout фабрики. Ответ hello по готовому соединению ограничен коротко,
    // чтобы мёртвый сервер за relay обнаруживался за секунды, а не за минуты.
    OkHttpClient selectedClient = probe
      ? client.newBuilder().callTimeout(probeTimeoutSeconds, TimeUnit.SECONDS)
        .readTimeout(Math.min(probeTimeoutSeconds, PROBE_READ_SECONDS), TimeUnit.SECONDS).build()
      : client;
    Call call = selectedClient.newCall(request(head, body));

    calls.add(call);

    if (closed || terminal != null) {
      calls.remove(call);
      call.cancel();
      return PipeResponse.error(rejection, terminal == null ? "offline" : terminal);
    }

    try {
      Response response = call.execute();

      if (!inspect(response, probe)) {
        response.close();
        calls.remove(call);

        return PipeResponse.error(rejection, terminal);
      }

      Map<String, String> headers = new LinkedHashMap<>();

      for (String name : response.headers().names()) {
        String lower = name.toLowerCase(java.util.Locale.ROOT);

        if (!Set.of("set-cookie", "connection", "transfer-encoding", "content-length", "keep-alive")
          .contains(lower)) {
          headers.put(lower, response.header(name));
        }
      }

      String timing = headers.getOrDefault("server-timing", "");

      if (TIMING.matcher(timing).find()) {
        String kept = java.util.Arrays.stream(timing.split(","))
          .filter(part -> !part.trim().startsWith("grigdesk_pipe;"))
          .collect(java.util.stream.Collectors.joining(","));
        double milliseconds = Math.max(0, System.nanoTime() - diagnosticStart) / 1_000_000.0;

        headers.put("server-timing", kept + ", grigdesk_pipe;dur="
          + String.format(java.util.Locale.ROOT, "%.1f", milliseconds));
      }

      return new PipeResponse(response.code(), headers, response.body().byteStream(),
        response.body().contentLength(), () -> {
          response.close();
          calls.remove(call);
          finishRetirement();
        });
    } catch (Exception exception) {
      calls.remove(call);
      finishRetirement();
      failed(exception, false);

      return PipeResponse.error(rejection, terminal == null ? "offline" : terminal);
    }
  }

  public void probe() throws Exception {
    try {
      local.grigdesk.client.key.KeyFailure.check(keys);

      try (PipeResponse response = forward(new HttpHead("GET /api/client/hello HTTP/1.1", Map.of()),
        new java.io.ByteArrayInputStream(new byte[0]), true)) {
        StaticAssets.readText(response.body, 65536);
        state(response.status == 200 ? "online" : "offline", null, 503);
      }
    } catch (Exception exception) {
      failed(exception, true);
    }
  }

  /**
   * Upgrade проходит новый TLS-handshake той же фабрики до единого байта HTTP.
   * Бинарный поток не интерпретируется и принадлежит транспорту до закрытия пары сокетов.
   */
  public void upgrade(HttpHead head, Socket downstream, InputStream input, ExecutorService pool)
    throws Exception {
    if (closed || terminal != null) {
      ClientPipe.write(downstream.getOutputStream(), head.method(),
        PipeResponse.error(rejection, terminal == null ? "offline" : terminal), false);
      return;
    }

    SSLSocket socket = null;

    try {
      socket = (SSLSocket) sockets.createSocket();
      tunnels.add(socket);

      if (closed || terminal != null) {
        return;
      }

      int port = address.getPort() < 0 ? 443 : address.getPort();

      socket.connect(new InetSocketAddress(address.getHost(), port), probeTimeoutSeconds * 1000);
      socket.setSoTimeout(probeTimeoutSeconds * 1000);
      socket.startHandshake();
      socket.setSoTimeout(0);
      target(head);
      socket.getOutputStream().write(new HttpHead(head.first, headers(head, true)).encode());
      socket.getOutputStream().flush();

      InputStream upstream = new java.io.BufferedInputStream(socket.getInputStream());
      HttpHead response = HttpHead.read(upstream);
      String failure = version.check(response.headers.get("x-grigdesk-api"), response.status());

      if (failure != null) {
        state("incompatible", failure, 426);
        ClientPipe.write(downstream.getOutputStream(), head.method(),
          PipeResponse.error(426, failure), false);
      } else if (response.status() != 101 || terminal != null) {
        ClientPipe.write(downstream.getOutputStream(), head.method(),
          PipeResponse.error(response.status(), "upgrade_rejected"), false);
      } else {
        response.headers.remove("set-cookie");
        socket.setSoTimeout(0);
        downstream.getOutputStream().write(response.encode());
        downstream.getOutputStream().flush();
        UpgradeTunnel.run(downstream, input, socket, upstream, pool);
      }
    } catch (Exception exception) {
      failed(exception, false);
      ClientPipe.write(downstream.getOutputStream(), head.method(),
        PipeResponse.error(rejection, terminal == null ? "offline" : terminal), false);
    } finally {
      if (socket != null) {
        tunnels.remove(socket);
        finishRetirement();
        socket.close();
      }
    }
  }

  /**
   * Смена маршрута закрывает child после завершения его начатых потоков.
   * POST и upgrade продолжают работать на прежнем соединении без повторной отправки.
   */
  public synchronized void retire(Runnable cleanup) {
    onRetired = cleanup;
    retiring = true;
    finishRetirement();
  }

  /**
   * Очистка срабатывает один раз после последнего ответа или upgrade.
   * Forwarder не остаётся слушать после полного дренирования старого пути.
   */
  private synchronized void finishRetirement() {
    if (retiring && calls.isEmpty() && tunnels.isEmpty()) {
      close();

      Runnable cleanup = onRetired;

      onRetired = null;

      if (cleanup != null) {
        cleanup.run();
      }
    }
  }

  /**
   * Отмена закрывает текущие вызовы и двунаправленные туннели независимо друг от друга.
   * Соединения пула удаляются, чтобы завершённый транспорт нельзя было использовать повторно.
   */
  private void cancelTraffic() {
    for (Call call : calls) {
      call.cancel();
    }

    for (Socket socket : tunnels) {
      try {
        socket.close();
      } catch (IOException ignored) {
        // Закрытие остальных потоков продолжается после ошибки одного сокета.
      }
    }

    client.connectionPool().evictAll();
  }

  /**
   * Закрытый транспорт больше не допускает новые запросы к машине.
   * Отмена активных потоков предшествует освобождению исполнителя OkHttp.
   */
  @Override
  public void close() {
    closed = true;
    cancelTraffic();
    client.dispatcher().executorService().shutdown();
  }
}
