package local.cockpit.mobile;

import android.app.KeyguardManager;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.UserNotAuthenticatedException;
import androidx.activity.result.ActivityResult;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.lifecycle.Lifecycle;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.journeyapps.barcodescanner.ScanIntentResult;
import com.journeyapps.barcodescanner.ScanOptions;
import java.io.File;
import java.io.FileDescriptor;
import java.nio.file.Files;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.SSLHandshakeException;
import local.cockpit.mobile.link.BrainClient;
import local.cockpit.mobile.link.DeviceKey;
import local.cockpit.mobile.link.DeviceKeyManager;
import local.cockpit.mobile.link.LinkStore;
import local.cockpit.mobile.link.LocalForwarder;
import local.cockpit.mobile.link.MediaCache;
import local.cockpit.mobile.link.NativeSession;
import local.cockpit.mobile.link.OutboxStore;
import local.cockpit.mobile.link.Pins;
import local.cockpit.mobile.link.QrPayload;
import local.cockpit.mobile.link.RelayDialer;
import local.cockpit.mobile.link.Routes;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Только этот мост владеет identity, биометрией, durable intent и всем сетевым lifecycle.
 * WebView получает публичное состояние и bounded ответы, но никогда ключи, пины или relay token.
 */
@CapacitorPlugin(name = "CockpitLink")
public final class CockpitLinkPlugin extends Plugin {

  private interface Work {
    JSObject run(long generation) throws Exception;
  }

  private final Object owner = new Object();
  private final Handler main = new Handler(Looper.getMainLooper());
  private final NativeSession session = new NativeSession(SystemClock::elapsedRealtime);
  private final DeviceKey key = new DeviceKey();
  private final ThreadPoolExecutor workers = new ThreadPoolExecutor(
    8,
    8,
    0,
    TimeUnit.SECONDS,
    new ArrayBlockingQueue<>(64),
    new ThreadPoolExecutor.AbortPolicy()
  );
  // Закрытие TLS шлёт close_notify в сеть: на main thread Android завершает процесс.
  private final ExecutorService closer = Executors.newSingleThreadExecutor();
  private LinkStore store;
  private JSONObject config;
  private LocalForwarder forwarder;
  private BrainClient client;
  private String networkState = "offline";
  private String loadError;
  private boolean revoked;
  private boolean eventsWanted;
  private boolean handedToInstaller;
  private Runnable deadline;
  private PluginCall authenticationCall;
  private Runnable authenticatedAction;
  private long authenticatedAt = -1;

  /**
   * Запуск читает только private store и всегда оставляет приложение заблокированным.
   * Повреждение файла показывается человеку; старый ключ и outbox сохраняются до явного reset.
   */
  @Override
  public void load() {
    LinkStore.useDirectorySync(directory -> {
      FileDescriptor descriptor = android.system.Os.open(
        directory.getPath(),
        android.system.OsConstants.O_RDONLY,
        0
      );

      try {
        android.system.Os.fsync(descriptor);
      } finally {
        android.system.Os.close(descriptor);
      }
    });
    store = new LinkStore(getContext().getFilesDir());

    try {
      config = store.read();
    } catch (Exception exception) {
      loadError = "Настройки повреждены. Отвяжите телефон и получите новый QR-код.";

      try {
        config = LinkStore.empty();
      } catch (Exception impossible) {
        throw new IllegalStateException("Не удалось подготовить состояние");
      }
    }

    MediaCache.clear(mediaDirectory());
    MediaCache.clear(updateDirectory());
  }

  @PluginMethod
  public void getState(PluginCall call) {
    synchronized (owner) {
      call.resolve(publicState());
    }
  }

