import { ref } from 'vue';
import { defineStore } from 'pinia';

import { decodeDeploymentSnapshot, type DeploymentSnapshot as DeploymentJob }
  from '../../../shared/mobile/relayDeploymentContracts.ts';
import { api } from '../shared/apiClient.ts';
import { t } from '../ui.ts';

/**
 * Снимок принимает только публичные поля серверного контракта.
 * Обёртка job совместима с клиентами, которые читают отдельный ответ и список заданий.
 */
export function deploymentJob(value: unknown): DeploymentJob {
  return decodeDeploymentSnapshot(value);
}

/**
 * Store хранит только безопасные снимки; секреты остаются в компоненте мастера.
 * Поколение владельца не позволяет позднему ответу прежней машины заполнить новую.
 */
export const useRelayDeploymentStore = defineStore('relayDeployment', () => {
  const jobs = ref<DeploymentJob[]>([]);
  const loading = ref(false);
  const error = ref('');
  let generation = 0;

  /**
   * Смена владельца немедленно очищает все публичные снимки.
   * Увеличение поколения также отменяет публикацию уже начатых чтений.
   */
  function reset(): void {
    generation += 1;
    jobs.value = [];
    error.value = '';
    loading.value = false;
  }

  /**
   * Любой reconnect получает полный снимок, а событие SSE служит только инвалидатором.
   * Ошибка чтения не превращает прежнюю установку в успешную или удалённую.
   */
  async function load(): Promise<void> {
    const epoch = ++generation;

    loading.value = true;
    error.value = '';

    try {
      const result = await api.get('/api/mobile/deployments');

      if (!result || typeof result !== 'object' || !('jobs' in result) || !Array.isArray(result.jobs)) {
        throw new Error('invalid_deployments');
      }

      const snapshot = result.jobs.map(deploymentJob);

      if (generation === epoch) {
        jobs.value = snapshot;
      }
    } catch {
      if (generation === epoch) {
        error.value = t('settings.remoteLoadFailed');
      }
    } finally {
      if (generation === epoch) {
        loading.value = false;
      }
    }
  }

  function accept(job: DeploymentJob): void {
    generation += 1;
    loading.value = false;
    jobs.value = [...jobs.value.filter((item) => item.id !== job.id), job];
  }

  return {
    jobs,
    loading,
    error,
    reset,
    load,
    accept,
  };
});
