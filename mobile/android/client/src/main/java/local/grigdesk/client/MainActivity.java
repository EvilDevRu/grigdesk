package local.grigdesk.client;

import android.Manifest;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

public class MainActivity extends AppCompatActivity {
  private static final int FILE_REQUEST = 1201;
  private static final int AUDIO_REQUEST = 1202;
  private static final int CAMERA_REQUEST = 1203;
  private static volatile java.lang.ref.WeakReference<MainActivity> current =
    new java.lang.ref.WeakReference<>(null);
  private static final PendingNavigation navigation = new PendingNavigation();
  private static volatile String startupFailure;
  private static volatile ClientRuntime runtime;
  private static java.util.concurrent.CompletableFuture<String> scanning;
  private androidx.biometric.BiometricPrompt unlockPrompt;
  private static final String ENTRY = "http://127.0.0.1:47100";
  private static final Set<String> ORIGINS = ConcurrentHashMap.newKeySet();
  private static final String SECRET = createSecret();
  private final WebPolicy policy = new WebPolicy(ORIGINS);
  private WebView web;
  // WebView принадлежит процессу, чтобы поворот не перегружал документ и активные POST.
  // MutableContextWrapper переключается на applicationContext в onDestroy, Activity не удерживается.
  @android.annotation.SuppressLint("StaticFieldLeak")
  private static WebView retainedWeb;
  // Обёртка переносит один WebView между Activity; после уничтожения владельца хранит только приложение.
  // Удержание намеренно до конца процесса и не расширяет срок жизни закрытой Activity.
  @android.annotation.SuppressLint("StaticFieldLeak")
  private static android.content.MutableContextWrapper webContext;
  private static volatile boolean starting;
  private static PermissionRequest audio;
  private static ValueCallback<Uri[]> files;

  /**
   * Секрет создаётся один раз на процесс и разделяется всеми origin установки.
   * Случайные байты не записываются в WebView или хранилище профилей.
   */
  private static String createSecret() {
    byte[] bytes = new byte[32];

    new SecureRandom().nextBytes(bytes);

    return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
  }

  /**
   * WebView получает только локальный документ трубы без нативного JS-моста.
   * Cookie ставится асинхронно до первой загрузки и остаётся HttpOnly.
   */
  @Override
  public void onCreate(Bundle state) {
    super.onCreate(state);
    current = new java.lang.ref.WeakReference<>(this);
    attachUnlockPrompt();
    ORIGINS.add(ENTRY);
    if (retainedWeb == null) {
      webContext = new android.content.MutableContextWrapper(this);
      retainedWeb = new WebView(webContext);
    }

    web = retainedWeb;
    webContext.setBaseContext(this);

    if (web.getParent() instanceof android.view.ViewGroup) {
      ((android.view.ViewGroup) web.getParent()).removeView(web);
    }

    setContentView(web);

    WebSettings settings = web.getSettings();

    // Встроенный Vue-интерфейс требует JS; WebView доверяет только origin локальных труб.
    // File/content access, mixed content и нативный JS-мост запрещены отдельной политикой.
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(false);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    settings.setSupportMultipleWindows(false);
    settings.setTextZoom(100);
    WebView.setWebContentsDebuggingEnabled(
      (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0
    );
    web.setWebViewClient(new Navigation());
    web.setWebChromeClient(new NativeActions());
    getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
      @Override
      public void handleOnBackPressed() {
        web.evaluateJavascript("Boolean(window.grigdeskBack?.())", result -> {
          if (!"true".equals(result)) {
            moveTaskToBack(true);
          }
        });
      }
    });

    PendingNavigation.Entry waiting = navigation.peek();

    if (waiting != null) {
      showOrigin(waiting);
    }

    if (startupFailure != null) {
      showStartupFailure();
    }

    synchronized (MainActivity.class) {
      if (starting || runtime != null) {
        return;
      }

      starting = true;
    }

