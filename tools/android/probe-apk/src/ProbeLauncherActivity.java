package local.grigdesk.client;

import android.content.Intent;
import android.util.Log;

/**
 * Обычная оболочка в пробном APK получает локальный профиль при создании runtime.
 * Видимое окно запрашивает старт службы при каждом новом открытии приложения.
 */
public class ProbeLauncherActivity extends MainActivity {
    private boolean started;

    @Override
    protected ClientRuntime.LocalServer localServer() {
        return new ClientRuntime.LocalServer(LocalServerService.SERVER_PORT, LocalServerService::readWindowKey);
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
            startForegroundService(new Intent(this, LocalServerService.class));
            started = true;
        }
        catch (IllegalStateException error) {
            Log.e("GrigDeskProbe", "Не удалось запустить службу локального сервера", error);
        }
    }

    @Override
    protected void onStop() {
        started = false;
        super.onStop();
    }
}
