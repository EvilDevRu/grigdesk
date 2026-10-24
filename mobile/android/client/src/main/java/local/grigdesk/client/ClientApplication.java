package local.grigdesk.client;

import android.app.Activity;
import android.app.ActivityManager;
import android.app.Application;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

/**
 * Счётчик относится ко всему приложению, включая собственную Activity сканера.
 * Внешний системный диалог сохраняет поток только пока процесс остаётся видимым.
 */
public final class ClientApplication extends Application implements Application.ActivityLifecycleCallbacks {
  public final AppLifecycle lifecycle = new AppLifecycle(SystemClock::elapsedRealtime,
    new AppLifecycle.Hooks() {
    public void background() {
      MainActivity.background();
    }
    public void foreground(boolean locked) {
      MainActivity.foreground(locked);
    }
  });
  public final UnlockSession unlockSession = new UnlockSession(lifecycle::authenticated, this::nativeFlow);

  private final Handler handler = new Handler(Looper.getMainLooper());
  private int flows;
  private final Runnable checkProcess = new Runnable() {
    @Override
    public void run() {
      ActivityManager.RunningAppProcessInfo info = new ActivityManager.RunningAppProcessInfo();

      ActivityManager.getMyMemoryState(info);
      lifecycle.processForeground(info.importance
        <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE);

      if (flows > 0) {
        handler.postDelayed(this, 1000);
      }
    }
  };

  /**
   * Локаль установки читается до первого собственного сообщения приложения.
   * Отказ чтения каталога журналируется и не мешает регистрации lifecycle.
   */
  @Override
  public void onCreate() {
    super.onCreate();

    try {
      ClientLocale.initialize(this);
    } catch (Exception exception) {
      android.util.Log.e("GrigDesk", "Не удалось прочитать локаль установки", exception);
    }

    registerActivityLifecycleCallbacks(this);
  }

  /**
   * Системный диалог временно учитывается как продолжение работы приложения.
   * Монитор видимости отличает такой переход от настоящего ухода в фон.
   */
  public void nativeFlow(boolean active) {
    flows = Math.max(0, flows + (active ? 1 : -1));
    lifecycle.nativeFlow(active);
    handler.removeCallbacks(checkProcess);

    if (flows > 0) {
      handler.postDelayed(checkProcess, 1000);
    }
  }

  public void onActivityStarted(Activity activity) {
    lifecycle.started();
  }

  public void onActivityStopped(Activity activity) {
    lifecycle.stopped(activity.isChangingConfigurations());
  }

  public void onActivityCreated(Activity activity, Bundle state) {
  }
  public void onActivityResumed(Activity activity) {
  }
  public void onActivityPaused(Activity activity) {
  }
  public void onActivitySaveInstanceState(Activity activity, Bundle state) {
  }
  public void onActivityDestroyed(Activity activity) {
  }
}
