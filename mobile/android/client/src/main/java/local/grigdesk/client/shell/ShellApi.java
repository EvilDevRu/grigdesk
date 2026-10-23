package local.grigdesk.client.shell;

import java.io.InputStream;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;
import java.util.function.DoubleSupplier;
import local.grigdesk.client.pipe.ClientPipe;
import local.grigdesk.client.pipe.HttpHead;
import local.grigdesk.client.pipe.PipeResponse;
import local.grigdesk.client.pipe.StaticAssets;
import local.grigdesk.client.pipe.PipeTransport;
import local.grigdesk.client.pipe.VersionGate;
import org.json.JSONObject;

public final class ShellApi implements ClientPipe.Shell, AutoCloseable {
  public interface Transport {
    void probe() throws Exception;
    void close();
    PipeTransport pipe();
  }

  public interface Report {
    void accept(String status, String code);
  }

  public interface Factory {
    Transport create(JSONObject profile, VersionGate version, Report report) throws Exception;
  }

  public interface Scheduler {
    Runnable schedule(Runnable callback, long delay);
  }

  public interface Native {
    String scan() throws Exception;
    void save(String name, String type, InputStream body) throws Exception;
    void unlock() throws Exception;
  }

  public final ShellState state;
  private final ProfileStore store;
  private final ShellLocale locale;
  private final Pairing pairing;
  private final Factory factory;
  private final Scheduler scheduler;
  private final Consumer<Runnable> worker;
  private final Consumer<String> navigate;
  private final Native nativeActions;
  private final DoubleSupplier random;
  private final int major;
  private final int minor;
  private final Map<String, Transport> transports = new ConcurrentHashMap<>();
  private final Map<String, Runnable> retries = new HashMap<>();
  private final Map<String, Integer> healthFailures = new HashMap<>();
  private final Map<String, Integer> attempts = new HashMap<>();
  private final Map<String, Integer> generations = new HashMap<>();
  private final java.util.Set<String> disabled = new java.util.HashSet<>();
  private boolean closed;
  private boolean suspended;

  /**
   * Оболочка объединяет профили, транспорт и нативные действия без доступа из JavaScript.
   * Работник и планировщик передаются явно для управляемой проверки отмены и повторов.
   */
  public ShellApi(ProfileStore store, Pairing pairing, Factory factory, Scheduler scheduler,
    Consumer<Runnable> worker, Consumer<String> navigate, Native nativeActions, DoubleSupplier random,
    int major, int minor) {
    this(store, pairing, factory, scheduler, worker, navigate, nativeActions, random, major, minor, null);
  }

  /**
   * Локаль установки необязательна для прежних потребителей ShellApi.
   * Новый endpoint не зависит от машины и не вызывает переход WebView.
   */
  public ShellApi(ProfileStore store, Pairing pairing, Factory factory, Scheduler scheduler,
    Consumer<Runnable> worker, Consumer<String> navigate, Native nativeActions, DoubleSupplier random,
    int major, int minor, ShellLocale locale) {
    this.locale = locale;
    this.store = store;
    this.pairing = pairing;
    this.factory = factory;
    this.scheduler = scheduler;
    this.worker = worker;
    this.navigate = navigate;
    this.nativeActions = nativeActions;
    this.random = random;
    this.major = major;
    this.minor = minor;
    state = new ShellState(store, major, minor, locale);
  }

  public PipeTransport upstream(String id) {
    Transport transport = transports.get(id);

    return transport == null ? null : transport.pipe();
  }

