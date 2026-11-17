import { showcaseApi, showcaseErrorMessage } from '../../shared/showcaseApi';
import type { ShowcaseStore } from './showcaseRuntime';
import { beginShowcaseNavigation } from './showcaseRuntime';
import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);


/**
 * Явное открытие по маршруту допускается без owner. Фоновое перечитывание передаёт
 * владельца и не может превратиться в позднюю навигацию или ошибку другой карточки.
 */
export async function openShowcaseProject(
  store: ShowcaseStore,
  id: string,
  isCurrent?: () => boolean,
): Promise<boolean> {
  const current = isCurrent ?? beginShowcaseNavigation(store);

  if (!current()) {
    return false;
  }

  try {
    const project = await showcaseApi.project(id);

    if (!current()) {
      return false;
    }

    // Более поздняя редакция того же ролика могла прийти прямым ответом/SSE.
    // Старый GET не откатывает её, даже если карточка и эпоха остались прежними.
    const opened = store.opened;

    if (opened?.id === id && opened.revision > project.revision) {
      return true;
    }

    store.setOpened(project);
    store.setError('');

    return true;
  } catch (error) {
    if (current()) {
      store.setError(
        showcaseErrorMessage(error, translateUi('core.openShowcaseProjectCouldNotOpenTheVideo')),
      );
    }

    return false;
  }
}

/**
 * Закрытие карточки. Список перечитывается отдельным обзором, а не собирается из
 * запомненного: пока карточка была открыта, роликов могло стать больше или меньше.
 */
export function closeShowcaseProject(store: ShowcaseStore): void {
  beginShowcaseNavigation(store);
  store.setOpened(null);
}
