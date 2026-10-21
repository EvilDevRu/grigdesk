package local.grigdesk.client;

import android.content.Context;
import java.io.File;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.BiConsumer;
import local.grigdesk.client.key.DeviceKey;
import local.grigdesk.client.key.DeviceKeyManager;
import local.grigdesk.client.pipe.ClientPipe;
import local.grigdesk.client.pipe.StaticAssets;
import local.grigdesk.client.pipe.Upstream;
import local.grigdesk.client.shell.Pairing;
import local.grigdesk.client.shell.ProfileStore;
import local.grigdesk.client.shell.ShellApi;
import org.json.JSONObject;

public final class ClientRuntime implements AutoCloseable {
  public final ShellApi shell;
  private final Context context;
  private final String secret;
  private final Set<String> origins;
  private final BiConsumer<String, Boolean> navigate;
  private final StaticAssets assets;
  private final ProfileStore profiles;
  private final Map<String, ClientPipe> pipes = new HashMap<>();
  private final Map<String, Integer> originalPorts = new HashMap<>();
  private final ExecutorService worker = Executors.newFixedThreadPool(3);
  private final ScheduledExecutorService timers = Executors.newSingleThreadScheduledExecutor();

  /**
   * Runtime принадлежит установке приложения и обслуживает все origin машин.
   * Встроенные assets проверяются до открытия WebView, сервер не отдаёт интерфейс.
   */
  public ClientRuntime(Context context, String secret, Set<String> origins, ShellApi.Native nativeActions,
    BiConsumer<String, Boolean> navigate) throws Exception {
    this.context = context.getApplicationContext();
    this.secret = secret;
    this.origins = origins;
    this.navigate = navigate;
    assets = new StaticAssets(new StaticAssets.Source() {
      public InputStream open(String path) throws java.io.IOException {
        return context.getAssets().open("ui/" + path);
      }
      public java.util.Collection<String> files() throws java.io.IOException {
        List<String> result = new ArrayList<>();

        inventory("", result);
        return result;
      }
    }, ClientLocale.initialize(context).text("native.installation_corrupt"));

    JSONObject api = new JSONObject(StaticAssets.readText(
      context.getAssets().open("ui/api-version.json"), 1024));
    int major = api.getInt("major");
    int minor = api.getInt("minor");

    profiles = new ProfileStore(new File(context.getFilesDir(), "client-profiles.json"),
      ClientRuntime::available, ClientLocale.initialize(context));

    for (JSONObject profile : profiles.profiles) {
      originalPorts.put(profile.getString("id"), profile.getInt("port"));
    }

    DeviceKey key = new DeviceKey();
    Pairing.Keys keys = () -> {
      if (!key.exists()) {
        throw new local.grigdesk.client.key.MissingDeviceKeyException();
      }

      return new DeviceKeyManager(key);
    };
    Pairing pairing = new Pairing(profiles, () -> {
      key.ensure();
      return keys.get();
    }, major, minor, ClientLocale.initialize(context));

    shell = new ShellApi(profiles, pairing, (profile, gate, report) -> {
      Upstream transport = new Upstream(profile.getString("address"), profile.getString("fp"), keys.get(),
        gate, report::accept);

      return new ShellApi.Transport() {
        public void probe() throws Exception {
          transport.probe();
        }
        public void close() {
          transport.close();
        }
        public Upstream pipe() {
          return transport;
        }
      };
    }, (callback, delay) -> {
      java.util.concurrent.ScheduledFuture<?> future = timers.schedule(
        callback, delay, TimeUnit.MILLISECONDS);

      return () -> future.cancel(false);
    }, worker::execute, this::show, nativeActions, Math::random, major, minor,
      ClientLocale.initialize(context));
  }

  /**
   * Инвентарь assets перечисляет файлы рекурсивно относительно корня пакета UI.
   * Проверка манифеста получает полный список до загрузки первого документа.
   */
  private void inventory(String path, List<String> result) throws java.io.IOException {
    String[] children = context.getAssets().list("ui" + (path.isEmpty() ? "" : "/" + path));

    if (children == null || children.length == 0) {
      if (!path.isEmpty()) {
        result.add(path);
      }
      return;
    }

    for (String child : children) {
      inventory(path.isEmpty() ? child : path + "/" + child, result);
    }
  }

  private static boolean available(int port) {
    try (ServerSocket socket = new ServerSocket(port, 1, InetAddress.getByName("127.0.0.1"))) {
      return true;
    } catch (Exception exception) {
      return false;
    }
  }

  /**
   * Каждая машина получает отдельную трубу; свободный порт сохраняется до навигации.
   * Новый или перемещённый origin очищается до первой загрузки, исключая чужой старый вид.
   */
  public synchronized void show(String id) {
    String key = id == null ? "" : id;

    try {
      for (String existing : new ArrayList<>(pipes.keySet())) {
        if (!existing.isEmpty() && profiles.profiles.stream()
          .noneMatch(profile -> profile.optString("id").equals(existing))) {
          ClientPipe removed = pipes.remove(existing);

          origins.remove("http://127.0.0.1:" + removed.port());
          removed.close();
        }
      }

      boolean reset = false;
      ClientPipe pipe = pipes.get(key);

      if (pipe == null) {
        int port = id == null ? 47100 : profiles.claimPort(id);

        pipe = new ClientPipe(port, secret, assets, () -> id == null ? null : shell.upstream(id),
          shell, () -> id == null ? "none" : shell.state.status(id));
        pipes.put(key, pipe);
        reset = id != null && !Integer.valueOf(port).equals(originalPorts.get(id));
        originalPorts.put(id, port);
      }

      String origin = "http://127.0.0.1:" + pipe.port();

      origins.add(origin);
      navigate.accept(origin, reset);
    } catch (Exception exception) {
      throw new IllegalStateException(ClientLocale.text("interfaceFailure"), exception);
    }
  }

  /**
   * Интерфейс открывается независимо от состояния удалённого сервера.
   * Если запуск завершился уже в фоне, соединения остаются остановленными до возврата.
   */
  public void start(boolean foreground) {
    show(profiles.selected);

    if (foreground) {
      shell.connect(profiles.selected, true);
    } else {
      shell.suspend();
    }
  }

  /**
   * Завершение установки закрывает оболочку перед локальными слушателями.
   * Работники выполняют очередь освобождения TLS до завершения своего пула.
   */
  @Override
  public void close() {
    shell.close();

    for (ClientPipe pipe : pipes.values()) {
      pipe.close();
    }

    worker.shutdown();
    timers.shutdownNow();
  }
}
