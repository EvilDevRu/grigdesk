import { failureText } from '../../shared/apiClient.ts';
import { useRoutesStore } from '../../stores/routes.ts';
import { runtimeOf } from './routesRuntime.ts';
import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);


export interface RoutePromptPreviewRequest {
  scope: 'route' | 'bootstrap';
  routeId: string | null;
  nodeId: string;
  context: Record<string, unknown>;
}

/** Сервер рендерит только сохранённую ревизию; более поздний ввод помечает ответ устаревшим. */
/**
 * Запрашивает итоговый текст промпта для выбранного узла и контекста.
 * Preview относится к выбранному снимку и не запускает ИИ либо профильные команды.
 */
export async function previewRoutePrompt(request: RoutePromptPreviewRequest): Promise<void> {
  const store = useRoutesStore();
  const opened = store.opened;
  const snapshot = store.serverSnapshot;

  if (!opened?.draftId || !snapshot || store.promptPreviewBusy) {
    return;
  }
  if (store.dirty || store.saving || store.conflict || store.jsonBuffer?.dirty) {
    store.promptPreviewError = translateUi('core.previewSaveTheDraftOrResolveTheSave');

    return;
  }

  const runtime = runtimeOf(store);
  const identity = runtime.openRequest;
  const generation = store.editGeneration;

  store.promptPreviewBusy = true;
  store.promptPreviewError = '';
  store.promptPreview = null;

  try {
    const result = await runtime.api.previewDraft(opened.profile, opened.draftId, {
      expectedRevision: snapshot.revision,
      ...request,
    });

    if (identity !== runtime.openRequest || store.opened?.draftId !== opened.draftId) {
      return;
    }

    store.promptPreview = {
      result,
      draftRevision: result.draftRevision,
      generation,
      scope: request.scope,
      routeId: request.routeId,
      nodeId: request.nodeId,
      stale: generation !== store.editGeneration || store.dirty
        || result.draftRevision !== store.serverSnapshot?.revision,
    };
  } catch (error) {
    if (identity === runtime.openRequest) {
      store.promptPreviewError = failureText(error, translateUi('core.previewCouldNotShowTheInstructions'));
    }
  } finally {
    if (identity === runtime.openRequest) {
      store.promptPreviewBusy = false;
    }
  }
}
