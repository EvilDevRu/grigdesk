import type { DraftOperation, RouteDraft } from '../../../../shared/pipeline/routesEditorContracts.ts';
import { failureText } from '../../shared/apiClient.ts';
import { useRoutesStore } from '../../stores/routes.ts';
import { runtimeOf } from './routesRuntime.ts';
import { endHistoryGroup as clearHistoryGroup, recordHistory, travelHistory } from './history.ts';
import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);


const AUTOSAVE_DELAY_MS = 800;

function copy(draft: RouteDraft): RouteDraft {
  return JSON.parse(JSON.stringify(draft)) as RouteDraft;
}

function changed(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) !== JSON.stringify(right);
}

/** Все связанные правки одного маршрута, включая инструкции, уходят одним PATCH. */
/**
 * Строит операции обновления из различий двух снимков черновика.
 * Автосохранение допускает один запрос и не затирает более свежий локальный ввод.
 */
function operationsBetween(before: RouteDraft, after: RouteDraft): DraftOperation[] {
  const operations: DraftOperation[] = [];

  if (before.title !== after.title) {
    operations.push({ kind: 'setTitle', title: after.title });
  }

  const routeIds = new Set([...Object.keys(before.routes), ...Object.keys(after.routes)]);

  for (const routeId of [...routeIds].sort()) {
    const previous = before.routes[routeId];
    const next = after.routes[routeId];

    if (!next) {
      operations.push({ kind: 'removeRoute', routeId });
    } else if (!previous || changed(previous, next)) {
      operations.push({
        kind: 'putRoute',
        routeId,
        route: next.route,
        prompts: next.prompts
      });
    }
  }

  if (changed(before.bootstrap, after.bootstrap)
    || changed(before.bootstrapPrompts, after.bootstrapPrompts)) {
    operations.push({
      kind: 'putBootstrap',
      bootstrap: after.bootstrap,
      prompts: after.bootstrapPrompts
    });
  }
  if (changed(before.presentation, after.presentation)) {
    operations.push({ kind: 'putPresentation', presentation: after.presentation });
  }
  if (changed(before.provenance, after.provenance)) {
    operations.push({ kind: 'putProvenance', provenance: after.provenance });
  }

  return operations;
}

function resetTimer(): void {
  const runtime = runtimeOf(useRoutesStore());

  if (runtime.saveTimer !== null) {
    runtime.scheduler.clearTimeout(runtime.saveTimer);
  }

  runtime.saveTimer = null;
}

/**
 * Отменяет ожидающий таймер автосохранения при закрытии или конфликте.
 * Автосохранение допускает один запрос и не затирает более свежий локальный ввод.
 */
export function cancelDraftSave(): void {
  resetTimer();
  runtimeOf(useRoutesStore()).saveQueued = false;
}

/**
 * Назначает отложенную запись локальных правок.
 * Автосохранение допускает один запрос и не затирает более свежий локальный ввод.
 */
export function scheduleDraftSave(): void {
  const store = useRoutesStore();
  const runtime = runtimeOf(store);

  resetTimer();

  if (!store.dirty || store.conflict || store.opened?.readOnly) {
    return;
  }

  runtime.saveTimer = runtime.scheduler.setTimeout(() => {
    runtime.saveTimer = null;

    if (runtime.savePromise) {
      runtime.saveQueued = true;
    } else {
      void saveDraft();
    }
  }, AUTOSAVE_DELAY_MS);
}

/**
 * Применяет структурную правку и фиксирует её в истории отмены.
 * Автосохранение допускает один запрос и не затирает более свежий локальный ввод.
 */
export function applyLocalChange(change: (draft: RouteDraft) => void,
  options: { historyGroup?: string } = {}): void {
  const store = useRoutesStore();

  if (!store.localDocument || !store.serverSnapshot || store.opened?.readOnly) {
    return;
  }

  const next = copy(store.localDocument);

  change(next);

  if (!changed(store.localDocument, next)) {
    return;
  }

  recordHistory(store, store.localDocument, options.historyGroup);
  store.localDocument = next;
  store.editGeneration += 1;

  if (store.promptPreview) {
    store.promptPreview.stale = true;
  }
  if (store.simulation) {
    store.simulation.stale = true;
  }

  store.rebasePreview = null;
  store.rebaseGeneration = null;
  store.dirty = operationsBetween(store.serverSnapshot, next).length > 0;
  store.saveError = '';
  scheduleDraftSave();
}

/**
 * Перемещает локальное состояние по истории отмены или повтора.
 * Автосохранение допускает один запрос и не затирает более свежий локальный ввод.
 */
