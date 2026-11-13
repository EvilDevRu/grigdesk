import { showcaseApi, showcaseErrorMessage } from '../../shared/showcaseApi';
import type { ShowcaseStore } from './showcaseRuntime';
import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);


/**
 * Открывает карточку ролика. Цель перепроверяется сервером при каждом чтении,
 * поэтому карточка сразу показывает, доступна ли запись, — отдельного шага
 * «проверить» человеку делать не приходится.
 */
export async function openShowcaseProject(store: ShowcaseStore, id: string): Promise<boolean> {
  try {
    store.setOpened(await showcaseApi.project(id));
    store.setError('');

    return true;
  } catch (error) {
    store.setError(showcaseErrorMessage(error, translateUi('core.openShowcaseProjectCouldNotOpenTheVideo')));

    return false;
  }
}

/**
 * Закрытие карточки. Список перечитывается отдельным обзором, а не собирается из
 * запомненного: пока карточка была открыта, роликов могло стать больше или меньше.
 */
export function closeShowcaseProject(store: ShowcaseStore): void {
  store.setOpened(null);
}
