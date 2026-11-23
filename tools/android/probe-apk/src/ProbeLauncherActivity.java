package local.grigdesk.client;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.View;
import java.util.Set;

/**
 * Обычная оболочка в пробном APK получает локальный профиль при создании runtime.
 * Видимое окно запрашивает старт службы при каждом новом открытии приложения.
 */
public class ProbeLauncherActivity extends MainActivity {
    private static final long STARTUP_TIMEOUT_MS = 120_000;
    private static final long STARTUP_CHECK_MS = 250;
    private static final Set<String> STARTUP_STATUSES = Set.of("none", "offline", "connecting", "online", "locked");
    private static long startupDeadline;
    private static boolean startupFinished;
    private static boolean returningFromBackground;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable checkStartup = this::checkStartup;
    private boolean started;
    private boolean visible;
    private boolean checkingFrame;
    private ProbeSplashView splash;

    @Override
    protected ClientRuntime.LocalServer localServer() {
        return new ClientRuntime.LocalServer(LocalServerService.SERVER_PORT, LocalServerService::readWindowKey);
    }

    /**
     * Открытие окна и ручное подключение используют один запуск службы.
     * Служба сама пропускает запрос, пока процесс готовится или уже запущен.
     */
    @Override
    protected void startLocalServer() {
        try {
            LocalServerService.launch(this);
        }
        catch (IllegalStateException | SecurityException error) {
            Log.e("GrigDeskProbe", "Не удалось запустить службу локального сервера", error);
            throw new IllegalStateException(ClientLocale.text("actionFailure"), error);
        }
    }

    /**
     * Заставка независима от основного WebView и сервера, а блокировка приложения лежит поверх неё.
     * Поворот окна сохраняет общий срок ожидания и не повторяет уже законченный запуск.
     */
    @Override
    protected View createStartupCover() {
        if (startupFinished) {
            return null;
        }

        if (startupDeadline == 0) {
            startupDeadline = SystemClock.elapsedRealtime() + STARTUP_TIMEOUT_MS;
        }

        splash = new ProbeSplashView(this);
        return splash;
    }

    @Override
    protected void onStart() {
        super.onStart();
        visible = true;

        // Возврат в удерживаемый WebView может начать новый запуск или восстановление трубы.
        // Фоновое соединение, которое сохранилось online, уже готово к показу.
        ClientApplication app = (ClientApplication) getApplication();
        String status = localStartupStatus();

        if (returningFromBackground && startupFinished && STARTUP_STATUSES.contains(status)
            && (!app.backgroundLink.enabled() || !"online".equals(status) || !LocalServerService.running())) {
            startupFinished = false;
            startupDeadline = 0;
            showStartupCover();
        }

        returningFromBackground = false;
        handler.post(checkStartup);
    }

    /**
     * Промежуточные offline остаются под заставкой, пока труба повторяет подключение.
     * Готовый кадр или окончание ожидания открывают обычное окно с текущим состоянием.
     */
    private void checkStartup() {
        if (startupFinished) {
            return;
        }

        String status = localStartupStatus();

        if (!STARTUP_STATUSES.contains(status) || (started && LocalServerService.launchFailed())
            || SystemClock.elapsedRealtime() >= startupDeadline) {
            finishStartup();
            return;
        }

        handler.postDelayed(checkStartup, STARTUP_CHECK_MS);

        if ("online".equals(status) && LocalServerService.running() && !checkingFrame) {
            checkingFrame = true;
            long deadline = startupDeadline;
            checkWorkspaceFrame(ready -> {
                if (startupFinished || deadline != startupDeadline) {
                    return;
                }

                checkingFrame = false;

                if (ready && visible && "online".equals(localStartupStatus()) && LocalServerService.running()) {
                    finishStartup();
                }
            });
        }
    }

    /**
     * Отказ или срок освобождают окно, сохраняя обычное восстановление связи.
     * Фоновый сервер и маршрут через трубу остаются в ведении существующего lifecycle.
     */
    private void finishStartup() {
        startupFinished = true;
        checkingFrame = false;
        handler.removeCallbacks(checkStartup);
        dismissStartupCover();
        releaseSplash();
    }

    private void releaseSplash() {
        if (splash != null) {
            splash.close();
            splash = null;
        }
    }

    /**
     * Службу разрешено запустить после появления видимого окна.
     * Повторный фокус в той же Activity и поворот не создают второй сервер.
     */
    @Override
    public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);

        if (!focused || started) {
            return;
        }

        try {
            startLocalServer();
            started = true;
        }
        catch (IllegalStateException error) {
            finishStartup();
        }
    }

    @Override
    protected void onStop() {
        visible = false;
        returningFromBackground = !isChangingConfigurations();
        handler.removeCallbacks(checkStartup);
        started = false;
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        releaseSplash();
        super.onDestroy();
    }
}
