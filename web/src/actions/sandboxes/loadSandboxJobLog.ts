import type { SandboxJobLog } from '../../../../shared/plugins/sandboxes/sandboxContracts';
import { sandboxApi, sandboxErrorMessage } from '../../shared/sandboxApi';
import { useSandboxesStore } from '../../stores/sandboxes';

/**
 * Хвост вывода задания стенда — по запросу карточки, а не в обзоре: полный журнал
 * прогона нужен, когда человек его открыл, и незачем возить его с каждым обновлением.
 * Отказ показывает стор; вызывающему достаётся null.
 */
export async function loadSandboxJobLog(task: string): Promise<SandboxJobLog | null> {
  const store = useSandboxesStore();

  try {
    return await sandboxApi.jobLog(task);
  } catch (error) {
    store.setError(sandboxErrorMessage(error, 'Журнал задания не прочитался.'));

    return null;
  }
}
