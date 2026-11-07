package local.grigdesk.client;

import static org.junit.Assert.*;
import java.util.List;
import org.junit.Test;

public class FileSelectionTest {
  /**
   * Множественный результат хранится в ClipData без одиночного data URI.
   * Все выбранные документы сохраняют порядок; отмена не возвращает файлы.
   */
  @Test
  public void multipleSelectionAndCancellation() {
    List<String> clips = List.of("content://one", "content://two");

    assertEquals(clips, FileSelection.read(true, null, clips.size(), clips::get));
    assertEquals(List.of("content://one"), FileSelection.read(true, "content://one", 0, clips::get));
    assertTrue(FileSelection.read(false, null, clips.size(), clips::get).isEmpty());
  }
}
