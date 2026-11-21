package local.grigdesk.client;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.os.IBinder;
import android.os.PowerManager;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Прототип локального серверного runtime для пробы 3a (не продуктовый код).
 * Запускает настоящий Bionic Node (libnode.so) с серверным bundle из assets
 * во внутреннем приватном каталоге; foreground-сервис держит процесс,
 * START_STICKY даёт перезапуск по политике FGS после kill/LMK.
 * Восстановление задач после force-stop идёт через durable-контракт движка,
 * а не через удержание процесса любой ценой.
 */
public class LocalServerService extends Service {
    private static final String CHANNEL_ID = "grigdesk-local-server";
    private static final int NOTIFICATION_ID = 30;
    private static final int SERVER_PORT = 8140;

    private Process serverProcess;
    private PowerManager.WakeLock wakeLock;

    @Override
    public void onCreate() {
        super.onCreate();

        NotificationManager manager = getSystemService(NotificationManager.class);
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID, "GrigDesk local server", NotificationManager.IMPORTANCE_LOW);

        manager.createNotificationChannel(channel);

        PowerManager power = getSystemService(PowerManager.class);

        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "grigdesk:probe-server");
        wakeLock.acquire();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification notification = new Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("GrigDesk probe server")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .build();

        startForeground(NOTIFICATION_ID, notification);
        startServer();

        return START_STICKY;
    }

    /**
     * Распаковывает bundle и запускает libnode.so с GRIGDESK_HOME во внутреннем
     * каталоге. Исполнение только из nativeLibraryDir (W^X); bundle — обычный
     * JS-файл, читается интерпретатором, не исполняется напрямую.
     */
    private void startServer() {
        if (serverProcess != null && serverProcess.isAlive()) {
            return;
        }

        try {
            ApplicationInfo info = getApplicationInfo();
            File home = new File(getFilesDir(), "grigdesk");
            File projects = new File(getFilesDir(), "projects");
            File bundle = new File(getFilesDir(), "server-bundle.js");

            home.mkdirs();
            projects.mkdirs();
            copyAsset("server-bundle.js", bundle);

            String node = new File(info.nativeLibraryDir, "libnode.so").getAbsolutePath();
            ProcessBuilder builder = new ProcessBuilder(node, bundle.getAbsolutePath());

            builder.directory(getFilesDir());
            builder.environment().put("GRIGDESK_HOME", home.getAbsolutePath());
            builder.environment().put("GRIGDESK_PORT", String.valueOf(SERVER_PORT));
            builder.environment().put("GRIGDESK_HOST", "127.0.0.1");
            builder.redirectErrorStream(true);
            builder.redirectOutput(new File(home, "server.log"));

            serverProcess = builder.start();
        }
        catch (Exception error) {
            stopSelf();
        }
    }

    private void copyAsset(String name, File target) throws Exception {
        try (InputStream input = getAssets().open(name);
             OutputStream output = new FileOutputStream(target)) {
            byte[] buffer = new byte[65536];
            int read;

            while ((read = input.read(buffer)) > 0) {
                output.write(buffer, 0, read);
            }
        }
    }

    @Override
    public void onDestroy() {
        if (serverProcess != null) {
            serverProcess.destroy();
        }

        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }

        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}