  /**
   * Повторы допускаются только из offline; поколения отбрасывают запоздалые ответы.
   * Jitter и часы планировщика подменяются в JVM-тестах без реального ожидания.
   */
  private synchronized void report(String id, int generation, VersionGate gate, String status, String code) {
    if (closed || suspended || disabled.contains(id) || generations.getOrDefault(id, 0) != generation) {
      return;
    }

    try {
      if (status.equals("offline") && state.status(id).equals("online")) {
        int failures = healthFailures.getOrDefault(id, 0) + 1;

        healthFailures.put(id, failures);

        if (failures < 3) {
          status = "online";
        }
      } else if (status.equals("online")) {
        healthFailures.remove(id);
      }

      state.report(id, status, code, gate.server());
      cancelRetry(id);

      if (status.equals("offline")) {
        int attempt = attempts.getOrDefault(id, 0);
        long delay = Math.round(Math.min(30000, 1000L << Math.min(5, attempt))
          * (0.8 + random.getAsDouble() * 0.4));

        attempts.put(id, attempt + 1);
        state.retryAt(id, System.currentTimeMillis() + delay);
        retries.put(id, scheduler.schedule(() -> {
          synchronized (ShellApi.this) {
            retries.remove(id);

            if (generations.getOrDefault(id, 0) == generation && !disabled.contains(id) && !suspended
              && state.status(id).equals("offline")) {
              connect(id, false);
            }
          }
        }, delay));
      } else if (status.equals("online")) {
        attempts.remove(id);
        retries.put(id, scheduler.schedule(() -> {
          synchronized (ShellApi.this) {
            Transport transport = transports.get(id);

            if (transport != null && !closed && !suspended && !disabled.contains(id)
              && generations.getOrDefault(id, 0) == generation && state.status(id).equals("online")) {
              worker.accept(() -> {
                try {
                  transport.probe();
                } catch (Exception exception) {
                  report(id, generation, gate, "offline", null);
                }
              });
            }
          }
        }, 5000));
      }
    } catch (Exception exception) {
      throw new IllegalStateException(
        ShellLocale.text(locale, "native.connectionStateFailure", "Не удалось обновить состояние связи."),
        exception);
    }
  }

  private void cancelRetry(String id) {
    Runnable cancel = retries.remove(id);

    if (cancel != null) {
      cancel.run();
    }
  }

  /**
   * Новая попытка создаёт собственный транспорт и защёлку версии.
   * Probe выполняется вне потока HTTP, поэтому недоступная машина не задерживает UI.
   */
  public synchronized void connect(String id, boolean manual) {
    if (id == null || closed || suspended) {
      return;
    }

    if (manual) {
      disabled.remove(id);
      attempts.remove(id);
    }

    cancelRetry(id);
    healthFailures.remove(id);

    Transport previous = transports.remove(id);

    if (previous != null) {
      closeTransport(previous);
    }

    int generation = generations.getOrDefault(id, 0) + 1;
    VersionGate gate = new VersionGate(major, minor);

    generations.put(id, generation);
    report(id, generation, gate, "connecting", null);
    worker.accept(() -> {
      try {
        Transport transport = factory.create(store.get(id), gate,
          (status, code) -> report(id, generation, gate, status, code));

        synchronized (ShellApi.this) {
          if (closed || suspended || disabled.contains(id) || generations.get(id) != generation) {
            transport.close();
            return;
          }

          transports.put(id, transport);
        }

        transport.probe();
      } catch (Exception exception) {
        report(id, generation, gate, local.grigdesk.client.key.KeyFailure.status(exception), null);
      }
    });
  }

  /**
   * Ручное отключение отменяет повтор и повышает поколение раньше закрытия транспорта.
   * Поздний callback не может восстановить соединение без нового действия человека.
   */
  public synchronized void disconnect(String id) throws Exception {
    if (id == null) {
      return;
    }

    disabled.add(id);
    generations.put(id, generations.getOrDefault(id, 0) + 1);
    cancelRetry(id);
    healthFailures.remove(id);

    Transport previous = transports.remove(id);

    if (previous != null) {
      closeTransport(previous);
    }

    state.report(id, "offline", "disconnected", null);
  }

  /**
   * Переход отключает прежнюю машину до выбора нового origin.
   * Новая попытка считается действием человека и снимает запрет автоповтора.
   */
  private void select(String id) throws Exception {
    if (store.selected != null && !store.selected.equals(id)) {
      disconnect(store.selected);
    }

    store.select(id);
    state.changed();
    connect(id, true);
  }

