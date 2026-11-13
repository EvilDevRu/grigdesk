import { failureText } from '../../shared/apiClient.ts';
import { useRoutesStore } from '../../stores/routes.ts';
import { runtimeOf } from './routesRuntime.ts';
import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);


/**
 * Запрашивает доступные черновики текущего профиля.
 * Список обновляется только ответом последнего запроса профиля.
 */
export async function loadDrafts(profile: string): Promise<void> {
  const store = useRoutesStore();
  const runtime = runtimeOf(store);
  const request = ++runtime.listRequest;

  try {
    const drafts = await runtime.api.drafts(profile);

    if (request !== runtime.listRequest) {
      return;
    }

    store.drafts = drafts;
    store.draftsProfile = profile;
  } catch (error) {
    if (request === runtime.listRequest) {
      store.error = failureText(error, translateUi('core.loadDraftsCouldNotReadTheDraftList'));
    }
  }
}
