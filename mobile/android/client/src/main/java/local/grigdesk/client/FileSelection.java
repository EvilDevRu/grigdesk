package local.grigdesk.client;

import java.util.List;
import java.util.function.IntFunction;

public final class FileSelection {
  private FileSelection() {
  }

  /**
   * ClipData имеет приоритет над одиночным URI системного picker.
   * Отмена возвращает пустой список и не запускает загрузку документов.
   */
  public static <T> List<T> read(boolean accepted, T single, int count, IntFunction<T> item) {
    if (!accepted) {
      return List.of();
    }

    java.util.ArrayList<T> result = new java.util.ArrayList<>();

    for (int index = 0; index < count; index++) {
      result.add(item.apply(index));
    }

    if (result.isEmpty() && single != null) {
      result.add(single);
    }

    return result;
  }
}
