import { sandboxApi, sandboxErrorMessage } from '../../shared/sandboxApi';
import { useSandboxesStore } from '../../stores/sandboxes';
import { loadSandboxes } from './loadSandboxes';

/**
 * Действие профиля на стенде идёт скриптом минутами, поэтому кнопки карточки
 * блокируются до ответа, задание встаёт в состояние сразу, а обзор перечитывается:
 * у стенда с идущим прогоном меняется и причина, по которой его нельзя снести.
 */
export async function runSandboxAction(
  task: string,
  action: string,
  args: Record<string, string>,
): Promise<boolean> {
  const store = useSandboxesStore();

  store.setError('');
  store.setBusy(task, true);

  try {
    const started = await sandboxApi.run(task, action, args);

    store.applyJob(started.job);
    await loadSandboxes();

    return true;
  } catch (error) {
    store.setError(sandboxErrorMessage(error, 'Запустить действие не удалось.'));

    return false;
  } finally {
    store.setBusy(task, false);
  }
}