  /**
   * Имя скачиваемого файла проверяется до обращения к MediaStore.
   * Пути, управляющие символы и неоднозначные сегменты не принимаются.
   */
  public static String saveName(String name) {
    return saveName(name, null);
  }

  /**
   * Имя файла проверяется тем же предикатом в старых и новых оболочках.
   * Локаль установки меняет только сообщение об отклонённом вводе.
   */
  public static String saveName(String name, ShellLocale locale) {
    if (name == null || name.trim().isEmpty() || name.length() > 180 || name.contains("/")
      || name.contains("\\") || name.contains("..") || name.matches(".*[\\x00-\\x1f\\x7f].*")) {
      throw new IllegalArgumentException(
        ShellLocale.text(locale, "native.invalidFileName", "Недопустимое имя файла."));
    }

    return name.trim();
  }

  /**
   * Имена параметров и значения разбираются отдельно без интерпретации пути.
   * Перегрузка с именем кодировки поддерживается начиная с минимального Android API.
   */
  private static Map<String, String> query(URI uri) throws java.io.UnsupportedEncodingException {
    Map<String, String> query = new HashMap<>();

    for (String part : uri.getRawQuery() == null ? new String[0] : uri.getRawQuery().split("&")) {
      String[] item = part.split("=", 2);

      query.put(URLDecoder.decode(item[0], StandardCharsets.UTF_8.name()), item.length < 2 ? ""
        : URLDecoder.decode(item[1], StandardCharsets.UTF_8.name()));
    }

    return query;
  }

