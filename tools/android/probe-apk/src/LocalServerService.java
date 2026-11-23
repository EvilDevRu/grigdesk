package local.grigdesk.client;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

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
    static final int SERVER_PORT = 8140;
    private static final String SERVER_BUNDLE = "server-bundle.cjs";
    private static volatile LocalServerService active;
    private static volatile boolean launchFailed;

    private final ExecutorService startup = Executors.newSingleThreadExecutor();
    private Process serverProcess;
    private PowerManager.WakeLock wakeLock;
    private boolean starting;
    private boolean destroyed;

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
        active = this;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification notification = new Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("GrigDesk probe server")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .build();

        startForeground(NOTIFICATION_ID, notification);
        requestServerStart();

        return START_STICKY;
    }

    /**
     * У уже запущенной службы новая попытка начинается сразу, до следующей проверки окна.
     * Создание службы делегируется Android, прежняя ошибка к её запуску не относится.
     */
    static void launch(Context context) {
        LocalServerService service = active;

        if (service == null) {
            launchFailed = false;
            context.startForegroundService(new Intent(context, LocalServerService.class));
        }
        else {
            service.requestServerStart();
        }
    }

    /**
     * Сохранившаяся фоновая связь готова только пока служба владеет живым процессом.
     * Проверка не обращается по сети и используется на UI-потоке.
     */
    static boolean running() {
        LocalServerService service = active;

        if (service == null) {
            return false;
        }

        synchronized (service) {
            return !service.destroyed && service.serverProcess != null && service.serverProcess.isAlive();
        }
    }

    /**
     * Повторный вызов от окна не запускает вторую копию сервера.
     * Распаковку выполняет рабочий поток службы.
     */
    private synchronized void requestServerStart() {
        if (destroyed || starting || (serverProcess != null && serverProcess.isAlive())) {
            return;
        }
        launchFailed = false;
        starting = true;
        startup.execute(this::startServer);
    }

    /**
     * Пока служба раскрывает пакет, отсутствие процесса означает обычное ожидание.
     * Ошибка подготовки или завершение дочернего процесса освобождает заставку раньше срока.
     */
    static boolean launchFailed() {
        LocalServerService service = active;

        if (service == null) {
            return launchFailed;
        }

        synchronized (service) {
            return launchFailed || (!service.starting && service.serverProcess != null
                && !service.serverProcess.isAlive());
        }
    }

    /**
     * Окно получает ключ только пока жив процесс, запущенный этой службой.
     * Отсутствующий ключ означает, что сервер ещё не закончил bind.
     */
    static String readWindowKey() throws IOException {
        LocalServerService service = active;

        if (service == null) {
            throw new IOException("Локальная служба ещё не запущена");
        }

        synchronized (service) {
            if (service.destroyed || service.serverProcess == null || !service.serverProcess.isAlive()) {
                throw new IOException("Локальный сервер ещё не запущен");
            }

            byte[] bytes = Files.readAllBytes(service.windowKeyFile().toPath());
            String key = new String(bytes, StandardCharsets.US_ASCII);

            if (!key.matches("[A-Za-z0-9_-]{43}")) {
                throw new IOException("Недопустимый ключ локального сервера");
            }

            return key;
        }
    }

    private File windowKeyFile() {
        return new File(getFilesDir(), "window-auth/window-key");
    }

    /**
     * Распаковывает bundle и запускает libnode.so с GRIGDESK_HOME во внутреннем
     * каталоге. Исполнение только из nativeLibraryDir (W^X); bundle — обычный
     * JS-файл, читается интерпретатором, не исполняется напрямую.
     */
    private void startServer() {
        try {
            ApplicationInfo info = getApplicationInfo();
            File dataDir = getFilesDir().getCanonicalFile();
            File home = new File(dataDir, "grigdesk");
            File projects = new File(dataDir, "projects");
            File runtime = new File(dataDir, "runtime");
            File bundle = new File(runtime, SERVER_BUNDLE);
            File python = preparePython(dataDir);
            File whisper = new File(info.nativeLibraryDir, "libgrigdesk_whisper.so");
            boolean speech = python != null && whisper.isFile();
            File tools = prepareNativeTools(dataDir, info, python != null, speech);

            home.mkdirs();
            projects.mkdirs();
            extractArchive("runtime.zip", runtime);

            /**
             * Ключи доступа лежат в файле env папки данных — тот же путь серверу
             * показывает config.envPath, поэтому ручной файл и записи UI не
             * расходятся. Флаг условный: до первого ключа файла просто нет.
             */
            File envFile = new File(home, "env");

            String node = new File(info.nativeLibraryDir, "libnode.so").getAbsolutePath();
            ProcessBuilder builder = new ProcessBuilder(
                node, "--env-file-if-exists", envFile.getAbsolutePath(), bundle.getAbsolutePath());

            builder.directory(dataDir);
            builder.environment().put("HOME", dataDir.getAbsolutePath());
            builder.environment().put("GRIGDESK_HOME", home.getAbsolutePath());
            builder.environment().put("GRIGDESK_PORT", String.valueOf(SERVER_PORT));
            builder.environment().put("GRIGDESK_WINDOW_KEY_PATH", windowKeyFile().getAbsolutePath());
            builder.environment().put("LD_LIBRARY_PATH", info.nativeLibraryDir);
            String inheritedPath = builder.environment().getOrDefault("PATH", "/system/bin");
            builder.environment().put("PATH", tools.getAbsolutePath() + ":" + inheritedPath);
            builder.environment().put("TMPDIR", dataDir.getAbsolutePath());
            if (python != null) {
                builder.environment().put("PYTHONHOME", python.getPath());
            }
            if (speech) {
                File speechResources = new File(runtime, "server/src/lib/speech");

                builder.environment().put("GRIGDESK_ANDROID_WHISPER_LIB", whisper.getAbsolutePath());
                builder.environment().put("GRIGDESK_ANDROID_SPEECH_MODULES", speechResources.getAbsolutePath());
                builder.environment().put(
                    "GRIGDESK_ANDROID_SPEECH_PYTHON", new File(tools, "python3").getAbsolutePath());
                builder.environment().put(
                    "GRIGDESK_ANDROID_SPEECH_CA", new File(speechResources, "roots.pem").getAbsolutePath());
            }

            /**
             * Автономная поставка DeepSeek кладётся в nativeLibraryDir как libdeepseek.so:
             * W^X targetSdk 29+ запрещает исполнять ELF из каталога данных, а эту папку
             * установщик распаковывает с правами исполнения. Серверу достаточно env-пути,
             * код сервера и поставки не меняются.
             */
            File deepseekBinary = new File(info.nativeLibraryDir, "libdeepseek.so");

            if (deepseekBinary.isFile()) {
                builder.environment().put("GRIGDESK_DEEPSEEK_BIN", deepseekBinary.getAbsolutePath());
            }
            builder.environment().put(
                "GRIGDESK_FACTORY_BIN", new File(info.nativeLibraryDir, "libfactory.so").getAbsolutePath());
            builder.redirectErrorStream(true);
            builder.redirectOutput(new File(home, "server.log"));

            synchronized (this) {
                if (!destroyed) {
                    Files.deleteIfExists(windowKeyFile().toPath());
                    serverProcess = builder.start();
                }
            }
        }
        catch (Exception error) {
            launchFailed = true;
            Log.e("GrigDeskProbe", "Не удалось запустить локальный сервер", error);
            stopSelf();
        }
        finally {
            synchronized (this) {
                starting = false;
            }
        }
    }

    /**
     * Фабрика находит Bash и Git под штатными именами, а двоичные файлы остаются в APK.
     * Атомарная замена ссылки обновляет адрес при установке нового APK.
     */
    private File prepareNativeTools(File dataDir, ApplicationInfo info, boolean python, boolean speech)
        throws IOException {
        File tools = new File(dataDir, "native-tools");
        Path directory = tools.toPath();

        if (Files.isSymbolicLink(directory) || (!tools.isDirectory() && !tools.mkdir())) {
            throw new IOException("Каталог инструментов недоступен");
        }

        List<String> names = new ArrayList<>(List.of("bash", "flock", "git", "nohup", "timeout"));

        if (python) {
            names.add("python3");
        }
        if (speech) {
            names.add("ffmpeg");
            names.add("ffprobe");
        }
        for (String name : names) {
            File library = new File(info.nativeLibraryDir, "lib" + name + ".so");
            Path target = library.toPath();
            Path alias = directory.resolve(name);
            Path replacement = directory.resolve(".link-" + UUID.randomUUID());

            if (!library.isFile() || !library.canExecute()) {
                throw new IOException("Нет исполняемого инструмента " + name);
            }

            if (Files.isSymbolicLink(alias) && Files.readSymbolicLink(alias).equals(target)) {
                continue;
            }
            if (Files.exists(alias, LinkOption.NOFOLLOW_LINKS) && !Files.isSymbolicLink(alias)) {
                throw new IOException("Недопустимый файл инструмента " + name);
            }

            try {
                Files.createSymbolicLink(replacement, target);
                Files.move(replacement, alias, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            }
            finally {
                Files.deleteIfExists(replacement);
            }
        }

        return tools;
    }

    /** Python получает stdlib той ABI, для которой APK содержит исполняемый файл. */
    private File preparePython(File dataDir) throws IOException {
        String abi = Build.SUPPORTED_ABIS[0];
        String archive = "python-" + abi + ".zip";
        String[] assets = getAssets().list("");

        if (assets == null || !Arrays.asList(assets).contains(archive)) {
            return null;
        }

        File python = new File(dataDir, "python-" + abi);
        extractArchive(archive, python);
        return python;
    }

    /** Распаковывает закрытый комплект из APK и проверяет границу путей. */
    private void extractArchive(String archive, File runtime) throws IOException {
        String root = runtime.getCanonicalPath() + File.separator;
        byte[] buffer = new byte[65536];

        try (ZipInputStream input = new ZipInputStream(getAssets().open(archive))) {
            ZipEntry entry;

            while ((entry = input.getNextEntry()) != null) {
                if (Thread.currentThread().isInterrupted()) {
                    return;
                }
                File target = new File(runtime, entry.getName()).getCanonicalFile();

                if (!target.getPath().startsWith(root)) {
                    throw new IOException("Ресурс вне каталога пробы");
                }
                File directory = entry.isDirectory() ? target : target.getParentFile();

                if (!directory.isDirectory() && !directory.mkdirs()) {
                    throw new IOException("Не удалось создать каталог " + directory);
                }
                if (!entry.isDirectory()) {
                    try (OutputStream output = new FileOutputStream(target)) {
                        int read;

                        while ((read = input.read(buffer)) > 0) {
                            output.write(buffer, 0, read);
                        }
                    }
                }
                input.closeEntry();
            }
        }
    }

    @Override
    public void onDestroy() {
        closeServer();
        active = null;

        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }

        super.onDestroy();
    }

    /** Запрещает новый процесс до отмены текущей подготовки. */
    private synchronized void closeServer() {
        destroyed = true;
        startup.shutdownNow();

        if (serverProcess != null) {
            serverProcess.destroy();
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
