import { showcaseApi, showcaseErrorMessage } from '../../shared/showcaseApi';
import { runtimeOf } from './showcaseRuntime';
import type { ShowcaseStore } from './showcaseRuntime';

/**
 * Обзор раздела. Одновременные вызовы разделяют один запрос: список открывают
 * и переходом по ссылке, и переподключением событий, а два одинаковых обзора
 * подряд отличались бы только тем, чей ответ пришёл вторым.
 */
export function loadShowcase(store: ShowcaseStore): Promise<void> {
  const runtime = runtimeOf(store);

  if (runtime.loading) {
    return runtime.loading;
  }

  store.setLoading(true);

  const request = showcaseApi.overview()
    .then((overview) => {
      store.setOverview(overview);
      store.setError('');
    })
    .catch((error: unknown) => {
      store.setError(showcaseErrorMessage(error, 'Не удалось прочитать список роликов.'));
    })
    .finally(() => {
      runtime.loading = null;
      store.setLoading(false);
    });

  runtime.loading = request;

  return request;
}
