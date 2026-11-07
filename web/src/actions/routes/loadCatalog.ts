import { failureText } from '../../shared/apiClient.ts';
import { useRoutesStore } from '../../stores/routes.ts';
import { runtimeOf } from './routesRuntime.ts';
import { cancelDraftSave } from './save.ts';

/**
 * Загружает полный опубликованный каталог для чтения и сравнения.
 * Результат запроса применяется лишь пока открыт тот же каталог.
 */
export async function loadCatalog(profile: string, catalogHash: string): Promise<void> {
  const store = useRoutesStore();
  const runtime = runtimeOf(store);
  const request = ++runtime.openRequest;

  store.loading = true;
  store.error = '';

  try {
    const content = await runtime.api.catalog(profile, catalogHash);

    if (request !== runtime.openRequest) {
      return;
    }

    cancelDraftSave();
    runtime.savePromise = null;
    runtime.pendingDraftRevision = null;
    store.opened = {
      profile,
      catalogHash,
      readOnly: true
    };
    store.publishedSnapshot = structuredClone(content);
    store.serverSnapshot = null;
    store.localDocument = null;
    store.editGeneration = 0;
    store.historyPast = [];
    store.historyFuture = [];
    store.historyGroup = null;
    store.inFlightGeneration = null;
    store.dirty = false;
    store.saving = false;
    store.saveError = '';
    store.conflict = false;
    store.validationIssues = [];
    store.validatedRevision = null;
    store.validatedGeneration = null;
    store.validatedCapabilitiesHash = null;
    store.compareReport = null;
    store.compareGeneration = null;
    store.rebasePreview = null;
    store.rebaseGeneration = null;
    store.rebaseBusy = false;
    store.rebaseError = '';
    store.promptPreview = null;
    store.promptPreviewBusy = false;
    store.promptPreviewError = '';
    store.simulation = null;
    store.simulationError = '';
    store.jsonBuffer = null;
  } catch (error) {
    if (request === runtime.openRequest) {
      store.error = failureText(error, 'Не удалось прочитать опубликованный каталог.');
    }
  } finally {
    if (request === runtime.openRequest) {
      store.loading = false;
    }
  }
}
