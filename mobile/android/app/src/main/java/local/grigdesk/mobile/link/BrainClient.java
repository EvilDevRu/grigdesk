package local.grigdesk.mobile.link;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.Proxy;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.Collections;
import java.util.Random;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.function.LongSupplier;
import javax.net.ssl.KeyManager;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509ExtendedKeyManager;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.ConnectionPool;
import okhttp3.ConnectionSpec;
import okhttp3.Dispatcher;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.TlsVersion;
import org.json.JSONObject;

/**
 * Brain HTTP проходит только внутренний pinned TLS с клиентским Keystore сертификатом.
 * REST/SSE/media делят семь соединений и общий unlock/generation gate без автоматических POST retries.
 */
public final class BrainClient implements AutoCloseable {

  public interface Listener {
    void event(String name, String data, long generation);
    void state(String state, long generation);
  }

  public static final class Result {

    public final int status;
    public final String body;
    public final long generation;

    Result(int status, String body, long generation) {
      this.status = status;
      this.body = body;
      this.generation = generation;
    }
  }

  private final NativeSession session;
  private final long generation;
  private final SSLContext context;
  private final OkHttpClient rest;
  private final OkHttpClient media;
  private final OkHttpClient sse;
  private final Semaphore restSlots = new Semaphore(4, true);
  private final Semaphore mediaSlots = new Semaphore(2, true);
  private final String base;
  private final String brainFp;
  private final LongSupplier clock;
  private final Listener listener;
  private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();
  private final Backoff backoff = new Backoff(new Random());
  private Call source;
  private ScheduledFuture<?> reconnect;
  private ScheduledFuture<?> watchdog;
  private long lastActivity;
  private boolean eventsWanted;
  private volatile boolean closed;

  /**
   * Production передаёт DeviceKeyManager, а JVM стенд — только свой test key manager.
   * Каждый unlock создаёт новые SSLContext/pools; localhost proxy и HTTP2 отключены.
   */
  public BrainClient(
    int port,
    String brainFp,
    X509ExtendedKeyManager keys,
    NativeSession session,
    long generation,
    LongSupplier clock,
    Listener listener
  ) throws Exception {
    this.session = session;
    this.generation = generation;
    this.brainFp = brainFp;
    this.clock = clock;
    this.listener = listener;
    base = "https://127.0.0.1:" + port;
    context = SSLContext.getInstance("TLSv1.3");
    PinnedTrustManager trust = new PinnedTrustManager(brainFp);

    context.init(new KeyManager[] { keys }, new TrustManager[] { trust }, null);
    rest = builder(trust, 4)
      .callTimeout(60, TimeUnit.SECONDS)
      .readTimeout(60, TimeUnit.SECONDS)
      .build();
    media = builder(trust, 2)
      .callTimeout(120, TimeUnit.SECONDS)
      .readTimeout(120, TimeUnit.SECONDS)
      .build();
    sse = builder(trust, 1)
      .readTimeout(0, TimeUnit.SECONDS)
      .callTimeout(0, TimeUnit.SECONDS)
      .build();
  }

  /**
   * Отдельные pools фиксируют бюджет REST 4 + SSE 1 + media 2, включая synchronous execute.
   * Дополнительный Semaphore для REST необходим: Dispatcher ограничивает только async enqueue.
   */
  private OkHttpClient.Builder builder(PinnedTrustManager trust, int connections) {
    Dispatcher dispatcher = new Dispatcher();

    dispatcher.setMaxRequests(connections);
    dispatcher.setMaxRequestsPerHost(connections);

    ConnectionSpec spec = new ConnectionSpec.Builder(ConnectionSpec.MODERN_TLS)
      .tlsVersions(TlsVersion.TLS_1_3)
      .supportsTlsExtensions(true)
      .build();

    return new OkHttpClient.Builder()
      .sslSocketFactory(context.getSocketFactory(), trust)
      .hostnameVerifier((host, sslSession) -> true)
      .proxy(Proxy.NO_PROXY)
      .protocols(Collections.singletonList(Protocol.HTTP_1_1))
      .connectionSpecs(Collections.singletonList(spec))
      .dispatcher(dispatcher)
      .connectionPool(new ConnectionPool(connections, 30, TimeUnit.SECONDS))
      .connectTimeout(15, TimeUnit.SECONDS)
      .retryOnConnectionFailure(false)
      .followRedirects(false)
      .followSslRedirects(false);
  }

