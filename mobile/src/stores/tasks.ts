import { defineStore } from 'pinia';
import { ref } from 'vue';

import type { Task, Tasks } from '../api/contract.ts';
import { createLatest } from '../api/latest.ts';
import { onClear, useLinkStore } from './link.ts';

/**
 * Детали и список конвейера имеют независимые counters и очищаются при lock.
 * Команды всегда берут actionToken текущей карточки и не изменяют состояния локально.
 */
export const useTasksStore = defineStore('tasks', () => {
  const link = useLinkStore();
  const list = ref<Tasks | null>(null);
  const current = ref<Task | null>(null);
  const error = ref('');
  const detailError = ref('');
  const listLatest = createLatest();
  const detailLatest = createLatest();

  /**
   * Один wrapper показывает отказ без сброса более свежих данных.
   * Ошибки identity требуют перечитывания, никогда не автоматического повторения решения.
   */
  async function run(action: () => Promise<void>, target = error) {
    target.value = '';

    try {
      await action();
    } catch (failure) {
      target.value = failure instanceof Error ? failure.message : 'Задачи недоступны.';
    }
  }

  const loadList = () =>
    run(() =>
      listLatest.run(
        () => link.api!.getTasks(),
        (value) => {
          list.value = value;
        },
      ),
    );
  const load = (id: string) =>
    run(
      () =>
        detailLatest.run(
          () => link.api!.getTask(id),
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