  /**
   * Снимок содержит только отображаемые имена/адреса и текущий generation.
   * Секреты транспорта и сохранённый pair code остаются за нативной границей.
   */
  private JSObject publicState() {
    JSONArray relays = new JSONArray();
    JSONArray stored = config.optJSONArray("relays");
    String active = config.optString("activeRelayId", "");

    if (stored != null) {
      for (int index = 0; index < stored.length(); index += 1) {
        JSONObject relay = stored.optJSONObject(index);
        JSObject item = new JSObject()
          .put("id", relay.optString("id"))
          .put("name", relay.optString("name"))
          .put("host", relay.optString("host"))
          .put("port", relay.optInt("port"))
          .put("state", active.equals(relay.optString("id")) ? networkState : "offline");

        relays.put(item);
      }
    }

    JSObject result = new JSObject()
      .put("paired", config.optBoolean("paired"))
      .put("brainName", config.optString("brainName"))
      .put("deviceName", config.optString("deviceName"))
      .put("relays", relays)
      .put("activeRelayId", active.isEmpty() ? JSONObject.NULL : active)
      .put("unlocked", session.isUnlocked())
      .put("fontScale", getContext().getResources().getConfiguration().fontScale)
      .put("generation", session.generation())
      .put("revoked", revoked);

    if (!config.optString("deviceId").isEmpty()) {
      result.put("deviceId", config.optString("deviceId"));
    }
    if (loadError != null) {
      result.put("error", loadError);
    }

    return result;
  }

  @PluginMethod
  public void unlock(PluginCall call) {
    authenticate(call, () ->
      perform(call, true, generation -> {
        BrainClient current = transport(generation);

        finishPair(current, generation);

        return new JSObject();
      })
    );
  }

  /**
   * QR валидируется до любой записи и никогда не заменяет личность уже выбранного мозга.
   * Pending identity пишется до pair, поэтому потерянный ACK переиспользует прежний Keystore ключ.
   */
  @PluginMethod
  public void addFromText(PluginCall call) {
    final QrPayload qr;

    try {
      qr = QrPayload.parse(call.getString("text"));
    } catch (Exception exception) {
      call.reject("Неверный QR-код. Получите новый код в настройках Кокпита.");

      return;
    }

    perform(call, false, ignored -> {
      synchronized (owner) {
        if (loadError != null) {
          throw new IllegalStateException("store_corrupt");
        }
        if (config.optBoolean("paired")) {
          session.require(ignored);
        }

        String existing = config.optString("brainFp");

        if (!existing.isEmpty() && !existing.equals(qr.brain.getString("fp"))) {
          throw new IllegalArgumentException("other_brain");
        }
        if (!existing.isEmpty() && !key.exists()) {
          throw new IllegalStateException("key_lost");
        }

        key.ensure();

        JSONArray relays = config.getJSONArray("relays");
        boolean found = false;

        for (int index = 0; index < relays.length(); index += 1) {
          JSONObject relay = relays.getJSONObject(index);

          if (relay.getString("id").equals(qr.relay.getString("id"))) {
            if (!relay.getString("fp").equals(qr.relay.getString("fp"))) {
              throw new IllegalArgumentException("relay_pin_changed");
            }

            relays.put(index, qr.relay);
            found = true;
          }
        }

        if (!found) {
          relays.put(qr.relay);
        }

        config
          .put("brainName", qr.brain.getString("name"))
          .put("brainFp", qr.brain.getString("fp"))
          .put("deviceFp", Pins.sha256Hex(key.certificate().getEncoded()))
          .put("relays", relays);

        if (!config.optBoolean("paired") || config.isNull("activeRelayId")) {
          config.put("activeRelayId", qr.relay.getString("id"));

          if (qr.pair != null) {
            config.put("pair", qr.pair);
          }
        }

        store.save(config);
        emitState();
      }
      main.post(() ->
        authenticate(call, () ->
          perform(call, true, generation -> {
            finishPair(transport(generation), generation);

            return new JSObject();
          })
        )
      );

      return null;
    });
  }