  public Result request(String method, String route, String body, String key, long createdAt)
    throws Exception {
    if (!Routes.allowed(method, route)) {
      throw new IllegalArgumentException("bad_route");
    }

    return json(method, route, body, key, createdAt);
  }

  public Result hello() throws Exception {
    return json("GET", "/api/mobile/v1/hello", null, null, 0);
  }

  public Result pair(String code, String name) throws Exception {
    QrPayload.strictBase64(code, 24);

    return json(
      "POST",
      "/api/mobile/v1/pair",
      new JSONObject().put("code", code).put("name", name).toString(),
      null,
      0
    );
  }

  /**
   * Вызов проверяет gate до создания Call и после чтения, до возврата данных JS.
   * JSON bounded 2 МиБ; redirect остаётся отказом и не меняет pinned назначение.
   */
  private Result json(String method, String route, String body, String key, long createdAt)
    throws Exception {
    require();

    if (!restSlots.tryAcquire(15, TimeUnit.SECONDS)) {
      throw new IOException("network");
    }

    try {
      require();

      Request.Builder request = new Request.Builder().url(base + route);

      if ("POST".equals(method)) {
        if (!route.endsWith("/pair") && (key == null || !key.matches("[A-Za-z0-9_-]{8,80}"))) {
          throw new IllegalArgumentException("bad_operation");
        }

        request.post(
          RequestBody.create(body == null ? "{}" : body, MediaType.get("application/json"))
        );

        if (key != null) {
          request
            .header("Idempotency-Key", key)
            .header("X-GrigDesk-Operation-Created-At", Long.toString(createdAt));
        }
      }

      try (Response response = rest.newCall(request.build()).execute()) {
        byte[] bytes = bounded(response.body().byteStream(), 2 * 1024 * 1024);

        require();

        if (response.code() == 401 || response.code() == 403) {
          listener.state(response.code() == 403 ? "revoked" : "device_unknown", generation);
        }

        return new Result(response.code(), new String(bytes, StandardCharsets.UTF_8), generation);
      }
    } finally {
      restSlots.release();
    }
  }

  /**
   * Один SSE owner создаёт одну сессию и один watchdog, повторные start идемпотентны.
   * Heartbeat не передаёт продуктовые данные, но держит соединение живым через monotonic часы.
   */
  public synchronized void startEvents() {
    require();

    if (closed || eventsWanted) {
      return;
    }

    eventsWanted = true;
    backoff.reset();
    connectEvents();
    watchdog = scheduler.scheduleAtFixedRate(
      () -> {
        synchronized (BrainClient.this) {
          if (!session.isCurrent(generation)) {
            stopEvents();
            listener.state("locked", generation);
          } else if (source != null && clock.getAsLong() - lastActivity > 45000L) {
            Call current = source;

            source = null;
            current.cancel();
            retryEvents();
          }
        }
      },
      1,
      1,
      TimeUnit.SECONDS
    );
  }

  /**
   * Callback принадлежит ровно одному Call; старое поколение не создаёт retry.
   * Bounded SSE parser ограничивает байты до сборки строки, включая незавершённый event.
   */
  private synchronized void connectEvents() {
    if (!eventsWanted || closed || !session.isCurrent(generation)) {
      return;
    }

    lastActivity = clock.getAsLong();

    Request request = new Request.Builder().url(base + "/api/mobile/v1/events").build();
    Call current = sse.newCall(request);

    source = current;
    current.enqueue(
      new Callback() {
        /**
         * Поток SSE проверяет HTTP статус до передачи любого события приложению.
         * Закрытие и ошибка освобождают единственный owner перед планированием reconnect.
         */
        @Override
        public void onResponse(Call call, Response response) {
          try (Response owned = response) {
            synchronized (BrainClient.this) {
              if (!validEvent(call)) {
                return;
              }
              if (response.code() == 401 || response.code() == 403) {
                stopEvents();
                listener.state(response.code() == 403 ? "revoked" : "device_unknown", generation);

                return;
              }
              if (
                response.code() != 200 ||
                !response.header("Content-Type", "").startsWith("text/event-stream")
              ) {
                throw new IOException("contract");
              }

              lastActivity = clock.getAsLong();
              backoff.reset();
              listener.state("online", generation);
            }
            readEvents(call, response.body().byteStream());
            eventsFailed(call, new IOException("network"));
          } catch (Exception exception) {
            eventsFailed(call, exception);
          }
        }

        @Override
        public void onFailure(Call call, IOException exception) {
          eventsFailed(call, exception);
        }
      }
    );
  }

