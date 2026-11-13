import { showcaseApi, showcaseErrorMessage } from '../../shared/showcaseApi';
import { openShowcaseProject } from './openShowcaseProject';
import type { ShowcaseStore } from './showcaseRuntime';
import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);


export interface SeedStatus {
  available: boolean;
  reason: string;
  recipeFingerprint: string;
  profile: string;
  targetLabel: string;
}

/**
 * Состояние подготовки данных для открытого ролика. Спрашивается отдельно от
 * карточки: ответ зависит от живого состояния стенда, и держать его в записи
 * ролика значило бы показывать вчерашнюю доступность.
 */
export async function loadSeedStatus(store: ShowcaseStore): Promise<SeedStatus | null> {
  const opened = store.opened;

  if (!opened) {
    return null;
  }

  try {
    return await showcaseApi.seedStatus(opened.id);
  } catch (error) {
    store.setError(
      showcaseErrorMessage(error, translateUi('core.prepareShowcaseDataCouldNotReadDataPreparationOptions')),
    );

    return null;
  }
}

/**
 * Запуск подготовки. Отпечаток рецепта уходит вместе с запросом: подтверждали
 * конкретный скрипт на конкретном стенде, и сервер это проверит ещё раз.
 */
export async function prepareShowcaseData(
  store: ShowcaseStore,
  recipeFingerprint: string,
): Promise<string> {
  const opened = store.opened;

  if (!opened) {
    return '';
  }

  store.setBusy(opened.id, true);

  try {
    const outcome = await showcaseApi.prepareData(opened.id, recipeFingerprint);

    await openShowcaseProject(store, opened.id);

    return outcome.reason;
  } catch (error) {
    store.setError(showcaseErrorMessage(error, translateUi('core.prepareShowcaseDataDataPreparationFailed')));

    return '';
  } finally {
    store.setBusy(opened.id, false);
  }
}

/**
 * Отметка «данные обновлены». Это решение человека: раздел не обещает заметить
 * внешнюю правку базы и не притворяется, что заметил.
 */
export async function markShowcaseDataUpdated(store: ShowcaseStore): Promise<boolean> {
  const opened = store.opened;

  if (!opened) {
    return false;
  }

  try {
    await showcaseApi.markDataUpdated(opened.id);
    await openShowcaseProject(store, opened.id);

    return true;
  } catch (error) {
    store.setError(
      showcaseErrorMessage(error, translateUi('core.prepareShowcaseDataCouldNotMarkTheDataAsUpdated')),
    );

    return false;
  }
}
