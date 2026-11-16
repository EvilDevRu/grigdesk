import { failureText } from '../../shared/apiClient.ts';
import { useRoutesStore } from '../../stores/routes.ts';
import { runtimeOf } from './routesRuntime.ts';
import { cancelDraftSave } from './save.ts';
import { publicationDraftKey } from './publish.ts';
import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);


/**
 * Загружает черновик и устанавливает серверный и локальный снимки.
 * Поздний ответ не должен заменить выбранный позже черновик.
 */
export async function loadDraft(profile: string, draftId: string): Promise<void> {
  const store = useRoutesStore();
  const runtime = runtimeOf(store);
  const request = ++runtime.openRequest;

  store.loading = true;
  store.error = '';

  try {
    const response = await runtime.api.draft(profile, draftId);

    if (request !== runtime.openRequest) {
      return;
    }

    cancelDraftSave();
    runtime.savePromise = null;
    runtime.pendingDraftRevision = null;
    store.serverSnapshot = structuredClone(response);
    store.localDocument = structuredClone(response);
    store.publishedSnapshot = null;
    store.opened = {
      profile,
      draftId,
      readOnly: response.state !== 'editing'
    };
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
    store.pendingOperationId = store.pendingOperations[publicationDraftKey(profile, draftId)] ?? null;
    store.receipt = null;
    store.publicationOutcome = store.pendingOperationId ? 'unknown' : 'idle';
    store.publicationError = store.pendingOperationId
      ? translateUi('core.loadDraftThePublicationOutcomeIsStillUnknownCheck') : '';
  } catch (error) {
    if (request === runtime.openRequest) {
      store.error = failureText(error, translateUi('core.loadDraftCouldNotOpenTheRouteDraft'));
    }
  } finally {
    if (request === runtime.openRequest) {
      store.loading = false;
    }
  }
}
