import { recordOrNull } from '../../../../shared/lib/objects.ts';

import { sseSubscribe } from '../../composables/useSse.ts';
import { useRoutesStore } from '../../stores/routes.ts';
import { cancelDraftSave } from './save.ts';
import { loadDraft } from './loadDraft.ts';
import { loadDrafts } from './loadDrafts.ts';
import { loadEditor } from './loadEditor.ts';
import { runtimeOf } from './routesRuntime.ts';
import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);


/**
 * Останавливает запись при обнаружении другой ревизии черновика.
 * Общий SSE-канал согласует вкладки без потери несохранённого текста.
 */
function markConflict(): void {
  const store = useRoutesStore();

  store.conflict = true;
  store.saveError = translateUi('core.saveTheDraftChangedInAnotherTab');
  cancelDraftSave();
}

/** Проверяет версию открытого документа, не заменяя несохранённый текст. */
/**
 * Сверяет открытый черновик с сервером после события или фокуса.
 * Общий SSE-канал согласует вкладки без потери несохранённого текста.
 */
async function reconcileOpenDraft(profile: string): Promise<void> {
  const store = useRoutesStore();
  const runtime = runtimeOf(store);
  const opened = store.opened;
  const baseline = store.serverSnapshot;

  if (!opened?.draftId || opened.profile !== profile || !baseline) {
    return;
  }

  const identity = runtime.openRequest;

  try {
    const remote = await runtime.api.draft(profile, opened.draftId);

    if (runtime.openRequest !== identity || store.opened?.draftId !== opened.draftId
      || store.opened.profile !== profile) {
      return;
    }
    if (remote.revision <= baseline.revision && remote.state === baseline.state) {
      return;
    }
    if (store.saving) {
      runtime.pendingDraftRevision = Math.max(runtime.pendingDraftRevision ?? 0,
        remote.revision);
    } else if (store.dirty) {
      markConflict();
    } else {
      await loadDraft(profile, opened.draftId);
    }
  } catch {
    // Ошибка сверки не должна уничтожать локальный буфер; явное чтение покажет отказ.
  }
}

async function reconcile(profile: string): Promise<void> {
  await Promise.allSettled([loadEditor(profile), loadDrafts(profile)]);
  await reconcileOpenDraft(profile);
}

/**
 * Обрабатывает сообщения о каталоге, черновиках и источнике управления.
 * Общий SSE-канал согласует вкладки без потери несохранённого текста.
 */
function handleEvent(profile: string, name: string, payload: unknown): void {
  const store = useRoutesStore();
  const runtime = runtimeOf(store);

  if (name === 'projects-changed' || name === 'hello') {
    runtime.watchCatalogChanged?.(name);

    if (name === 'hello') {
      void reconcile(profile);
    }

    return;
  }

  const data = recordOrNull(payload);

  if (!data || data.profile !== profile) {
    return;
  }
  if (name === 'routes-catalog-changed') {
    if ((data.catalogHash !== null && (typeof data.catalogHash !== 'string'
      || !/^[a-f0-9]{64}$/.test(data.catalogHash)))
      || !Number.isSafeInteger(data.sourceRevision)) {
      return;
    }

    void loadEditor(profile);
    runtime.watchCatalogChanged?.();

    return;
  }
  if (name !== 'routes-draft-changed' || typeof data.draftId !== 'string'
    || !Number.isSafeInteger(data.revision) || Number(data.revision) < 1
    || !['editing', 'published', 'archived'].includes(String(data.state))) {
    return;
  }

  void loadDrafts(profile);

  const opened = store.opened;
  const baseline = store.serverSnapshot;

  if (!opened?.draftId || opened.profile !== profile || opened.draftId !== data.draftId
    || !baseline) {
    return;
  }

  const revision = Number(data.revision);

  if (revision <= baseline.revision && data.state === baseline.state) {
    return;
  }
  if (store.saving) {
    runtime.pendingDraftRevision = Math.max(runtime.pendingDraftRevision ?? 0, revision);
  } else if (store.dirty) {
    markConflict();
  } else {
    void loadDraft(profile, opened.draftId);
  }
}

/** Один подписчик раздела на общий EventSource вкладки. */
/**
 * Подписывает редактор на общие события текущего профиля.
 * Общий SSE-канал согласует вкладки без потери несохранённого текста.
 */
export function watchRoutes(profile: string, onCatalogChanged?: (event?: string) => void): void {
  const runtime = runtimeOf(useRoutesStore());

  if (runtime.watchOff && runtime.watchProfile === profile) {
    runtime.watchCatalogChanged = onCatalogChanged ?? null;

    return;
  }

  stopWatchingRoutes();
  runtime.watchProfile = profile;
  runtime.watchCatalogChanged = onCatalogChanged ?? null;

  const subscribe = runtime.subscribe ?? sseSubscribe;

  runtime.watchOff = subscribe((name, payload) => handleEvent(profile, name, payload));

  if (typeof window !== 'undefined') {
    const onFocus = () => {
       void reconcile(profile);
    };

    window.addEventListener('focus', onFocus);
    runtime.watchFocusOff = () => window.removeEventListener('focus', onFocus);
  }
}

/**
 * Снимает подписки при выходе из редактора.
 * Общий SSE-канал согласует вкладки без потери несохранённого текста.
 */
export function stopWatchingRoutes(): void {
  const runtime = runtimeOf(useRoutesStore());

  runtime.watchOff?.();
  runtime.watchFocusOff?.();
  runtime.watchOff = null;
  runtime.watchFocusOff = null;
  runtime.watchProfile = null;
  runtime.watchCatalogChanged = null;
}
