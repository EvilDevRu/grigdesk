import { defineStore } from 'pinia';
import { ref } from 'vue';

import type { B24Task, B24Tasks } from '../api/contract.ts';
import { createLatest } from '../api/latest.ts';
import { onClear, useLinkStore } from './link.ts';

/**
 * Данные портала принадлежат серверу, UI хранит только актуальные проверенные DTO.
 * Независимые counters не дают старой карточке заменить текущую после перехода.
 */
export const useB24Store = defineStore('b24', () => {
  const link = useLinkStore();
  const list = ref<B24Tasks | null>(null);
  const current = ref<B24Task | null>(null);
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
        () => link.api!.getB24Tasks(),
        (value) => {
          list.value = value;
        },
      ),
    );
  const load = (id: string) =>
    run(
      () =>
        detailLatest.run(
          () => link.api!.getB24Task(id),
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
