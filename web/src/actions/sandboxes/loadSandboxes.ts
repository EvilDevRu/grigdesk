import { sandboxApi, sandboxErrorMessage } from '../../shared/sandboxApi';
import { useSandboxesStore } from '../../stores/sandboxes';
import { runtimeOf } from './sandboxesRuntime';

/**
 * Обзор целиком: профили, стенды и задания приходят одним ответом, потому что
 * показывают одно состояние — что сейчас поднято и что с этим происходит.
 *
 * Запрос один на всех: действие человека и событие сервера приходят почти
 * одновременно, и без этого раздел читал бы одно и то же состояние дважды.
 */
export function loadSandboxes(): Promise<void> {
  const store = useSandboxesStore();
  const runtime = runtimeOf(store);

  if (runtime.loading) {
    return runtime.loading;
  }

  store.setLoading(true);
  runtime.loading = (async () => {
    try {
      store.setOverview(await sandboxApi.overview());
      store.setError('');
    } catch (error) {
      store.setError(sandboxErrorMessage(error, 'Не удалось прочитать состояние песочниц.'));
    } finally {
      store.setLoading(false);
      runtime.loading = null;
    }
  })();

  return runtime.loading;
}
