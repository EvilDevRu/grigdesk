import { failureText } from '../../shared/apiClient.ts';
import { useRoutesStore } from '../../stores/routes.ts';
import { runtimeOf } from './routesRuntime.ts';

function uncertain(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;

  return name === 'TimeoutError' || name === 'AbortError' || name === 'TypeError';
}

/**
 * Создаёт устойчивый ключ операции для пары профиль и черновик.
 * Идентификатор операции сохраняется для выяснения исхода после потери ответа.
 */
export function publicationDraftKey(profile: string, draftId: string): string {
  return JSON.stringify([profile, draftId]);
}

/**
 * Выясняет фактический исход публикации по её идентификатору.
 * Идентификатор операции сохраняется для выяснения исхода после потери ответа.
 */
export async function checkPublicationOutcome(): Promise<void> {
  const store = useRoutesStore();
  const opened = store.opened;
  const operationId = store.pendingOperationId;

  if (!opened?.draftId || !operationId) {
    return;
  }

  const key = publicationDraftKey(opened.profile, opened.draftId);

  if (store.pendingOperations[key] !== operationId) {
    return;
  }

  const runtime = runtimeOf(store);
  const identity = runtime.openRequest;

  try {
    const receipt = await runtime.api.publicationStatus(opened.profile, operationId);

    if (identity !== runtime.openRequest || store.opened?.draftId !== opened.draftId
      || store.pendingOperationId !== operationId) {
      return;
    }

    store.receipt = receipt;
    store.pendingOperationId = null;
    delete store.pendingOperations[key];
    store.publicationOutcome = receipt.state;
    store.publicationError = receipt.state === 'committed' ? '' : 'Публикация не выполнена.';

    if (receipt.state === 'committed') {
      store.opened = { ...opened, readOnly: true };
    }
  } catch (error) {
    if (identity !== runtime.openRequest || store.opened?.draftId !== opened.draftId) {
      return;
    }

    store.publicationOutcome = 'unknown';
    store.publicationError = 'Итог публикации пока неизвестен. Проверьте операцию снова.';
  }
}

/**
 * Публикует только предварительно сравнённую и сохранённую ревизию.
 * Идентификатор операции сохраняется для выяснения исхода после потери ответа.
 */
export async function publishComparedDraft(comment = ''): Promise<void> {
  const store = useRoutesStore();
  const runtime = runtimeOf(store);

  if (runtime.publishPromise) {
    return runtime.publishPromise;
  }

  const opened = store.opened;
  const draft = store.serverSnapshot;
  const report = store.compareReport;

  if (!opened?.draftId || !draft || !report || !store.canConfirmPublish) {
    return;
  }

  const publicationComment = comment.trim();

  if (new TextEncoder().encode(publicationComment).length > 2000) {
    store.publicationError = 'Комментарий публикации слишком длинный (максимум 2000 байт).';

    return;
  }

  const key = publicationDraftKey(opened.profile, opened.draftId);
  const operationId = store.pendingOperations[key] ?? runtime.operationId();
  const identity = runtime.openRequest;

  store.pendingOperationId = operationId;
  store.pendingOperations[key] = operationId;
  store.publicationError = '';
  store.publicationOutcome = 'pending';

  let request!: Promise<void>;

  request = (async () => {
    try {
      const receipt = await runtime.api.publishDraft(opened.profile, opened.draftId!, {
        expectedRevision: report.draftRevision,
        expectedCatalogHash: report.currentCatalogHash,
        expectedSourceRevision: report.sourceRevision,
        operationId,
        ...(publicationComment ? { comment: publicationComment } : {}),
      });

      if (identity !== runtime.openRequest || store.opened?.draftId !== opened.draftId) {
        return;
      }

      store.receipt = receipt;
      store.pendingOperationId = null;
      delete store.pendingOperations[key];
      store.publicationOutcome = receipt.state;

      if (receipt.state === 'committed') {
        store.opened = { ...opened, readOnly: true };
      } else {
        store.publicationError = 'Публикация не выполнена.';
      }
    } catch (error) {
      if (identity === runtime.openRequest) {
        if (uncertain(error)) {
          await checkPublicationOutcome();
        } else {
          store.publicationError = failureText(error, 'Публикация не выполнена.');
          store.pendingOperationId = null;
          delete store.pendingOperations[key];

          if ((error as { status?: unknown } | null)?.status === 409) {
            store.publicationOutcome = 'conflict';
            store.compareGeneration = null;
          } else {
            store.publicationOutcome = 'idle';
          }
        }
      }
    } finally {
      if (runtime.publishPromise === request) {
        runtime.publishPromise = null;
      }
    }
  })();
  runtime.publishPromise = request;
  await request;
}
