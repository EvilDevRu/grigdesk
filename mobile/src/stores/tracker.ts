import { defineStore } from 'pinia';
import { ref } from 'vue';

import type { TrackerTask, TrackerTasks } from '../api/contract.ts';
import { createLatest } from '../api/latest.ts';
import { onClear, useLinkStore } from './link.ts';

/**
 * Данные портала принадлежат серверу, UI хранит только актуальные проверенные DTO.
 * Независимые counters не дают старой карточке заменить текущую после перехода.
 */
export const useTrackerStore = defineStore('tracker', () => {
  const link = useLinkStore();
  const list = ref<TrackerTasks | null>(null);
  const current = ref<TrackerTask | null>(null);
  const error = ref('');
  const detailError = ref('');
  const listLatest = createLatest();
  const detailLatest = createLatest();

  /**
   * Отказ портала показывается текстом с возможностью повторить чтение.
   * Wrapper не повторяет launch и не скрывает неопределённый исход команды.
   */
  async function run(action: () => Promise<void>, target = error) {
    target.value = '';

    try {
      await action();
    } catch (failure) {
      target.value = failure instanceof Error ? failure.message : 'Б24 недоступен.';
    }
  }

  const loadList = () =>
    run(() =>
      listLatest.run(
        () => link.api!.getTrackerTasks(),
        (value) => {
          list.value = value;
        },
      ),
    );
  const load = (id: string) =>
    run(
      () =>
        detailLatest.run(
          () => link.api!.getTrackerTask(id),
          (value) => {
            current.value = value;
          },
        ),
      detailError,
    );

  onClear(() => {
    listLatest.invalidate();
    detailLatest.invalidate();
    list.value = null;
    current.value = null;
    error.value = '';
    detailError.value = '';
  });

  return {
    list,
    current,
    error,
    detailError,
    loadList,
    load,
  };
});
