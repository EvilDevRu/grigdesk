import { showcaseApi, showcaseErrorMessage } from '../../shared/showcaseApi';
import { openShowcaseProject } from './openShowcaseProject';
import { showcaseProjectOwner } from './showcaseRuntime';
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

  const current = showcaseProjectOwner(store, opened.id);

  try {
    const status = await showcaseApi.seedStatus(opened.id);

    return current() ? status : null;
  } catch (error) {
    if (current()) {
      store.setError(
        showcaseErrorMessage(
          error, translateUi('core.prepareShowcaseDataCouldNotReadDataPreparationOptions'),
        ),
      );
    }

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

  const current = showcaseProjectOwner(store, opened.id);

  store.setBusy(opened.id, true);

  try {
    const outcome = await showcaseApi.prepareData(opened.id, recipeFingerprint);

    if (!current() || !await openShowcaseProject(store, opened.id, current)) {
      return '';
    }

    return outcome.reason;
  } catch (error) {
    if (current()) {
      store.setError(
        showcaseErrorMessage(error, translateUi('core.prepareShowcaseDataDataPreparationFailed')),
      );
    }

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

  const current = showcaseProjectOwner(store, opened.id);

  try {
    await showcaseApi.markDataUpdated(opened.id);

    return current() && await openShowcaseProject(store, opened.id, current);
  } catch (error) {
    if (current()) {
      store.setError(
        showcaseErrorMessage(error, translateUi('core.prepareShowcaseDataCouldNotMarkTheDataAsUpdated')),
      );
    }

    return false;
  }
}
