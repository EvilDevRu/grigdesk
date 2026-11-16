package local.grigdesk.client;

import static org.junit.Assert.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.Test;

public class ManifestWidgetTest {
  private static String source(String relative) throws Exception {
    return new String(Files.readAllBytes(Path.of(relative)), StandardCharsets.UTF_8);
  }

  /**
   * Провайдер виджета объявлен с системным действием и мета-данными раскладки.
   * Без объявления система не показывает виджет в списке главного экрана.
   * Receiver обязан быть exported: лаунчер MIUI не показывает виджеты
   * неэкспортированных провайдеров (проверено на физическом устройстве).
   */
  @Test
  public void manifestDeclaresWidgetProvider() throws Exception {
    String manifest = source("src/main/AndroidManifest.xml");

    assertTrue(manifest.contains(".PipelineWidgetProvider"));
    assertTrue(manifest.contains("android.appwidget.action.APPWIDGET_UPDATE"));
    assertTrue(manifest.contains("@xml/pipeline_widget_info"));

    int receiver = manifest.indexOf(".PipelineWidgetProvider");
    int blockEnd = manifest.indexOf("</receiver>", receiver);
    assertTrue(blockEnd > receiver);
    assertTrue(manifest.substring(receiver, blockEnd).contains("android:exported=\"true\""));
  }

  /**
   * Периодика назначается при старте процесса, а запрос трубы доходит до воркера.
   * Пропуск любой проводки прошёл бы компиляцию, но оставил виджет без обновления.
   * Проверки MainActivity — статические сторожа проводки и порядка потребления,
   * не runtime-доказательство одноразовости перехода; одноразовость проверяется
   * приёмкой шага 12.
   */
  @Test
  public void applicationSchedulesAndActionsRefreshWidget() throws Exception {
    String application = source("src/main/java/local/grigdesk/client/ClientApplication.java");
    String actions = source("src/main/java/local/grigdesk/client/AndroidActions.java");

    assertTrue(application.contains("PipelineWidget.schedulePeriodic(this)"));
    assertTrue(actions.contains("public void refreshWidget()"));
    assertTrue(actions.contains("PipelineWidget.refreshNow(context)"));

    String planner = source("src/main/java/local/grigdesk/client/PipelineWidget.java");
    String worker = source("src/main/java/local/grigdesk/client/PipelineWidgetWorker.java");
    String runtime = source("src/main/java/local/grigdesk/client/ClientRuntime.java");

    assertTrue(planner.contains("ExistingWorkPolicy.APPEND_OR_REPLACE"));
    assertFalse(planner.contains("setRequiredNetworkType"));
    assertTrue(worker.contains("public void onStopped()"));
    assertTrue(worker.contains("connectivity.getActiveNetwork() == null"));
    assertTrue(runtime.contains("PipelineWidget.selectionChanged(context)"));

    String provider = source("src/main/java/local/grigdesk/client/PipelineWidgetProvider.java");
    String activity = source("src/main/java/local/grigdesk/client/MainActivity.java");

    assertTrue(provider.contains("PipelineWidgetPublication.run(() -> renderLocked(context))"));
    assertTrue(provider.contains("Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP"));
    assertTrue(activity.contains("if (runtime != null) {\n        applyNotifyUrl();\n        return;"));
    assertTrue(activity.contains("intent.removeExtra(NOTIFY_URL_EXTRA)"));
    assertTrue(activity.contains("!pageLoaded || appLock != null && appLock.locked()"));
    assertTrue(activity.indexOf("!pageLoaded || appLock != null && appLock.locked()")
      < activity.indexOf("intent.removeExtra(NOTIFY_URL_EXTRA)"));
    assertTrue(activity.indexOf("pendingNotifyUrl = null;")
      < activity.indexOf("intent.removeExtra(NOTIFY_URL_EXTRA)"));
  }

  /**
   * Старый render A удерживается перед публикацией, пока выбран B и запрошен новый render.
   * Второй поток действительно ждёт monitor, а итоговая публикация всегда принадлежит B.
   */
  @Test
  public void publicationCannotReturnOldMachineAfterNewSelection() throws Exception {
    var selected = new java.util.concurrent.atomic.AtomicReference<>("A");
    var captured = new java.util.concurrent.CountDownLatch(1);
    var release = new java.util.concurrent.CountDownLatch(1);
    var secondStarted = new java.util.concurrent.CountDownLatch(1);
    var failure = new java.util.concurrent.atomic.AtomicReference<Throwable>();
    var published = new java.util.concurrent.CopyOnWriteArrayList<String>();
    Thread first = new Thread(() -> {
      try {
        PipelineWidgetPublication.run(() -> {
          String snapshot = selected.get();

          captured.countDown();

          try {
            assertTrue(release.await(5, java.util.concurrent.TimeUnit.SECONDS));
          } catch (InterruptedException exception) {
            throw new AssertionError(exception);
          }

          published.add(snapshot);
        });
      } catch (Throwable error) {
        failure.set(error);
      }
    });
    Thread second = new Thread(() -> {
      secondStarted.countDown();
      PipelineWidgetPublication.run(() -> published.add(selected.get()));
    });

    try {
      first.start();
      assertTrue(captured.await(5, java.util.concurrent.TimeUnit.SECONDS));
      selected.set("B");
      second.start();
      assertTrue(secondStarted.await(5, java.util.concurrent.TimeUnit.SECONDS));

      long limit = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(5);

      while (second.isAlive() && second.getState() != Thread.State.BLOCKED && System.nanoTime() < limit) {
        Thread.yield();
      }

      assertEquals(Thread.State.BLOCKED, second.getState());
      release.countDown();
      first.join(5000);
      second.join(5000);

      assertFalse(first.isAlive());
      assertFalse(second.isAlive());
      assertNull(failure.get());
      assertEquals(java.util.List.of("A", "B"), published);
    } finally {
      release.countDown();
      first.join(5000);
      second.join(5000);
    }
  }

}