function travel(direction: 'undo' | 'redo'): boolean {
  const store = useRoutesStore();

  if (!store.localDocument || !store.serverSnapshot || store.opened?.readOnly) {
    return false;
  }

  const next = travelHistory(store, store.localDocument, direction);

  if (!next) {
    return false;
  }

  store.localDocument = next;
  store.editGeneration += 1;

  if (store.promptPreview) {
    store.promptPreview.stale = true;
  }
  if (store.simulation) {
    store.simulation.stale = true;
  }

  store.rebasePreview = null;
  store.rebaseGeneration = null;
  store.dirty = operationsBetween(store.serverSnapshot, next).length > 0;
  store.saveError = '';
  scheduleDraftSave();

  return true;
}

/**
 * Возвращает предыдущий авторский снимок черновика.
 * Автосохранение допускает один запрос и не затирает более свежий локальный ввод.
 */
export function undoDraft(): boolean {
   return travel('undo');
}

/**
 * Повторно применяет отменённый авторский снимок.
 * Автосохранение допускает один запрос и не затирает более свежий локальный ввод.
 */
export function redoDraft(): boolean {
   return travel('redo');
}

/**
 * Закрывает группу связанных локальных правок.
 * Автосохранение допускает один запрос и не затирает более свежий локальный ввод.
 */
export function endHistoryGroup(): void {
   clearHistoryGroup(useRoutesStore());
}

/**
 * Отправляет изменения с ревизией CAS и обрабатывает ответ сервера.
 * Автосохранение допускает один запрос и не затирает более свежий локальный ввод.
 */
export async function saveDraft(): Promise<void> {
  const store = useRoutesStore();
  const runtime = runtimeOf(store);

  resetTimer();

  if (runtime.savePromise) {
    runtime.saveQueued = true;

    return runtime.savePromise;
  }

  const opened = store.opened;
  const before = store.serverSnapshot;
  const local = store.localDocument;

  if (!opened?.draftId || opened.readOnly || !before || !local || store.conflict) {
    return;
  }
  if (store.jsonBuffer?.dirty) {
    store.saveError = translateUi('core.saveApplyOrDiscardTheUnsavedJSONText');

    return;
  }

  const operations = operationsBetween(before, local);

  if (operations.length === 0) {
    store.dirty = false;

    return;
  }

  const requestIdentity = runtime.openRequest;
  const sentGeneration = store.editGeneration;

  store.saving = true;
  store.inFlightGeneration = sentGeneration;
  store.saveError = '';

  let request!: Promise<void>;

  request = (async () => {
    try {
      const response = await runtime.api.patchDraft(opened.profile, opened.draftId!,
        before.revision, operations);

      if (requestIdentity !== runtime.openRequest || store.opened?.draftId !== opened.draftId
        || store.opened?.profile !== opened.profile) {
        return;
      }

      const newerLocal = store.localDocument;

      store.serverSnapshot = copy(response);

      if (store.editGeneration === sentGeneration || !newerLocal) {
        store.localDocument = copy(response);
      } else {
        const current = copy(newerLocal);

        store.localDocument = {
          ...copy(response),
          title: current.title,
          routes: current.routes,
          bootstrap: current.bootstrap,
          bootstrapPrompts: current.bootstrapPrompts,
          presentation: current.presentation,
          provenance: current.provenance
        };
      }

      store.dirty = operationsBetween(store.serverSnapshot, store.localDocument).length > 0;
      store.saveError = '';

      if (runtime.pendingDraftRevision !== null) {
        if (runtime.pendingDraftRevision > response.revision && store.dirty) {
          store.conflict = true;
          store.saveError = translateUi('core.saveTheDraftChangedInAnotherTab');
          cancelDraftSave();
        }

        runtime.pendingDraftRevision = null;
      }
    } catch (error) {
      if (requestIdentity === runtime.openRequest) {
        store.saveError = failureText(error, translateUi('core.saveCouldNotSaveTheDraft'));
        store.dirty = true;

        if ((error as { status?: unknown } | null)?.status === 409) {
          store.conflict = true;
          cancelDraftSave();
        }
      }
    } finally {
      if (runtime.savePromise === request) {
        runtime.savePromise = null;
      }
      if (requestIdentity === runtime.openRequest
        && store.opened?.draftId === opened.draftId
        && store.opened?.profile === opened.profile) {
        store.saving = false;
        store.inFlightGeneration = null;

        if (runtime.saveQueued && store.dirty && !store.saveError && !store.conflict) {
          runtime.saveQueued = false;
          void saveDraft();
        } else {
          runtime.saveQueued = false;
        }
      }
    }
  })();
  runtime.savePromise = request;
  await request;
}
