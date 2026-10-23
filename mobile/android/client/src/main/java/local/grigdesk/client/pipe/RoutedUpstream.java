package local.grigdesk.client.pipe;

import java.io.InputStream;
import java.net.Socket;
import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.function.BiConsumer;
import javax.net.ssl.X509KeyManager;
import local.grigdesk.client.key.KeyFailure;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Профиль имеет одного владельца выбора пути и публикует только суммарную доступность.
 * Прикладной запрос передаётся ровно одному child; смена пути происходит только через hello.
 */
public final class RoutedUpstream implements PipeTransport {
  // Relay допускает полный серверный дозвон до 60 секунд и оба TLS-рукопожатия.
  // Прямой путь сохраняет прежний короткий deadline.
  private static final int RELAY_PROBE_TIMEOUT_SECONDS = 75;
  private static final Set<String> TERMINAL = Set.of("incompatible", "identityMismatch", "unpaired",
    "revoked", "locked");
  private final JSONObject profile;
  private final X509KeyManager keys;
  private final VersionGate version;
  private final BiConsumer<String, String> listener;
  private final Set<Child> children = ConcurrentHashMap.newKeySet();
  private final Object probeLock = new Object();
  private boolean probing;
  private volatile Child active;
  private volatile String terminal;
  // Отказ самого ретранслятора выключает только путь relay до нового транспорта ShellApi.
  private volatile String relayRefusal;
  private volatile String routeError = "offline";
  private volatile boolean closed;
  private volatile long generation;

  private static final class Child {
    Upstream pipe;
    RelayForwarder relay;
    String address;
    volatile String status;
    volatile String relayError;

    void close() {
      pipe.close();

      if (relay != null) {
        relay.close();
      }
    }
  }

  /**
   * Маршруты остаются в приватном профиле; ключ и защёлка общие для всех child.
   * Конструктор не создаёт отдельного scheduler и не запускает прикладной запрос.
   */
  public RoutedUpstream(JSONObject profile, X509KeyManager keys, VersionGate version,
    BiConsumer<String, String> listener) {
    this.profile = profile;
    this.keys = keys;
    this.version = version;
    this.listener = listener;
  }

  /**
   * Терминальный отказ любого актуального пути защёлкивает весь профиль.
   * Поздний success не снимает защёлку и не разрешает запасному пути обойти отзыв.
   */
  private synchronized void report(Child child, String status, String code) {
    if (closed || terminal != null) {
      return;
    }

    child.status = status;

    if (TERMINAL.contains(status)) {
      terminal = code == null ? status : code;
      generation++;
      listener.accept(status, terminal);

      for (Child item : children) {
        item.close();
      }
    }
  }

  /**
   * Ошибка наружного TLS классифицируется до закрытия inner stream.
   * Несовместимость, чужой сертификат и отвергнутый токен ретранслятора не касаются
   * сервера: у direct свой pin, поэтому выключается только путь relay с явной причиной.
   * Системные исключения и значения токенов не передаются в renderer.
   */
  private void relayFailure(Child child, Exception failure) {
    String code = failure.getMessage();
    String status = KeyFailure.status(failure);
    String refusal = null;

    if ("relay_upgrade_required".equals(code) || "relay_unauthorized".equals(code)) {
      refusal = code;
    } else if ("identityMismatch".equals(status)) {
      refusal = "relay_pin_mismatch";
    } else if (TERMINAL.contains(status)) {
      report(child, status, status);
    }

    if (refusal != null) {
      child.relayError = refusal;
      relayRefusal = refusal;
    }
  }

  /**
   * Новый child регистрируется до dial, чтобы suspend отменял также незавершённый TLS.
   * Нативный forwarder меняет только байтовый маршрут, оставляя серверный pin прежним.
   */
  private Child create(String address, boolean relay) throws Exception {
    Child child = new Child();

    child.address = address;

    if (relay) {
      child.relay = new RelayForwarder(profile.getJSONObject("relay"), error -> relayFailure(child, error));
    }

    child.pipe = new Upstream(relay ? child.relay.address() : address, profile.getString("fp"),
      keys, version, (status, code) -> report(child, status, code), relay ? RELAY_PROBE_TIMEOUT_SECONDS : 3);
    children.add(child);

    if (closed || terminal != null) {
      child.close();
    }

    return child;
  }

  /**
   * Старый single-address профиль читается как прямой маршрут без записи файла.
   * Новый relay-only профиль не получает фиктивный HTTPS-адрес.
   */
  private List<String> direct() throws Exception {
    JSONArray routes = profile.optJSONArray("direct");
    List<String> result = new ArrayList<>();

    if (routes != null) {
      for (int index = 0; index < routes.length(); index++) {
        JSONObject route = routes.getJSONObject(index);

        result.add("https://" + route.getString("host") + ":" + route.getInt("port"));
      }
    } else if (!profile.optString("address").isEmpty()) {
      result.add(profile.getString("address"));
    }

    return result;
  }

