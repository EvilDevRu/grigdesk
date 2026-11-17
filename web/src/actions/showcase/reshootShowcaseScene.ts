import { showcaseApi, showcaseErrorMessage } from '../../shared/showcaseApi';
import type { ShowcaseStore } from './showcaseRuntime';
import { showcaseProjectOwner } from './showcaseRuntime';
import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);

/**
 * Пересъёмка адресует сцену исходного ролика. Запущенный job остаётся в общем
 * списке после ухода, но поздняя ошибка не меняет другую открытую карточку.
 */
export async function reshootShowcaseScene(
  store: ShowcaseStore,
  projectId: string,
  sceneId: string,
): Promise<boolean> {
  const current = showcaseProjectOwner(store, projectId);

  if (!current()) {
    return false;
  }

  store.setBusy(projectId, true);

  try {
    const job = await showcaseApi.startRecording(projectId, sceneId);

    store.applyJob(job);

    if (current()) {
      store.setError('');
    }

    return current();
  } catch (error) {
    if (current()) {
      store.setError(showcaseErrorMessage(error, translateUi('core.showcaseNeUdalosPeresnyatScenu')));
    }

    return false;
  } finally {
    store.setBusy(projectId, false);
  }
}
