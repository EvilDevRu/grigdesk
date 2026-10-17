import { ROUTES_EDITOR_LIMITS } from '../../../../shared/pipeline/routesEditorContracts.ts';
import type { RouteDraft } from '../../../../shared/pipeline/routesEditorContracts.ts';
import type { RoutesStore } from './routesRuntime.ts';

export interface RouteHistorySnapshot {
  title: string;
  routes: RouteDraft['routes'];
  bootstrap: RouteDraft['bootstrap'];
  bootstrapPrompts: RouteDraft['bootstrapPrompts'];
  presentation: RouteDraft['presentation'];
  provenance: RouteDraft['provenance'];
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Создаёт независимый снимок редактируемого содержания черновика.
 * История хранит копии авторских данных, не сетевые снимки и ответы.
 */
export function snapshotOf(draft: RouteDraft): RouteHistorySnapshot {
  return copy({
    title: draft.title,
    routes: draft.routes,
    bootstrap: draft.bootstrap,
    bootstrapPrompts: draft.bootstrapPrompts,
    presentation: draft.presentation,
    provenance: draft.provenance
  });
}

/** История содержит только авторские поля, без серверной ревизии и публикации. */
/**
 * Записывает предыдущее состояние и объединяет связанные правки в группу.
 * История хранит копии авторских данных, не сетевые снимки и ответы.
 */
export function recordHistory(store: RoutesStore, before: RouteDraft, group?: string): void {
  if (!group || store.historyGroup !== group) {
    store.historyPast.push(snapshotOf(before));

    if (store.historyPast.length > ROUTES_EDITOR_LIMITS.undoCommands) {
      store.historyPast.shift();
    }
  }

  store.historyFuture = [];
  store.historyGroup = group ?? null;
}

/**
 * Завершает объединение последовательных правок в одну операцию.
 * История хранит копии авторских данных, не сетевые снимки и ответы.
 */
export function endHistoryGroup(store: RoutesStore): void {
  store.historyGroup = null;
}

/**
 * Распознаёт сочетания отмены и повтора вне полей ввода.
 * История хранит копии авторских данных, не сетевые снимки и ответы.
 */
export function historyShortcut(event: Pick<KeyboardEvent,
  'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'target'>): 'undo' | 'redo' | null {
  if ((!event.ctrlKey && !event.metaKey) || event.altKey) {
    return null;
  }

  const target = event.target as Element | null;

  if (target?.closest?.('input, textarea, select, [contenteditable="true"],'
    + ' .monaco-editor, [data-escape-owner="monaco"]')) {
    return null;
  }

  const key = event.key.toLowerCase();

  if (key === 'z') {
    return event.shiftKey ? 'redo' : 'undo';
  }
  if (key === 'y' && !event.shiftKey) {
    return 'redo';
  }

  return null;
}

/**
 * Переносит снимок между стеками отмены и повтора.
 * История хранит копии авторских данных, не сетевые снимки и ответы.
 */
export function travelHistory(store: RoutesStore, current: RouteDraft,
  direction: 'undo' | 'redo'): RouteDraft | null {
  const source = direction === 'undo' ? store.historyPast : store.historyFuture;
  const destination = direction === 'undo' ? store.historyFuture : store.historyPast;
  const snapshot = source.pop();

  if (!snapshot) {
    return null;
  }

  destination.push(snapshotOf(current));
  store.historyGroup = null;

  return { ...copy(current), ...copy(snapshot) };
}