  /**
   * Неуспешный пробный direct не влияет на health уже работающего relay.
   * Успешный новый путь выбирается только для последующих действий, старый дренируется.
   */
  @Override
  public void probe() throws Exception {
    probe(false);
  }

  /**
   * Одно поколение выполняет один поиск пути, остальные запросы ждут его результат.
   * Блокировка не удерживается во время TLS: close и terminal могут отменять сокеты.
   */
  private void probe(boolean onlyIfMissing) throws Exception {
    boolean waited = false;

    synchronized (probeLock) {
      if (onlyIfMissing && active != null) {
        return;
      }

      if (probing) {
        while (probing && !closed && terminal == null) {
          probeLock.wait();
        }

        waited = true;
      } else {
        probing = true;
      }
    }

    // Итог публикуется вне probeLock: listener берёт замок ShellApi, а тот при переподключении
    // закрывает транспорт и сам ждёт probeLock — под замком это была бы взаимная блокировка.
    if (waited) {
      if (!onlyIfMissing) {
        publishCurrent();
      }

      return;
    }

    try {
      probeRoutes(!onlyIfMissing);
    } finally {
      synchronized (probeLock) {
        probing = false;
        probeLock.notifyAll();
      }
    }
  }

  /**
   * Перебор завершает один суммарный health-цикл без повтора прикладного запроса.
   * Отказ внешнего relay остаётся причиной только этого пути. Поиск, запущенный
   * прикладным запросом, сообщает только успех: его offline отменял бы плановый
   * повтор ShellApi, который создаёт новый транспорт и заново пробует relay.
   */
  private void probeRoutes(boolean publishOffline) throws Exception {
    long epoch = generation;
    String failure = relayRefusal != null ? relayRefusal : "offline";

    if (closed || terminal != null) {
      return;
    }

    List<String> routes = direct();

    if (profile.has("relay") && relayRefusal == null) {
      routes.add("relay");
    }

    for (String address : routes) {
      if (closed || terminal != null || generation != epoch) {
        return;
      }

      Child current = active;
      Child candidate = current != null && current.address.equals(address)
        ? current : create(address, address.equals("relay"));

      candidate.status = null;
      candidate.relayError = null;
      candidate.pipe.probe();

      if (closed || terminal != null || generation != epoch) {
        candidate.close();
        return;
      }

      if ("online".equals(candidate.status)) {
        active = candidate;

        if (current != null && current != candidate) {
          current.pipe.retire(() -> {
            if (current.relay != null) {
              current.relay.close();
            }

            children.remove(current);
          });
        }

        routeError = "offline";
        listener.accept("online", null);

        return;
      }

      if (candidate.relayError != null) {
        failure = candidate.relayError;
      }

      if (candidate != active) {
        candidate.close();
        children.remove(candidate);
      }
    }

    routeError = failure;

    if (publishOffline) {
      listener.accept("offline", failure);
    }
  }

  /**
   * Health-проба ShellApi, дождавшаяся чужого тихого поиска, обязана сообщить итог.
   * Иначе состояние connecting осталось бы без перехода и без планового повтора.
   */
  private void publishCurrent() {
    if (closed || terminal != null) {
      return;
    }

    if (active != null) {
      listener.accept("online", null);
    } else {
      listener.accept("offline", routeError);
    }
  }

  private Child selected() throws Exception {
    if (active == null && terminal == null && !closed) {
      probe(true);
    }

    return closed || terminal != null ? null : active;
  }

  @Override
  public PipeResponse forward(HttpHead head, InputStream body) throws Exception {
    Child child = selected();

    return child == null ? PipeResponse.error(503, terminal == null ? routeError : terminal)
      : child.pipe.forward(head, body);
  }

  @Override
  public void upgrade(HttpHead head, Socket downstream, InputStream input, ExecutorService pool)
    throws Exception {
    Child child = selected();

    if (child == null) {
      ClientPipe.write(downstream.getOutputStream(), head.method(),
        PipeResponse.error(503, terminal == null ? routeError : terminal), false);
      return;
    }

    child.pipe.upgrade(head, downstream, input, pool);
  }

  /**
   * Закрытие сначала делает все результаты probe неактуальными.
   * Затем отменяются активные и дренируемые пути, включая внешние TLS-сокеты.
   */
  @Override
  public void close() {
    closed = true;
    generation++;

    synchronized (probeLock) {
      probeLock.notifyAll();
    }

    for (Child child : children) {
      child.close();
    }

    children.clear();
    active = null;
  }
}
