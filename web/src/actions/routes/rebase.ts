import type { RouteRebaseResolution } from '../../../../shared/routesEditorContracts.ts';

import { failureText } from '../../shared/apiClient.ts';
import { useRoutesStore } from '../../stores/routes.ts';
import { runtimeOf } from './routesRuntime.ts';
import { cancelDraftSave } from './save.ts';

/** Читает три точных документа только для сохранённой версии черновика. */
/**
 * Получает трёхстороннее сравнение с новым текущим каталогом.
 * Конфликты разрешаются явно, а исходный черновик не перезаписывается молча.
 */
export async function previewDraftRebase(): Promise<void> {
  const store = useRoutesStore();
  const opened = store.opened;
  const snapshot = store.serverSnapshot;

  if (!opened?.draftId || opened.readOnly || !snapshot || store.rebaseBusy) {
    return;
  }
  if (store.dirty || store.saving || store.conflict) {
    store.rebaseError = 'Сначала сохраните черновик или разрешите конфликт записи.';

    return;
  }

  const runtime = runtimeOf(store);
  const identity = runtime.openRequest;
  const generation = store.editGeneration;

  store.rebaseBusy = true;
  store.rebaseError = '';

  try {
    const preview = await runtime.api.previewRebase(opened.profile, opened.draftId);

    if (identity !== runtime.openRequest || generation !== store.editGeneration
      || store.opened?.draftId !== opened.draftId
      || store.serverSnapshot?.revision !== snapshot.revision) {
      return;
    }

    store.rebasePreview = preview;
    store.rebaseGeneration = generation;
  } catch (error) {
    if (identity === runtime.openRequest) {
      store.rebaseError = failureText(error, 'Не удалось сравнить основания каталога.');
    }
  } finally {
    if (identity === runtime.openRequest) {
      store.rebaseBusy = false;
    }
  }
}

/** Подтверждает выбранные целые единицы; ответ заменяет снимок без старого validation. */
/**
 * Применяет выбранные решения конфликтов к черновику.
 * Конфликты разрешаются явно, а исходный черновик не перезаписывается молча.
 */
export async function applyDraftRebase(resolutions: RouteRebaseResolution[]): Promise<void> {
  const store = useRoutesStore();
  const opened = store.opened;
  const preview = store.rebasePreview;

  if (!opened?.draftId || opened.readOnly || !preview || store.rebaseBusy
    || preview.draftId !== opened.draftId
    || store.dirty || store.saving || store.conflict
    || store.rebaseGeneration !== store.editGeneration
    || store.serverSnapshot?.revision !== preview.draftRevision) {
    return;
  }

  const runtime = runtimeOf(store);
  const identity = runtime.openRequest;

  store.rebaseBusy = true;
  store.rebaseError = '';

  try {
    const rebased = await runtime.api.rebaseDraft(opened.profile, opened.draftId, {
      expectedDraftRevision: preview.draftRevision,
      expectedCatalogHash: preview.currentCatalogHash,
      resolutions,
    });

    if (identity !== runtime.openRequest || store.opened?.draftId !== opened.draftId) {
      return;
    }

    cancelDraftSave();
    store.serverSnapshot = structuredClone(rebased);
    store.localDocument = structuredClone(rebased);
    store.editGeneration = 0;
    store.historyPast = [];
    store.historyFuture = [];
    store.historyGroup = null;
    store.dirty = false;
    store.saving = false;
    store.conflict = false;
    store.validationIssues = [];
    store.validatedRevision = null;
    store.validatedGeneration = null;
    store.validatedCapabilitiesHash = null;
    store.compareReport = null;
    store.compareGeneration = null;
    store.rebasePreview = null;
    store.rebaseGeneration = null;
    store.promptPreview = null;
  } catch (error) {
    if (identity === runtime.openRequest) {
      store.rebaseError = failureText(error, 'Не удалось перенести черновик.');

      if ((error as { status?: number } | null)?.status === 409) {
        store.rebasePreview = null;
        store.rebaseGeneration = null;
      }
    }
  } finally {
    if (identity === runtime.openRequest) {
      store.rebaseBusy = false;
    }
  }
}

/**
 * Закрывает предпросмотр переноса без изменения документа.
 * Конфликты разрешаются явно, а исходный черновик не перезаписывается молча.
 */
export function cancelDraftRebase(): void {
  const store = useRoutesStore();

  store.rebasePreview = null;
  store.rebaseGeneration = null;
  store.rebaseError = '';
}
