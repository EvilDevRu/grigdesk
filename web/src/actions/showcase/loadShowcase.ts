import { showcaseApi, showcaseErrorMessage } from '../../shared/showcaseApi';
import { runtimeOf } from './showcaseRuntime';
import type { ShowcaseStore } from './showcaseRuntime';

/**
 * Обзор раздела. Одновременные вызовы разделяют один запрос: список открывают
 * и переходом по ссылке, и переподключением событий, а два одинаковых обзора
 * подряд отличались бы только тем, чей ответ пришёл вторым.
 */
export function loadShowcase(store: ShowcaseStore,
  { fresh = false }: { fresh?: boolean } = {},): Promise<void> {
  const runtime = runtimeOf(store);

  if (fresh) {
    runtime.generation += 1;
    runtime.refreshPending = true;
  }

  if (runtime.loading) {
    return runtime.loading;
  }

  store.setLoading(true);
  runtime.loading = (async () => {
    do {
      runtime.refreshPending = false;

      const generation = runtime.generation;

      try {
        const overview = await showcaseApi.overview();

        if (generation === runtime.generation) {
          store.setOverview(overview);
          store.setError('');
        }
      } catch (error) {
        if (generation === runtime.generation) {
          store.setError(showcaseErrorMessage(error, 'Не удалось прочитать список роликов.'));
        }
      }
    } while (runtime.refreshPending);
  })().finally(() => {
    runtime.loading = null;
    store.setLoading(false);
  });

  return runtime.loading;
}
