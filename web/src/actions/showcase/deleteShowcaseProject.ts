import { showcaseApi, showcaseErrorMessage } from '../../shared/showcaseApi';
import { loadShowcase } from './loadShowcase';
import type { ShowcaseStore } from './showcaseRuntime';

/**
 * Удаляет ролик вместе с его артефактами. Сервер сначала снимает задания и
 * освобождает ссылки: снести файлы, на которые смотрит идущая сборка, — верный
 * способ получить наполовину записанный ролик без владельца.
 */
export async function deleteShowcaseProject(store: ShowcaseStore, id: string): Promise<boolean> {
  store.setBusy(id, true);

  try {
    await showcaseApi.remove(id);

    if (store.opened?.id === id) {
      store.setOpened(null);
    }

    await loadShowcase(store);

    return true;
  } catch (error) {
    store.setError(showcaseErrorMessage(error, 'Не удалось удалить ролик.'));

    return false;
  } finally {
    store.setBusy(id, false);
  }
}
