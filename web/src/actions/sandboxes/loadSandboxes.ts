import { sandboxApi, sandboxErrorMessage } from '../../shared/sandboxApi';
import { useSandboxesStore } from '../../stores/sandboxes';
import { runtimeOf } from './sandboxesRuntime';
import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);


/**
 * Обзор целиком: профили, стенды и задания приходят одним ответом, потому что
 * показывают одно состояние — что сейчас поднято и что с этим происходит.
 *
 * Запрос один на всех: действие человека и событие сервера приходят почти
 * одновременно, и без этого раздел читал бы одно и то же состояние дважды.
 */
export function loadSandboxes({ fresh = false }: { fresh?: boolean } = {}): Promise<void> {
  const store = useSandboxesStore();
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
        const overview = await sandboxApi.overview();

        if (generation === runtime.generation) {
          store.setOverview(overview);
          store.setError('');
        }
      } catch (error) {
        if (generation === runtime.generation) {
          store.setError(
            sandboxErrorMessage(error, translateUi('core.loadSandboxesCouldNotReadSandboxStatus')),
          );
        }
      }
    } while (runtime.refreshPending);
  })().finally(() => {
    runtime.loading = null;
    store.setLoading(false);
  });

  return runtime.loading;
}
