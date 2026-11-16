import { failureText } from '../../shared/apiClient.ts';
import type { DraftCreateRequest } from '../../shared/routesApi.ts';
import { useRoutesStore } from '../../stores/routes.ts';
import { runtimeOf } from './routesRuntime.ts';
import { cancelDraftSave } from './save.ts';
import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);


/**
 * Создаёт черновик полного каталога и открывает его в редакторе.
 * Поздний ответ не должен заменить более новый открытый документ.
 */
export async function createDraft(profile: string, input: DraftCreateRequest): Promise<void> {
  const store = useRoutesStore();
  const runtime = runtimeOf(store);
  const request = ++runtime.openRequest;

  store.loading = true;
  store.error = '';

  try {
    const draft = await runtime.api.createDraft(profile, input);

    if (request !== runtime.openRequest) {
      return;
    }

    cancelDraftSave();
    runtime.savePromise = null;
    runtime.pendingDraftRevision = null;
    store.opened = {
      profile,
      draftId: draft.id,
      readOnly: draft.state !== 'editing'
    };
    store.serverSnapshot = structuredClone(draft);
    store.localDocument = structuredClone(draft);
    store.publishedSnapshot = null;
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
      store.error = failureText(error, translateUi('core.createDraftCouldNotCreateADraft'));
    }
  } finally {
    if (request === runtime.openRequest) {
      store.loading = false;
    }
  }
}