    new Thread(() -> {
      try {
        if (runtime == null) {
          runtime = new ClientRuntime(getApplicationContext(), SECRET, ORIGINS,
            new AndroidActions(getApplicationContext(), () -> current.get()), (origin, reset) -> {
              PendingNavigation.Entry entry = navigation.put(origin, reset);
              MainActivity visible = current.get();

              if (visible != null) {
                visible.showOrigin(entry);
              }
            });
        }

        runtime.start(!((ClientApplication) getApplication()).lifecycle.isBackground());
      } catch (Exception exception) {
        startupFailure = ClientLocale.text("startupFailure");
        MainActivity visible = current.get();

        if (visible != null) {
          visible.showStartupFailure();
        }
      } finally {
        starting = false;
      }
    }, "grigdesk-client-start").start();
  }

  /**
   * Секрет хоста ставится до документа; новый origin получает чистые настройки вида.
   * Смена машины заменяет документ целиком и не смешивает его хранилище с предыдущим.
   */
  private void showOrigin(PendingNavigation.Entry entry) {
    runOnUiThread(() -> {
      if (isDestroyed() || current.get() != this || navigation.peek() != entry) {
        return;
      }

      if (entry.reset) {
        android.webkit.WebStorage.getInstance().deleteOrigin(entry.origin);
      }

      CookieManager cookies = CookieManager.getInstance();

      cookies.setAcceptCookie(true);
      cookies.setAcceptThirdPartyCookies(web, false);
      cookies.setCookie("http://127.0.0.1", "grigdesk_pipe=" + SECRET
        + "; Path=/; HttpOnly; SameSite=Strict", accepted -> {
          if (Boolean.TRUE.equals(accepted) && !isDestroyed() && current.get() == this
            && navigation.take(entry)) {
            web.loadUrl(entry.origin + "/");
          }
        });
    });
  }

  /**
   * Отказ старта показывается действующей Activity, даже если прежняя уже уничтожена.
   * Состояние сохраняется на промежуток поворота, исключая пустой белый экран.
   */
  private void showStartupFailure() {
    runOnUiThread(() -> {
      if (!isDestroyed() && current.get() == this) {
        android.widget.TextView error = new android.widget.TextView(this);

        error.setText(startupFailure);
        setContentView(error);
      }
    });
  }

  /**
   * Сканирование принадлежит текущей Activity и завершается единственным результатом.
   * Системное разрешение камеры учитывается как собственный нативный переход.
   */
  public java.util.concurrent.CompletableFuture<String> scan() {
    java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();

    runOnUiThread(() -> {
      if (scanning != null) {
        result.completeExceptionally(new IllegalStateException(ClientLocale.text("scannerOpen")));
        return;
      }

      scanning = result;
      ((ClientApplication) getApplication()).nativeFlow(true);

      if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
        openScanner();
      } else {
        requestPermissions(new String[] { Manifest.permission.CAMERA }, CAMERA_REQUEST);
      }
    });

    return result;
  }

  /**
   * Сканер принимает только QR и возвращает строку через результат Activity.
   * Ориентация остаётся свободной, чтобы планшет не менял положение принудительно.
   */
  private void openScanner() {
    com.google.zxing.integration.android.IntentIntegrator scanner =
      new com.google.zxing.integration.android.IntentIntegrator(this);

    scanner.setCaptureActivity(ScannerActivity.class);
    scanner.setDesiredBarcodeFormats(com.google.zxing.integration.android.IntentIntegrator.QR_CODE);
    scanner.setBeepEnabled(false);
    scanner.setOrientationLocked(false);
    scanner.setPrompt(ClientLocale.text("scanPrompt"));
    startActivityForResult(scanner.createScanIntent(),
      com.google.zxing.integration.android.IntentIntegrator.REQUEST_CODE);
  }

  /**
   * AndroidX переносит системный диалог при повороте, но требует новый callback в onCreate.
   * Результат принадлежит приложению, поэтому новая Activity завершает прежний запрос.
   */
  private void attachUnlockPrompt() {
    UnlockSession session = ((ClientApplication) getApplication()).unlockSession;

    unlockPrompt = new androidx.biometric.BiometricPrompt(this, getMainExecutor(),
      new androidx.biometric.BiometricPrompt.AuthenticationCallback() {
        @Override
        public void onAuthenticationSucceeded(
          @NonNull androidx.biometric.BiometricPrompt.AuthenticationResult authentication) {
          session.succeeded();
        }

        @Override
        public void onAuthenticationError(int code, @NonNull CharSequence message) {
          session.failed(new IllegalStateException(ClientLocale.text("unlockCancelled")));
        }
      });
  }

  /**
   * Сильная биометрия и код устройства разрешают использование Keystore на 600 секунд.
   * Повторное нажатие присоединяется к текущему запросу вместо ошибки «уже открыта».
   */
  public java.util.concurrent.CompletableFuture<Void> unlock() {
    java.util.concurrent.CompletableFuture<Void> result = new java.util.concurrent.CompletableFuture<>();

    runOnUiThread(() -> {
      MainActivity visible = current.get();

      if (visible == null || visible.isFinishing() || visible.isDestroyed()
        || visible.getSupportFragmentManager().isStateSaved()) {
        result.completeExceptionally(new IllegalStateException(ClientLocale.text("unlockCancelled")));

        return;
      }

      UnlockSession session = ((ClientApplication) getApplication()).unlockSession;

      session.request(() -> visible.unlockPrompt.authenticate(
        new androidx.biometric.BiometricPrompt.PromptInfo.Builder()
          .setTitle(ClientLocale.text("unlockTitle"))
          .setAllowedAuthenticators(androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
            | androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL).build()
      )).whenComplete((value, failure) -> {
        if (failure == null) {
          result.complete(null);
        } else {
          result.completeExceptionally(failure);
        }
      });
    });

    return result;
  }

  /**
   * Внешняя навигация требует явного жеста в главном фрейме и метода GET.
   * Файловые схемы и автоматические перенаправления не передаются другой Activity.
   */
  private final class Navigation extends WebViewClient {
    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
      String url = request.getUrl().toString();

      if (policy.navigation(url)) {
        return false;
      }

      if (request.isForMainFrame() && request.hasGesture() && "GET".equals(request.getMethod())
        && policy.external(url)) {
        try {
          startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()));
        } catch (android.content.ActivityNotFoundException exception) {
          Toast.makeText(MainActivity.this, ClientLocale.text("noBrowser"), Toast.LENGTH_LONG).show();
        }
      }

      return true;
    }
  }

  private final class NativeActions extends WebChromeClient {
    /**
     * Веб не получает камеру и произвольные permissions через общий запрос.
     * Микрофон выдаётся только origin трубы после разрешения Android.
     */
    @Override
    public void onPermissionRequest(PermissionRequest request) {
      runOnUiThread(() -> {
        if (!policy.microphone(request.getOrigin().toString(), request.getResources())) {
          request.deny();

          return;
        }

        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
          request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
        } else {
          if (audio != null) {
            audio.deny();
          }

          audio = request;
          requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, AUDIO_REQUEST);
        }
      });
    }

    @Override
    public void onPermissionRequestCanceled(PermissionRequest request) {
      if (audio == request) {
        audio = null;
      }
    }

    /**
     * Выбор документа принадлежит Android и не открывает WebView доступ к content URL.
     * Результат передаётся только ожидающему file input, прежний запрос отменяется.
     */
    @Override
    public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
      FileChooserParams parameters) {
      if (files != null) {
        files.onReceiveValue(null);
      }

      files = callback;
      ((ClientApplication) getApplication()).nativeFlow(true);

      Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);

      intent.addCategory(Intent.CATEGORY_OPENABLE);
      intent.setType("*/*");
      intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,
        parameters.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);

      try {
        startActivityForResult(intent, FILE_REQUEST);
      } catch (android.content.ActivityNotFoundException exception) {
        files.onReceiveValue(null);
        files = null;
        ((ClientApplication) getApplication()).nativeFlow(false);
      }

      return true;
    }
  }

  /**
   * Только ожидающий запрос микрофона получает результат системного разрешения.
   * Отказ не повторяется автоматически и не расширяет набор выданных ресурсов.
   */
  @Override
  public void onRequestPermissionsResult(int code, @NonNull String[] permissions, @NonNull int[] grants) {
    super.onRequestPermissionsResult(code, permissions, grants);

    if (code == CAMERA_REQUEST && scanning != null) {
      if (grants.length > 0 && grants[0] == PackageManager.PERMISSION_GRANTED) {
        openScanner();
      } else {
        scanning.completeExceptionally(new IllegalStateException(ClientLocale.text("cameraPermission")));
        scanning = null;
        ((ClientApplication) getApplication()).nativeFlow(false);
      }
    }

    if (code == AUDIO_REQUEST && audio != null) {
      if (grants.length > 0 && grants[0] == PackageManager.PERMISSION_GRANTED) {
        audio.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
      } else {
        audio.deny();
      }

      audio = null;
    }
  }

  /**
   * Результат системного выбора доставляется только ожидающему file input.
   * Отмена возвращает null и не вызывает сетевую загрузку повторно.
   */
  @Override
  protected void onActivityResult(int request, int result, Intent data) {
    super.onActivityResult(request, result, data);

    if (request == com.google.zxing.integration.android.IntentIntegrator.REQUEST_CODE && scanning != null) {
      com.google.zxing.integration.android.IntentResult scanned =
        com.google.zxing.integration.android.IntentIntegrator.parseActivityResult(request, result, data);

      if (scanned != null && scanned.getContents() != null) {
        scanning.complete(scanned.getContents());
      } else {
        scanning.completeExceptionally(new IllegalStateException(ClientLocale.text("scanCancelled")));
      }

      scanning = null;
      ((ClientApplication) getApplication()).nativeFlow(false);
    }

    if (request == FILE_REQUEST && files != null) {
      android.content.ClipData clips = data == null ? null : data.getClipData();
      java.util.List<Uri> selected = FileSelection.read(result == RESULT_OK,
        data == null ? null : data.getData(), clips == null ? 0 : clips.getItemCount(),
        index -> clips.getItemAt(index).getUri());

      files.onReceiveValue(selected.isEmpty() ? null : selected.toArray(new Uri[0]));
      files = null;
      ((ClientApplication) getApplication()).nativeFlow(false);
    }
  }

  @Override
  protected void onSaveInstanceState(@NonNull Bundle state) {
    super.onSaveInstanceState(state);
  }
  public static void background() {
    ClientRuntime client = runtime;

    if (client != null) {
      client.shell.suspend();
    }
  }

  /**
   * Возврат приложения восстанавливает транспорт через общий runtime установки.
   * Просроченная аутентификация сначала переводит оболочку в locked.
   */
  public static void foreground(boolean locked) {
    ClientRuntime client = runtime;

    if (client != null) {
      try {
        client.shell.resume(locked);
      } catch (Exception exception) {
        throw new IllegalStateException(ClientLocale.text("restoreFailure"), exception);
      }
    }
  }

  /**
   * Удерживаемый WebView переживает поворот, не сохраняя уничтоженную Activity.
   * Контекст приложения освобождает старое окно до появления нового владельца.
   */
  @Override
  protected void onDestroy() {
    if (current.get() == this && !isChangingConfigurations()) {
      unlockPrompt.cancelAuthentication();
      ((ClientApplication) getApplication()).unlockSession.failed(
        new IllegalStateException(ClientLocale.text("unlockCancelled")));
    }

    if (current.get() == this) {
      current.clear();
      webContext.setBaseContext(getApplicationContext());
    }

    super.onDestroy();
  }

}
