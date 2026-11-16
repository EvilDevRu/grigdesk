package local.grigdesk.client;

import static org.junit.Assert.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.json.JSONObject;
import org.junit.Test;

public class PipelineWidgetStoreTest {
  private static JSONObject record(int running, int waiting, int stalled, String state)
    throws Exception {
    return new JSONObject()
      .put("running", running)
      .put("waiting", waiting)
      .put("stalled", stalled)
      .put("at", "2026-11-15T10:00:00.000Z")
      .put("fetchedAt", 1763200000000L)
      .put("state", state)
      .put("profileId", "fixture-a")
      .put("requestId", 1L);
  }

  /**
   * Кэш переживает перезапуск процесса, а битый файл не показывает мусор.
   * Удаление файла возвращает виджет в состояние «данных ещё нет».
   */
  @Test
  public void roundTripAndDamagedFileReadsNull() throws Exception {
    Path root = Files.createTempDirectory("grigdesk-widget-store-");
    Path file = root.resolve("pipeline-widget.json");
    PipelineWidgetStore store = new PipelineWidgetStore(file.toFile());

    assertNull(store.read());

    store.save(record(2, 1, 0, "ok"));

    JSONObject read = store.read();

    assertNotNull(read);
    assertEquals(2, read.getInt("running"));
    assertEquals(1, read.getInt("waiting"));
    assertEquals(0, read.getInt("stalled"));
    assertEquals("ok", read.getString("state"));

    Files.write(file, "{битый json".getBytes(StandardCharsets.UTF_8));

    assertNull(store.read());

    Files.deleteIfExists(file);
    Files.deleteIfExists(root);
  }

  /**
   * Неверная форма записи отвергается до записи: прежний файл остаётся целым.
   * Отрицательные счётчики, чужое состояние и строки вместо чисел не принимаются.
   */
  @Test
  public void invalidRecordsRejectedAndPreviousFileKept() throws Exception {
    Path root = Files.createTempDirectory("grigdesk-widget-store-invalid-");
    Path file = root.resolve("pipeline-widget.json");
    PipelineWidgetStore store = new PipelineWidgetStore(file.toFile());

    store.save(record(1, 0, 0, "ok"));

    JSONObject missingAt = record(1, 0, 0, "ok");

    missingAt.remove("at");

    JSONObject[] invalid = new JSONObject[] {
      record(-1, 0, 0, "ok"),
      record(1, 0, 0, "чужое"),
      record(1, 0, 0, "ok").put("running", "много"),
      missingAt,
      record(1, 0, 0, "ok").put("extra", true),
    };

    for (JSONObject data : invalid) {
      try {
        store.save(data);
        fail("запись должна быть отвергнута: " + data);
      } catch (IllegalArgumentException expected) {
        // ожидаемый отказ формы
      }
    }

    assertEquals(1, store.read().getInt("running"));

    Files.deleteIfExists(file);
    Files.deleteIfExists(root);
  }

  /**
   * Отказ до первого успеха показывает прочерки, успешный пустой конвейер — нули.
   * Привязка readFor запрещает отдавать снимок соседней машины.
   */
  @Test
  public void unknownCountersAndKnownZeroHaveDifferentPresentation() throws Exception {
    Path root = Files.createTempDirectory("grigdesk-widget-display-");
    Path file = root.resolve("pipeline-widget.json");
    PipelineWidgetStore store = new PipelineWidgetStore(file.toFile());

    try {
      store.save(record(0, 0, 0, "offline").put("at", ""));

      assertEquals("–", PipelineWidgetStore.counterText(store.readFor("fixture-a"), "running"));
      assertNull(store.readFor("fixture-b"));

      store.save(record(0, 0, 0, "ok"));

      assertEquals("0", PipelineWidgetStore.counterText(store.readFor("fixture-a"), "running"));
    } finally {
      Files.deleteIfExists(file);
      Files.deleteIfExists(root);
    }
  }

}