  /**
   * Prompt допускает сильную биометрию или credential только на защищённом устройстве.
   * Успех после системного окна применяется при RESUMED с первоначальным monotonic временем.
   */
  private void authenticate(PluginCall call, Runnable success) {
    main.post(() -> {
      synchronized (owner) {
        if (authenticationCall != null) {
          call.reject("Подтверждение входа уже открыто.");

          return;
        }
        if (revoked || loadError != null) {
          call.reject(
            revoked ? "Телефон отозван. Отвяжите его и получите новый QR-код." : loadError
          );

          return;
        }

        try {
          if (
            config.optString("brainFp").isEmpty() ||
            !key.exists() ||
            !Pins.sha256Hex(key.certificate().getEncoded()).equals(config.optString("deviceFp"))
          ) {
            call.reject("Ключ телефона утрачен. Отвяжите телефон и получите новый QR-код.");

            return;
          }
        } catch (Exception exception) {
          call.reject("Ключ телефона недоступен. Отвяжите телефон и получите новый QR-код.");

          return;
        }

        int authenticators =
          BiometricManager.Authenticators.BIOMETRIC_STRONG |
          BiometricManager.Authenticators.DEVICE_CREDENTIAL;
        KeyguardManager keyguard = getContext().getSystemService(KeyguardManager.class);

        if (
          !keyguard.isDeviceSecure() ||
          BiometricManager.from(getContext()).canAuthenticate(authenticators) !=
            BiometricManager.BIOMETRIC_SUCCESS
        ) {
          call.reject("Настройте блокировку телефона: код или отпечаток пальца.");

          return;
        }

        authenticationCall = call;
        authenticatedAction = success;

        BiometricPrompt prompt = new BiometricPrompt(
          getActivity(),
          ContextCompat.getMainExecutor(getContext()),
          new BiometricPrompt.AuthenticationCallback() {
            @Override
            public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
              synchronized (owner) {
                if (authenticationCall != call) {
                  return;
                }

                authenticatedAt = SystemClock.elapsedRealtime();
              }
              finishAuthentication();
            }

            @Override
            public void onAuthenticationError(int code, CharSequence message) {
              synchronized (owner) {
                if (authenticationCall != call) {
                  return;
                }

                authenticationCall.reject("Вход не подтверждён.");
                authenticationCall = null;
                authenticatedAction = null;
                authenticatedAt = -1;
              }
            }
          }
        );

        prompt.authenticate(
          new BiometricPrompt.PromptInfo.Builder()
            .setTitle("Вход в Кокпит")
            .setSubtitle("Подтвердите доступ к мозгу")
            .setAllowedAuthenticators(authenticators)
            .build()
        );
      }
    });
  }

  /**
   * Новая сессия получает свежие pools и deadline, прежние callbacks уже отозваны.
   * Возврат из фонового окна сам по себе никогда не считается успешной аутентификацией.
   */
  private void finishAuthentication() {
    Runnable action;

    synchronized (owner) {
      if (
        authenticatedAt < 0 ||
        authenticationCall == null ||
        !getActivity().getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED)
      ) {
        return;
      }

      session.foreground();
      session.unlockAt(authenticatedAt);
      closeTransport();
      scheduleDeadline();
      action = authenticatedAction;
      authenticationCall = null;
      authenticatedAction = null;
      authenticatedAt = -1;
      emitState();
    }
    action.run();
  }

  /**
   * Transport создаётся под owner и остаётся действительным только в captured generation.
   * Нативные callbacks переходят на main queue и не захватывают owner под монитором BrainClient.
   */
  private BrainClient transport(long generation) throws Exception {
    synchronized (owner) {
      session.require(generation);

      if (client != null) {
        return client;
      }

      JSONObject relay = findRelay(config.optString("activeRelayId"));

      if (relay == null) {
        throw new IllegalStateException("no_relay");
      }

      networkState = "connecting";
      forwarder = new LocalForwarder(new RelayDialer(relay), session, generation, error -> {
        String code = errorCode(error);

        if ("pin_mismatch".equals(code)) {
          main.post(() -> applyNetworkState(code, generation));
        }
      });
      forwarder.start();
      client = new BrainClient(
        forwarder.port(),
        config.getString("brainFp"),
        new DeviceKeyManager(key),
        session,
        generation,
        SystemClock::elapsedRealtime,
        new BrainClient.Listener() {
          @Override
          public void event(String name, String data, long captured) {
            main.post(() -> {
              synchronized (owner) {
                if (session.isCurrent(captured)) {
                  notifyListeners(
                    "linkEvent",
                    new JSObject().put("name", name).put("data", data).put("generation", captured)
                  );
                }
              }
            });
          }

          @Override
          public void state(String state, long captured) {
            main.post(() -> applyNetworkState(state, captured));
          }
        }
      );

      if (eventsWanted && config.optBoolean("paired")) {
        client.startEvents();
      }

      emitState();

      return client;
    }
  }

  /**
   * Привязка сначала пытается hello с прежним cert; pair нужен только неизвестному телефону.
   * Durable paired пишется после подтверждения сервера, до ответа плагина экрану.
   */
  private void finishPair(BrainClient current, long generation) throws Exception {
    BrainClient.Result result = current.hello();
    JSONObject hello = new JSONObject(result.body);

    if (
      (result.status == 401 && "device_unknown".equals(hello.optString("error"))) ||
      (result.status == 200 && hello.isNull("device"))
    ) {
      JSONObject pair;
      String name;

      synchronized (owner) {
        session.require(generation);
        pair = config.optJSONObject("pair");
        name = config.getString("deviceName");
      }

      if (pair == null) {
        throw new IllegalStateException("new_qr_required");
      }

      result = current.pair(pair.getString("code"), name);

      if (result.status != 200 && result.status != 201) {
        throw new IllegalStateException("pair_failed");
      }

      result = current.hello();
      hello = new JSONObject(result.body);
    }
    if (result.status != 200 || hello.optInt("api") != 1 || hello.optJSONObject("device") == null) {
      throw new IllegalStateException(result.status == 403 ? "revoked" : "pair_failed");
    }

    synchronized (owner) {
      session.require(generation);

      JSONObject device = hello.getJSONObject("device");

      config
        .put("deviceId", device.getString("id"))
        .put("deviceName", device.getString("name"))
        .put("paired", true);
      config.remove("pair");
      store.save(config);
      networkState = "online";

      if (eventsWanted) {
        current.startEvents();
      }

      emitState();
    }
  }

  @PluginMethod
  public void selectRelay(PluginCall call) {
    perform(
      call,
      true,
      generation -> {
        long next;

        synchronized (owner) {
          session.require(generation);

          String id = call.getString("id", "");

          if (findRelay(id) == null) {
            throw new IllegalArgumentException("no_relay");
          }

          config.put("activeRelayId", id);
          store.save(config);
          next = session.rotate();
          closeTransport();
          emitState();
        }
        finishPair(transport(next), next);

        return new JSObject().put("generation", next);
      },
      true
    );
  }

  @PluginMethod
  public void removeRelay(PluginCall call) {
    perform(
      call,
      true,
      generation -> {
        synchronized (owner) {
          session.require(generation);

          String id = call.getString("id", "");
          boolean active = id.equals(config.optString("activeRelayId"));

          store.removeRelay(id);
          config = store.read();

          if (active) {
            session.rotate();
            closeTransport();
          }

          emitState();
        }

        return new JSObject();
      },
      true
    );
  }

  /**
   * POST intent хранится атомарно до первого HTTP и сохраняет key/body/time при каждом повторе.
   * Ответ содержит своё generation; старый transport не может вернуть данные новой сессии.
   */
  @PluginMethod
  public void request(PluginCall call) {
    final long generation;

    synchronized (owner) {
      generation = session.generation();
    }

    try {
      workers.execute(() -> {
        try {
          String method = call.getString("method", "");
          String path = call.getString("path", "");
          String body = call.getString("body", "{}");
          String idempotencyKey = call.getString("idempotencyKey");
          long createdAt = exactLong(call.getData().opt("createdAt"));

          if (!Routes.allowed(method, path)) {
            throw new IllegalArgumentException("bad_route");
          }

          synchronized (owner) {
            session.require(generation);

            if ("POST".equals(method)) {
              outbox().put(
                new JSONObject()
                  .put("method", method)
                  .put("path", path)
                  .put("body", body)
                  .put("idempotencyKey", idempotencyKey)
                  .put("createdAt", createdAt)
              );
            }
          }

          BrainClient.Result response = transport(generation).request(
            method,
            path,
            body,
            idempotencyKey,
            createdAt
          );

          synchronized (owner) {
            session.require(generation);
            call.resolve(
              new JSObject()
                .put("status", response.status)
                .put("body", response.body)
                .put("generation", generation)
            );
          }
        } catch (Exception exception) {
          String code = errorCode(exception);

          if ("locked".equals(code) || "key_lost".equals(code) || "pin_mismatch".equals(code)) {
            main.post(() -> applyNetworkState(code, generation));
          }

          call.resolve(
            new JSObject()
              .put("status", 0)
              .put("body", new JSObject().put("error", code).toString())
              .put("generation", generation)
          );
        }
      });
    } catch (Exception exception) {
      call.resolve(
        new JSObject()
          .put("status", 0)
          .put("body", "{\"error\":\"network\"}")
          .put("generation", generation)
      );
    }
  }

  @PluginMethod
  public void getOutbox(PluginCall call) {
    perform(call, true, generation -> {
      synchronized (owner) {
        session.require(generation);

        return new JSObject().put("items", outbox().read());
      }
    });
  }

  @PluginMethod
  public void putOutbox(PluginCall call) {
    perform(call, true, generation -> {
      synchronized (owner) {
        session.require(generation);
        outbox().put(call.getObject("item"));
      }

      return new JSObject();
    });
  }

  @PluginMethod
  public void removeOutbox(PluginCall call) {
    perform(call, true, generation -> {
      synchronized (owner) {
        session.require(generation);
        outbox().remove(call.getString("idempotencyKey", ""));
      }

      return new JSObject();
    });
  }

  private OutboxStore outbox() throws Exception {
    return new OutboxStore(
      getContext().getFilesDir(),
      config.getString("brainFp"),
      Pins.sha256Hex(key.certificate().getEncoded())
    );
  }

  @PluginMethod
  public void startEvents(PluginCall call) {
    perform(call, true, generation -> {
      synchronized (owner) {
        session.require(generation);
        eventsWanted = true;
        transport(generation).startEvents();
      }

      return new JSObject();
    });
  }

  @PluginMethod
  public void stopEvents(PluginCall call) {
    synchronized (owner) {
      eventsWanted = false;

      if (client != null) {
        client.stopEvents();
      }

      call.resolve();
    }
  }

  /**
   * Загрузка работает в захваченном поколении и публикует только локальный путь WebView.
   * Lock отменяет работу и удаляет кэш, сохраняя поздний callback вне нового экрана.
   */
  @PluginMethod
  public void fetchMedia(PluginCall call) {
    perform(call, true, generation -> {
      String device;

      synchronized (owner) {
        session.require(generation);
        device = config.getString("deviceId");
      }

      try {
        File file = transport(generation).media(
          mediaDirectory(),
          device,
          call.getString("chatId", ""),
          call.getString("ref", "")
        );

        return new JSObject().put("path", file.getPath());
      } catch (Exception exception) {
        String code = errorCode(exception);

        if ("locked".equals(code) || "pin_mismatch".equals(code)) {
          throw exception;
        }

        return new JSObject().put("error", code);
      }
    });
  }

  /**
   * Установщику передаётся только APK с проверенным SHA256 и ограниченным размером.
   * Настройка неизвестных источников открывается явно; после возврата нужна новая биометрия.
   */
  @PluginMethod
  public void downloadUpdate(PluginCall call) {
    perform(call, true, generation -> {
      File file = transport(generation).downloadUpdate(updateDirectory());

      main.post(() -> {
        synchronized (owner) {
          if (!session.isCurrent(generation)) {
            file.delete();
            call.reject("Приложение заблокировано.");

            return;
          }
          if (!getContext().getPackageManager().canRequestPackageInstalls()) {
            file.delete();
            getActivity().startActivity(
              new Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + getContext().getPackageName())
              )
            );
            call.reject("Разрешите установку для Кокпита, затем повторите проверку обновления.");

            return;
          }

          try {
            Uri uri = FileProvider.getUriForFile(
              getContext(),
              getContext().getPackageName() + ".fileprovider",
              file
            );
            Intent intent = new Intent(Intent.ACTION_VIEW)
              .setDataAndType(uri, "application/vnd.android.package-archive")
              .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

            handedToInstaller = true;
            getActivity().startActivity(intent);
            call.resolve();
          } catch (Exception exception) {
            handedToInstaller = false;
            file.delete();
            call.reject("Не удалось открыть установщик Android.");
          }
        }
      });

      return null;
    });
  }

  @PluginMethod
  public void scanQr(PluginCall call) {
    main.post(() -> {
      ScanOptions options = new ScanOptions()
        .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
        .setPrompt("Наведите камеру на QR-код Кокпита")
        .setBeepEnabled(false)
        .setBarcodeImageEnabled(false)
        .setOrientationLocked(false);

      startActivityForResult(call, options.createScanIntent(getContext()), "onScanResult");
    });
  }

  /**
   * Результат сканера проверяется тем же строгим QR decoder до изменения привязки.
   * Отмена камеры не создаёт посредника и не передаёт пустой payload в pair.
   */
  @ActivityCallback
  private void onScanResult(PluginCall call, ActivityResult result) {
    if (call == null) {
      return;
    }

    ScanIntentResult scanned = ScanIntentResult.parseActivityResult(
      result.getResultCode(),
      result.getData()
    );
    String text = scanned.getContents();

    if (text == null) {
      call.resolve(new JSObject().put("text", ""));

      return;
    }

    try {
      QrPayload.parse(text);
      call.resolve(new JSObject().put("text", text));
    } catch (Exception exception) {
      call.reject("Неверный QR-код. Получите код в настройках Кокпита.");
    }
  }

  /**
   * Reset сначала отзывает поколение и сеть, затем удаляет собственные файлы и Keystore alias.
   * Старый callback не создаёт файл после очистки и не восстанавливает прежнюю привязку.
   */
  @PluginMethod
  public void resetDevice(PluginCall call) {
    perform(call, false, ignored -> {
      synchronized (owner) {
        lock(false);
        key.delete();
        store.delete();
        Files.deleteIfExists(new File(getContext().getFilesDir(), "outbox.json").toPath());
        Files.deleteIfExists(new File(getContext().getFilesDir(), "outbox.json.tmp").toPath());
        Files.deleteIfExists(new File(getContext().getFilesDir(), "link.json.tmp").toPath());
        MediaCache.clear(updateDirectory());
        config = LinkStore.empty();
        revoked = false;
        loadError = null;
        eventsWanted = false;
        emitState();
      }

      return new JSObject();
    });
  }

  private void perform(PluginCall call, boolean gated, Work work) {
    perform(call, gated, work, false);
  }

  /**
   * Работа захватывает generation при поступлении, а не после ожидания очереди worker.
   * Publication ответа синхронизируется с lifecycle; специальные смены транспорта проверяют новый gate.
   */
  private void perform(PluginCall call, boolean gated, Work work, boolean rotates) {
    final long captured;

    synchronized (owner) {
      captured = session.generation();
    }

    try {
      workers.execute(() -> {
        try {
          if (gated) {
            session.require(captured);
          }

          JSObject result = work.run(captured);

          synchronized (owner) {
            if (gated) {
              if (rotates) {
                session.capture();
              } else {
                session.require(captured);
              }
            }
            if (result != null) {
              call.resolve(result);
            }
          }
        } catch (Exception exception) {
          String code = errorCode(exception);

          if (
            "key_lost".equals(code) ||
            "locked".equals(code) ||
            "pin_mismatch".equals(code) ||
            "revoked".equals(code)
          ) {
            main.post(() -> applyNetworkState(code, captured));
          }

          call.reject(errorText(code));
        }
      });
    } catch (Exception exception) {
      call.reject("Слишком много запросов. Повторите позже.");
    }
  }

  /**
   * Deadline закрывает даже idle sockets, не ожидая следующего запроса или heartbeat.
   * При смене relay срок остаётся тем же; callback принадлежит единственному owner.
   */
  private void scheduleDeadline() {
    if (deadline != null) {
      main.removeCallbacks(deadline);
    }

    deadline = () -> {
      synchronized (owner) {
        if (session.remaining() > 0) {
          main.postDelayed(deadline, session.remaining());
        } else {
          lock(false);
        }
      }
    };
    main.postDelayed(deadline, session.remaining());
  }

  private void emitState() {
    JSObject state = publicState().put("state", networkState);

    notifyListeners("linkState", state);
  }

  /**
   * Поиск возвращает запись только по устойчивому id сохранённого посредника.
   * Отсутствие записи не подменяется другим адресом или неявным выбором.
   */
  private JSONObject findRelay(String id) {
    JSONArray relays = config.optJSONArray("relays");

    for (int index = 0; relays != null && index < relays.length(); index += 1) {
      JSONObject relay = relays.optJSONObject(index);

      if (id.equals(relay.optString("id"))) {
        return relay;
      }
    }

    return null;
  }

  /**
   * Callback проверяет captured generation перед изменением состояния или очисткой.
   * Auth/pin/contract ошибки прекращают весь нативный транспорт до явного unlock.
   */
  private void applyNetworkState(String state, long captured) {
    synchronized (owner) {
      if (captured != session.generation()) {
        return;
      }
      if (
        "revoked".equals(state) || ("device_unknown".equals(state) && config.optBoolean("paired"))
      ) {
        revoked = true;
        lock(false);
      } else if (
        "locked".equals(state) ||
        "key_lost".equals(state) ||
        "contract".equals(state) ||
        "pin_mismatch".equals(state)
      ) {
        lock(false);
      } else {
        networkState = state;
      }

      emitState();
    }
  }

  /**
   * Все forwarder, REST/SSE pools и соединения принадлежат одной нативной сессии.
   * Ссылки снимаются сразу, до транспорта следующего поколения, а сокеты закрывает
   * отдельный поток: lock с main thread (фон, срок, отзыв) иначе падал на сетевой записи TLS.
   */
  private void closeTransport() {
    LocalForwarder closingForwarder = forwarder;
    BrainClient closingClient = client;

    forwarder = null;
    client = null;
    networkState = "offline";

    if (closingForwarder == null && closingClient == null) {
      return;
    }

    // Поколение уже закрыто: сбой уборки старого сокета не должен завершать процесс приложения.
    Runnable close = () -> {
      try {
        if (closingForwarder != null) {
          closingForwarder.close();
        }
      } catch (RuntimeException ignored) {
        // Пересыльщик старого поколения больше не принимает новых пар.
      }
      try {
        if (closingClient != null) {
          closingClient.close();
        }
      } catch (RuntimeException ignored) {
        // Клиент старого поколения отклоняет запросы проверкой generation.
      }
    };

    try {
      closer.execute(close);
    } catch (RejectedExecutionException stopped) {
      new Thread(close, "cockpit-link-close").start();
    }
  }

  /**
   * Общий lock отзывает TLS/pools, медиа и временный APK под барьером generation.
   * Durable outbox сохраняется; APK, уже переданный установщику, живёт до возврата в приложение.
   */
  private void lock(boolean background) {
    synchronized (session) {
      if (background) {
        session.background();
      } else {
        session.lock();
      }

      MediaCache.clear(mediaDirectory());

      if (!handedToInstaller) {
        MediaCache.clear(updateDirectory());
      } else {
        new File(updateDirectory(), "download.tmp").delete();
      }
    }
    closeTransport();

    if (deadline != null) {
      main.removeCallbacks(deadline);
      deadline = null;
    }

    emitState();
  }

  boolean canReadMedia() {
    return session.isUnlocked();
  }

  /**
   * Каждое чтение WebView файла проходит captured generation, включая уже открытый stream.
   * После lock даже сохранённый FileDescriptor не возвращает новые байты прежнего изображения.
   */
  java.io.InputStream openMedia(File file) throws Exception {
    synchronized (owner) {
      long captured = session.capture();
      java.io.InputStream input = new java.io.FileInputStream(file);

      return new java.io.FilterInputStream(input) {
        @Override
        public int read() throws java.io.IOException {
          try {
            session.require(captured);

            int value = super.read();

            session.require(captured);

            return value;
          } catch (IllegalStateException exception) {
            close();

            throw new java.io.IOException("locked");
          }
        }

        @Override
        public int read(byte[] buffer, int offset, int length) throws java.io.IOException {
          try {
            session.require(captured);

            int count = in.read(buffer, offset, length);

            session.require(captured);

            return count;
          } catch (IllegalStateException exception) {
            close();

            throw new java.io.IOException("locked");
          }
        }
      };
    }
  }

  File mediaDirectory() {
    return new File(getContext().getCacheDir(), "media");
  }

  private File updateDirectory() {
    return new File(getContext().getCacheDir(), "updates");
  }

  /**
   * JSON timestamp принимается только как точное целое без округления и строковой подмены.
   * Некорректное значение не получает новый срок действия durable операции.
   */
  private static long exactLong(Object value) {
    if (value == null) {
      return 0;
    }
    if (
      !(value instanceof Number) ||
      ((Number) value).doubleValue() != ((Number) value).longValue() ||
      ((Number) value).longValue() < 0
    ) {
      throw new IllegalArgumentException("bad_operation");
    }

    return ((Number) value).longValue();
  }

  /**
   * Ошибки возвращаются только из фиксированного словаря, без stack/сертификата/QR.
   * Keystore auth и invalidation различаются, software fallback отсутствует.
   */
  private static String errorCode(Throwable error) {
    if (BrainClient.hasCause(error, KeyPermanentlyInvalidatedException.class)) {
      return "key_lost";
    }
    if (BrainClient.hasCause(error, UserNotAuthenticatedException.class)) {
      return "locked";
    }
    if (BrainClient.hasCause(error, java.security.cert.CertificateException.class)) {
      return "pin_mismatch";
    }

    String message = error.getMessage();

    return message != null &&
      message.matches(
        "locked|revoked|key_lost|no_relay|other_brain|" +
          "relay_pin_changed|store_corrupt|pair_failed|new_qr_required|bad_route|bad_operation|" +
          "outbox_full|outbox_corrupt|idempotency_conflict|media_busy|media_type|media_too_large|" +
          "media_not_found|media_outside_workspace|media_forbidden|no_apk|apk_mismatch|contract"
      )
      ? message
      : "network";
  }

  private static String errorText(String code) {
    switch (code) {
      case "locked":
        return "Приложение заблокировано. Подтвердите вход.";
      case "key_lost":
        return "Ключ телефона утрачен. Отвяжите телефон и получите новый QR-код.";
      case "other_brain":
        return "Это другой мозг. Сначала отвяжите текущий телефон.";
      case "relay_pin_changed":
        return "Пин посредника изменился. Удалите его и добавьте новый QR-код.";
      case "pin_mismatch":
        return "Пин сервера не совпадает. Проверьте QR-код в Кокпите.";
      case "no_relay":
        return "Выберите или добавьте посредника.";
      case "new_qr_required":
        return "Нужен новый QR-код для привязки телефона.";
      case "pair_failed":
        return "Привязка не завершена. Получите новый QR-код и повторите.";
      case "outbox_full":
        return "Очередь заполнена: не больше 100 операций и 2 МиБ.";
      case "outbox_corrupt":
        return "Очередь повреждена. Отвяжите телефон после проверки истории в Кокпите.";
      case "no_apk":
        return "Обновление ещё не опубликовано на мозге.";
      case "apk_mismatch":
        return "Файл обновления не прошёл проверку. Повторите после новой публикации.";
      case "store_corrupt":
        return "Настройки повреждены. Отвяжите телефон и получите новый QR-код.";
      case "revoked":
        return "Телефон отозван в Кокпите.";
      default:
        return "Связь недоступна. Проверьте посредника и повторите.";
    }
  }

  @Override
  protected void handleOnPause() {
    synchronized (owner) {
      lock(true);
    }
  }

  @Override
  protected void handleOnResume() {
    synchronized (owner) {
      session.foreground();

      if (handedToInstaller) {
        handedToInstaller = false;
        MediaCache.clear(updateDirectory());
      }

      emitState();
    }
    main.post(this::finishAuthentication);
  }

  @Override
  protected void handleOnDestroy() {
    synchronized (owner) {
      lock(true);

      if (authenticationCall != null) {
        authenticationCall.reject("Вход отменён.");
      }

      authenticationCall = null;
      authenticatedAction = null;
      authenticatedAt = -1;
    }
    workers.shutdownNow();
    closer.shutdown();
  }
}
