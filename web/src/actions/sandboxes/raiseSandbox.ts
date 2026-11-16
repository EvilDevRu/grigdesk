import { sandboxApi, sandboxErrorMessage } from '../../shared/sandboxApi';
import { useSandboxesStore } from '../../stores/sandboxes';
import { loadSandboxes } from './loadSandboxes';
import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);


/**
 * Подъём: номер задачи необязателен, без него сервер берёт свободный служебный.
 * Отказ показывается общей полосой раздела, поэтому вызывающему возвращать нечего.
 */
export async function raiseSandbox(profile: string, task: string | null): Promise<void> {
  const store = useSandboxesStore();

  store.setError('');

  try {
    const started = await sandboxApi.raise({ profile, task });

    store.applyJob(started.job);
    await loadSandboxes();
  } catch (error) {
    store.setError(sandboxErrorMessage(error, translateUi('core.raiseSandboxCouldNotStartTheEnvironment')));
  }
}
