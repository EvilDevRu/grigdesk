import { sandboxApi, sandboxErrorMessage } from '../../shared/sandboxApi';
import { useSandboxesStore } from '../../stores/sandboxes';
import { loadSandboxes } from './loadSandboxes';

/**
 * Снос идёт скриптом профиля и тоже занимает время, поэтому кнопка стенда
 * блокируется до ответа, а состояние перечитывается сразу после него.
 */
export async function dismantleSandbox(task: string, force = false): Promise<void> {
  const store = useSandboxesStore();

  store.setError('');
  store.setBusy(task, true);

  try {
    const started = await sandboxApi.dismantle(task, force);

    store.applyJob(started.job);
    await loadSandboxes();
  } catch (error) {
    store.setError(sandboxErrorMessage(error, 'Снести стенд не удалось.'));
  } finally {
    store.setBusy(task, false);
  }
}
