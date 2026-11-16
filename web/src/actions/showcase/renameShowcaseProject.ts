import { showcaseApi, showcaseErrorMessage } from '../../shared/showcaseApi';
import { loadShowcase } from './loadShowcase';
import type { ShowcaseStore } from './showcaseRuntime';
import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);


/**
 * Переименование открытого ролика. Имя ему даёт сервер по стенду, но человек вправе
 * назвать ролик по-своему — например, по фиче, а не по номеру задачи. Правка уходит
 * со своей редакцией, как любая другая, и обновляет список: там то же название.
 */
export async function renameShowcaseProject(store: ShowcaseStore, title: string): Promise<boolean> {
  const opened = store.opened;
  const next = title.trim();

  if (!opened || !next || next === opened.title) {
    return false;
  }

  store.setBusy(opened.id, true);

  try {
    store.setOpened(await showcaseApi.rename(opened.id, opened.revision, next));
    store.setError('');
    await loadShowcase(store);

    return true;
  } catch (error) {
    store.setError(
      showcaseErrorMessage(error, translateUi('core.renameShowcaseProjectCouldNotRenameTheVideo')),
    );

    return false;
  } finally {
    store.setBusy(opened.id, false);
  }
}
