import { useRoutesStore } from '../../stores/routes.ts';
import { runtimeOf } from './routesRuntime.ts';
import { cancelDraftSave } from './save.ts';

/**
 * Закрывает черновик и очищает состояние редактора.
 * Старые ответы запросов после закрытия не должны открыть черновик снова.
 */
export function closeDraft({ keepDocument = false }: { keepDocument?: boolean } = {}): void {
  const store = useRoutesStore();

  cancelDraftSave();

  const runtime = runtimeOf(store);

  runtime.openRequest += 1;
  runtime.editorRequest += 1;
  runtime.listRequest += 1;
  runtime.savePromise = null;
  runtime.pendingDraftRevision = null;

  if (keepDocument && store.opened) {
    store.opened = { ...store.opened, readOnly: true };
    store.loading = false;
    store.saving = false;

    return;
  }

  store.opened = null;
  store.serverSnapshot = null;
  store.localDocument = null;
  store.publishedSnapshot = null;
  store.loading = false;
  store.error = '';
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
  store.pendingOperationId = null;
  store.receipt = null;
  store.publicationOutcome = 'idle';
  store.publicationError = '';
}
