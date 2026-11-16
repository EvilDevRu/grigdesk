import { sandboxApi, sandboxErrorMessage } from '../../shared/sandboxApi';
import { useSandboxesStore } from '../../stores/sandboxes';
import { loadSandboxes } from './loadSandboxes';
import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);


/**
 * Снос идёт скриптом профиля и тоже занимает время, поэтому кнопка стенда
 * блокируется до ответа, а состояние перечитывается сразу после него.
 */
export async function dismantleSandbox(task: string, force = false, profile?: string): Promise<void> {
  const store = useSandboxesStore();

  store.setError('');
  store.setBusy(task, true);

  try {
    const started = await sandboxApi.dismantle(task, force, profile);

    store.applyJob(started.job);
    await loadSandboxes();
  } catch (error) {
    store.setError(
      sandboxErrorMessage(error, translateUi('core.dismantleSandboxCouldNotRemoveTheEnvironment')),
    );
  } finally {
    store.setBusy(task, false);
  }
}