  /**
   * Строка ограничена 64 КиБ во время чтения; сумма data не превышает тот же предел.
   * Комментарии heartbeat обновляют monotonic watchdog без продуктового события.
   */
  private void readEvents(Call current, InputStream raw) throws Exception {
    InputStream input = new java.io.BufferedInputStream(raw, 16384);
    String name = "";
    StringBuilder data = new StringBuilder();
    int dataBytes = 0;

    while (true) {
      require();

      ByteArrayOutputStream bytes = new ByteArrayOutputStream();
      int value;

      while ((value = input.read()) != '\n') {
        if (value < 0) {
          return;
        }
        if (bytes.size() >= 65536) {
          throw new IOException("contract");
        }

        bytes.write(value);
      }

      String line = StandardCharsets.UTF_8.newDecoder()
        .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
        .decode(java.nio.ByteBuffer.wrap(bytes.toByteArray()))
        .toString();

      if (line.endsWith("\r")) {
        line = line.substring(0, line.length() - 1);
      }

      synchronized (this) {
        if (!validEvent(current)) {
          return;
        }

        lastActivity = clock.getAsLong();

        if (line.isEmpty()) {
          if (data.length() > 0) {
            if (!name.matches("ready|heartbeat|chat|chats|waiting|tasks|b24")) {
              throw new IOException("contract");
            }

            String json = data.substring(0, data.length() - 1);
            JSONObject parsed = new JSONObject(json);

            if ("ready".equals(name) && parsed.optInt("api") != 1) {
              throw new IOException("contract");
            }

            listener.event(name, json, generation);
          }

          name = "";
          data.setLength(0);
          dataBytes = 0;
        } else if (line.startsWith("event:")) {
          name = line.substring(6).trim();

          if (name.length() > 128) {
            throw new IOException("contract");
          }
        } else if (line.startsWith("data:")) {
          String part = line.substring(5);

          if (part.startsWith(" ")) {
            part = part.substring(1);
          }

          dataBytes += part.getBytes(StandardCharsets.UTF_8).length + 1;

          if (dataBytes > 65536) {
            throw new IOException("contract");
          }

          data.append(part).append('\n');
        }
      }
    }
  }

  private boolean validEvent(Call current) {
    return eventsWanted && !closed && source == current && session.isCurrent(generation);
  }

  /**
   * Pin и повреждённый контракт прекращают автоматическое восстановление.
   * Сетевой отказ передаётся одному timer, который не повторяет REST или команды.
   */
  private synchronized void eventsFailed(Call current, Throwable error) {
    if (!validEvent(current)) {
      return;
    }

    source = null;

    if (hasCause(error, java.security.cert.CertificateException.class)) {
      stopEvents();
      listener.state("pin_mismatch", generation);
    } else if (
      "contract".equals(error.getMessage()) ||
      hasCause(error, org.json.JSONException.class) ||
      hasCause(error, java.nio.charset.CharacterCodingException.class)
    ) {
      stopEvents();
      listener.state("contract", generation);
    } else {
      retryEvents();
    }
  }

  private void require() {
    if (closed) {
      throw new IllegalStateException("locked");
    }

    session.require(generation);
  }

  /**
   * Retry принадлежит одному scheduled future и никогда не повторяет REST/POST.
   * Offline heartbeat failure обновляет UI, затем пересоединяется с ограниченным Backoff.
   */
  private void retryEvents() {
    if (!eventsWanted || closed || reconnect != null || !session.isCurrent(generation)) {
      return;
    }

    listener.state("offline", generation);
    reconnect = scheduler.schedule(
      () -> {
        synchronized (BrainClient.this) {
          reconnect = null;
          connectEvents();
        }
      },
      backoff.next(),
      TimeUnit.MILLISECONDS
    );
  }