  /**
   * Один контракт shell обслуживает управление профилями и нативные действия Android.
   * Переход на новый origin вызывается после отправки ответа, без обрыва fetch формы.
   */
  @Override
  public PipeResponse handle(HttpHead head, InputStream body) throws Exception {
    URI uri = URI.create(head.target());
    String path = uri.getPath();
    Map<String, String> query = query(uri);

    try {
      if (head.method().equals("GET") && path.equals("/__shell/state")) {
        return PipeResponse.json(200, query.containsKey("rev") ? state.poll(Long.parseLong(query.get("rev")))
          : state.snapshot());
      }

      if (head.method().equals("POST") && path.equals("/__shell/save")) {
        nativeActions.save(saveName(query.get("name"), locale),
          query.getOrDefault("type", "application/octet-stream"),
          body);
        return PipeResponse.json(200, new JSONObject().put("ok", true));
      }

      String text = StaticAssets.readText(body, 65536);
      JSONObject data = new JSONObject(text.isEmpty() ? "{}" : text);
      if (head.method().equals("POST") && path.equals("/__shell/locale") && locale != null) {
        if (data.length() != 1 || !(data.opt("preference") instanceof String)) {
          throw new IllegalArgumentException(locale.text("native.invalidLanguage"));
        }

        locale.setPreference(data.getString("preference"));
        state.changed();

        return PipeResponse.json(200, state.snapshot());
      }

      String navigation = null;
      boolean move = false;

      if (head.method().equals("POST") && path.equals("/__shell/scan")) {
        return PipeResponse.json(200, new JSONObject().put("pairing", nativeActions.scan()));
      } else if (head.method().equals("POST") && path.equals("/__shell/unlock")) {
        nativeActions.unlock();
        connect(store.selected, true);
      } else if (head.method().equals("POST") && path.equals("/__shell/profiles")) {
        nativeActions.unlock();
        JSONObject added = pairing.add(data.getString("pairing"));

        select(added.getString("id"));
        navigation = store.selected;
        move = true;
      } else if (head.method().equals("POST") && path.equals("/__shell/select")) {
        if (!data.getString("id").equals(store.selected)) {
          select(data.getString("id"));
          navigation = store.selected;
          move = true;
        }
      } else if (head.method().equals("POST") && path.equals("/__shell/connect")) {
        connect(store.selected, true);
      } else if (head.method().equals("POST") && path.equals("/__shell/disconnect")) {
        disconnect(store.selected);
      } else if (path.startsWith("/__shell/profiles/") && head.method().equals("DELETE")) {
        String id = path.substring("/__shell/profiles/".length());
        boolean current = id.equals(store.selected);

        disconnect(id);
        store.remove(id);
        state.changed();
        move = current;
      } else if (path.startsWith("/__shell/profiles/") && head.method().equals("PATCH")) {
        JSONObject profile = store.get(path.substring("/__shell/profiles/".length()));
        String name = data.optString("name", profile.getString("name"));
        String address = data.optString("address", profile.getString("address"));

        java.util.Iterator<String> fields = data.keys();

        while (fields.hasNext()) {
          String key = fields.next();
          if (!key.equals("name") && !key.equals("address")) {
            throw new IllegalArgumentException(
              ShellLocale.text(locale, "native.invalidMachineFields", "Неверные поля машины."));
          }
        }

        ProfileStore.validate(name, address.isEmpty() && profile.has("relay")
          ? "https://profile.invalid" : address, profile.getString("fp"), locale);
        boolean changed = !address.equals(profile.getString("address"));

        if (changed) {
          pairing.verify(new JSONObject(profile.toString()).put("address", address));
        }

        store.add(name, address, profile.getString("fp"));
        state.changed();

        if (changed && profile.getString("id").equals(store.selected)) {
          connect(store.selected, true);
        }
      } else {
        return PipeResponse.error(404, "not_found");
      }

      PipeResponse response = PipeResponse.json(200, new JSONObject().put("ok", true));
      String selected = navigation;
      boolean shouldMove = move;

      return new PipeResponse(response.status, response.headers, response.body, response.length, () -> {
        if (shouldMove) {
          navigate.accept(selected);
        }
      });
    } catch (Exception exception) {
      Throwable cause = ClientFailure.unwrap(exception);
      String message = cause instanceof IllegalArgumentException || cause instanceof IllegalStateException
        ? cause.getMessage() : locale == null ? "Не удалось выполнить действие. Проверьте связь и повторите."
          : locale.text("native.actionFailure");

      if (message != null && java.util.Set.of("invalid_pairing", "unsupported_address").contains(message)) {
        message = ClientFailure.message(message, locale);
      }

      return PipeResponse.json(400, new JSONObject()
        .put("error", "shell_action_failed").put("message", message));
    }
  }

  /**
   * Закрытие TLS может выполнять сетевую запись даже при освобождении сокета.
   * Вызывающий поток лишь снимает транспорт с учёта, освобождение делает работник.
   */
  private void closeTransport(Transport transport) {
    worker.accept(transport::close);
  }

  /**
   * Фон закрывает транспорт, но сохраняет выбранную машину и ручное отключение.
   * Возврат создаёт новые соединения только после проверки срока аутентификации ключа.
   */
  public synchronized void suspend() {
    suspended = true;
    generations.replaceAll((id, generation) -> generation + 1);

    for (Runnable cancel : retries.values()) {
      cancel.run();
    }

    retries.clear();

    for (Transport transport : transports.values()) {
      closeTransport(transport);
    }

    transports.clear();
  }

  /**
   * Возврат из фона снимает приостановку, сохраняя ручной запрет соединения.
   * Просроченный доступ требует явной разблокировки вместо автоматического probe.
   */
  public synchronized void resume(boolean locked) throws Exception {
    suspended = false;

    if (store.selected != null && disabled.contains(store.selected)) {
      return;
    }

    if (locked && store.selected != null) {
      state.report(store.selected, "locked", null, null);
    } else if (store.selected != null && !disabled.contains(store.selected)) {
      connect(store.selected, false);
    }
  }

  /**
   * Закрытие оболочки делает поздние callbacks неактуальными.
   * Все таймеры и транспорты завершаются до освобождения runtime.
   */
  @Override
  public synchronized void close() {
    closed = true;
    suspend();
    state.changed();
  }
}
