import { showcaseApi, showcaseErrorMessage } from '../../shared/showcaseApi';
import type { ShowcaseStore } from './showcaseRuntime';
import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);


/**
 * Отмена задания. Идущая работа переходит в «останавливаем»: остановить дерево
 * процессов должен исполнитель, и до его подтверждения объявлять задание
 * завершённым нельзя — иначе следующее стартует поверх ещё живого браузера.
 */
export async function cancelShowcaseJob(store: ShowcaseStore, jobId: string): Promise<boolean> {
  try {
    store.applyJob(await showcaseApi.cancelJob(jobId));

    return true;
  } catch (error) {
    store.setError(showcaseErrorMessage(error, translateUi('core.cancelShowcaseJobCouldNotCancelTheJob')));

    return false;
  }
}