  /**
   * Stop отменяет и текущую SSE сессию, и ожидающий reconnect/watchdog.
   * Следующее start после явного unlock создаёт нового клиента с новой TLS session cache.
   */
  public synchronized void stopEvents() {
    eventsWanted = false;

    if (reconnect != null) {
      reconnect.cancel(false);
      reconnect = null;
    }
    if (watchdog != null) {
      watchdog.cancel(false);
      watchdog = null;
    }
    if (source != null) {
      source.cancel();
      source = null;
    }
  }

  /**
   * Media сохраняется временно, проверяет raster signature/размеры и затем публикует atomic rename.
   * ETag привязан к собственному кэшу; отсутствие файла заставляет запросить полные байты.
   */
  public File media(File directory, String deviceId, String chatId, String ref) throws Exception {
    require();

    if (
      !chatId.matches("[A-Za-z0-9_-]{1,64}") ||
      !ref.matches("(u:[A-Za-z0-9_.-]{1,200}|w:[A-Za-z0-9_-]{1,2731})")
    ) {
      throw new IllegalArgumentException("bad_media");
    }
    if (!mediaSlots.tryAcquire(15, TimeUnit.SECONDS)) {
      throw new IOException("media_busy");
    }

    File temporary = null;

    try {
      require();
      synchronized (session) {
        require();

        if (!directory.isDirectory() && !directory.mkdirs()) {
          throw new IOException("media_cache");
        }
      }

      String identity = new org.json.JSONArray()
        .put(brainFp)
        .put(deviceId)
        .put(chatId)
        .put(ref)
        .toString();
      File file = new File(directory, Pins.sha256Hex(identity.getBytes(StandardCharsets.UTF_8)));
      File metadata = new File(file.getPath() + ".etag");
      Request.Builder request = new Request.Builder().url(
        base + "/api/mobile/v1/chats/" + chatId + "/media/" + URLEncoder.encode(ref, "UTF-8")
      );

      if (file.isFile() && metadata.isFile() && metadata.length() <= 256) {
        request.header(
          "If-None-Match",
          new String(Files.readAllBytes(metadata.toPath()), StandardCharsets.UTF_8)
        );
      }

      try (Response response = media.newCall(request.build()).execute()) {
        require();

        if (response.code() == 304 && file.isFile()) {
          file.setLastModified(System.currentTimeMillis());

          return file;
        }
        if (response.code() != 200) {
          if (response.code() == 401 || response.code() == 403) {
            listener.state(response.code() == 403 ? "revoked" : "device_unknown", generation);
          }

          throw new IOException(mediaError(response));
        }

        temporary = new File(file.getPath() + ".tmp");
        copyFile(response.body().byteStream(), temporary, 10000000);
        RasterValidation.validate(temporary, response.header("Content-Type", ""));
        synchronized (session) {
          require();
          Files.move(
            temporary.toPath(),
            file.toPath(),
            StandardCopyOption.ATOMIC_MOVE,
            StandardCopyOption.REPLACE_EXISTING
          );

          String etag = response.header("ETag", "");

          if (etag.length() <= 256) {
            LinkStore.atomic(metadata, etag.getBytes(StandardCharsets.UTF_8));
          }

          MediaCache.evict(directory, 100000000);

          return file;
        }
      }
    } finally {
      if (temporary != null) {
        temporary.delete();
      }

      mediaSlots.release();
    }
  }

