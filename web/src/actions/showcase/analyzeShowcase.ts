import { showcaseApi, showcaseErrorMessage } from '../../shared/showcaseApi';
import type { ShowcaseStore } from './showcaseRuntime';

/**
 * Разбор стенда: сервер сам читает связанную задачу и код, а затем предлагает
 * бриф и сцены. Шаг долгий — модель отвечает не мгновенно, поэтому ролик помечен
 * занятым всё это время, а не только на время запроса.
 */
export async function analyzeShowcase(store: ShowcaseStore): Promise<boolean> {
  const opened = store.opened;

  if (!opened) {
    return false;
  }

  store.setBusy(opened.id, true);

  try {
    store.setOpened(await showcaseApi.analyze(opened.id));
    store.setError('');

    return true;
  } catch (error) {
    store.setError(showcaseErrorMessage(error, 'Не удалось разобрать стенд.'));

    return false;
  } finally {
    store.setBusy(opened.id, false);
  }
}
