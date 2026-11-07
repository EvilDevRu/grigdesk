import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

import { useShellStore } from './shell.ts';
import { shellAction } from '../shared/shellClient.ts';

/**
 * Видимость диалога отделена от installation-bound задания в main.
 * Снимок приходит существующим shell long-poll, закрытие ничего не отменяет.
 */
export const useApplicationUpdateStore = defineStore('applicationUpdate', () => {
  const shell = useShellStore();
  const open = ref(false);
  const busy = ref(false);
  const error = ref<string | null>(null);
  const enabled = computed(() => shell.capabilities.includes('appUpdates'));
  const snapshot = computed(() => shell.snapshot?.applicationUpdate ?? null);
  const available = computed(() => snapshot.value?.checkState === 'available');
  const activeJob = computed(() => snapshot.value?.job && !['completed', 'rolled_back', 'failed']
    .includes(snapshot.value.job.stage));
  const progress = computed(() => {
    const job = snapshot.value?.job;

    return job?.stage === 'downloading' && job.totalBytes && job.downloadedBytes !== null
      ? Math.min(100, Math.floor(job.downloadedBytes / job.totalBytes * 100)) : null;
  });

  /**
   * Потерянный ответ уточняется через локальный status, без слепого повтора prepare.
   * Один флаг действия переживает закрытие модала и блокирует вторую кнопку.
   */
  async function action(name: string, body: Record<string, unknown> = {}): Promise<void> {
    if (busy.value) {
      return;
    }

    busy.value = true;
    error.value = null;

    try {
      await shellAction('POST', `/updates/${name}`, body);
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : 'release_action_failed';
    } finally {
      await shell.refresh().catch(() => {});
      busy.value = false;
    }
  }

  return {
    open,
    busy,
    error,
    enabled,
    snapshot,
    available,
    activeJob,
    progress,
    action,
  };
});