  /**
   * APK скачивается с закреплённого мозга и ограничивается объявленным размером и общим пределом.
   * Digest проверяется до публикации файла, который позже получает системный установщик.
   */
  public File downloadUpdate(File directory) throws Exception {
    Result metadata = request("GET", "/api/mobile/v1/app", null, null, 0);

    if (metadata.status != 200) {
      throw new IOException("no_apk");
    }

    JSONObject info = new JSONObject(metadata.body);
    long size = info.getLong("size");
    String expected = info.getString("sha256");

    QrPayload.fingerprint(expected);

    if (size < 1 || size > 268435456L) {
      throw new IOException("apk_mismatch");
    }

    synchronized (session) {
      require();

      if (!directory.isDirectory() && !directory.mkdirs()) {
        throw new IOException("update_cache");
      }
    }

    File temporary = new File(directory, "download.tmp");
    Request request = new Request.Builder().url(base + "/api/mobile/v1/app/apk").build();

    if (!restSlots.tryAcquire(15, TimeUnit.SECONDS)) {
      throw new IOException("network");
    }

    try (
      Response response = rest
        .newBuilder()
        .callTimeout(120, TimeUnit.SECONDS)
        .build()
        .newCall(request)
        .execute()
    ) {
      require();

      if (response.code() != 200) {
        throw new IOException("no_apk");
      }

      copyFile(response.body().byteStream(), temporary, size);

      String hash;

      try (InputStream input = Files.newInputStream(temporary.toPath())) {
        java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[65536];
        int count;

        while ((count = input.read(buffer)) >= 0) {
          digest.update(buffer, 0, count);
        }

        StringBuilder result = new StringBuilder();

        for (byte value : digest.digest()) {
          result.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        }

        hash = result.toString();
      }

      if (temporary.length() != size || !expected.equals(hash)) {
        throw new IOException("apk_mismatch");
      }

      synchronized (session) {
        require();

        File file = new File(directory, "grigdesk-mobile.apk");

        Files.move(
          temporary.toPath(),
          file.toPath(),
          StandardCopyOption.ATOMIC_MOVE,
          StandardCopyOption.REPLACE_EXISTING
        );

        return file;
      }
    } finally {
      temporary.delete();
      restSlots.release();
    }
  }

  /**
   * Поток ограничен во время чтения, до выделения большой строки или bitmap.
   * Превышение лимита закрывает Response через владельца try-with-resources.
   */
  private static byte[] bounded(InputStream input, int limit) throws IOException {
    ByteArrayOutputStream result = new ByteArrayOutputStream();
    byte[] buffer = new byte[16384];
    int count;

    while ((count = input.read(buffer)) >= 0) {
      if (result.size() + count > limit) {
        throw new IOException("contract");
      }

      result.write(buffer, 0, count);
    }

    return result.toByteArray();
  }

  private String mediaError(Response response) {
    try {
      String error = new JSONObject(
        new String(bounded(response.body().byteStream(), 8192), StandardCharsets.UTF_8)
      ).optString("error", "network");

      return error.matches("[a-z_]{1,80}") ? error : "network";
    } catch (Exception exception) {
      return "network";
    }
  }

  /**
   * Файл синхронизируется после bounded streaming, не материализуя APK целиком в памяти.
   * Частично скачанный файл остаётся временным и удаляется внешним finally.
   */
  private void copyFile(InputStream input, File file, long limit) throws Exception {
    FileOutputStream opened;

    synchronized (session) {
      require();
      opened = new FileOutputStream(file);
    }
    try (FileOutputStream output = opened) {
      byte[] buffer = new byte[65536];
      long total = 0;
      int count;

      while ((count = input.read(buffer)) >= 0) {
        require();
        total += count;

        if (total > limit) {
          throw new IOException("media_type");
        }

        output.write(buffer, 0, count);
      }

      output.getFD().sync();
    }
  }

  /**
   * Терминальная причина распознаётся по типу в цепочке исключений без вывода её данных.
   * Проверка отделяет отказ сертификата и Keystore от временной потери сети.
   */
  public static boolean hasCause(Throwable error, Class<?> kind) {
    while (error != null) {
      if (kind.isInstance(error)) {
        return true;
      }

      error = error.getCause();
    }

    return false;
  }

  /**
   * Close отменяет все Call/pools/SSE и инвалидирует TLS session cache этого unlock.
   * Новая сессия не наследует соединения или успешные handshake старого поколения.
   */
  @Override
  public synchronized void close() {
    if (closed) {
      return;
    }

    closed = true;
    stopEvents();

    for (OkHttpClient client : new OkHttpClient[] { rest, sse, media }) {
      client.dispatcher().cancelAll();
      client.connectionPool().evictAll();
      client.dispatcher().executorService().shutdown();
    }

    java.util.Enumeration<byte[]> ids = context.getClientSessionContext().getIds();

    while (ids.hasMoreElements()) {
      javax.net.ssl.SSLSession sslSession = context
        .getClientSessionContext()
        .getSession(ids.nextElement());

      if (sslSession != null) {
        try {
          sslSession.invalidate();
        } catch (UnsupportedOperationException cached) {
          // Conscrypt на Android не инвалидирует сессию из кэша. Контекст принадлежит только
          // этому клиенту и после close не используется: продолжить старую сессию нечем.
        }
      }
    }

    scheduler.shutdownNow();
  }
}
