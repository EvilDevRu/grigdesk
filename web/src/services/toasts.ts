import { snapshotText } from '../../../shared/i18n/core.ts';
import { resolveUiText } from './locale.ts';

import type {
  UiToast,
  UiToastAction,
  UiToastDismissListener,
  UiToastDismissReason,
  UiToastListener,
  UiToastOptions,
  UiToastTimers,
} from '../types/uiToasts';

export const UI_TOAST_DEFAULT_DURATION_MS = 8000;
export const UI_TOAST_STORE_LIMIT = 20;
export const UI_TOAST_ACTION_LIMIT = 3;

export interface UiToastCenter {
  show(options: UiToastOptions): boolean;
  dismiss(id: string, reason?: UiToastDismissReason): boolean;
  dismissScope(scope: string, reason?: UiToastDismissReason): string[];
  dismissAll(reason?: UiToastDismissReason): string[];
  list(): readonly UiToast[];
  subscribe(listener: UiToastListener): () => void;
  subscribeDismissals(listener: UiToastDismissListener): () => void;
  pause(id: string): void;
  resume(id: string): void;
  setDocumentVisible(visible: boolean): void;
  runAction(toastId: string, actionId: string): Promise<boolean>;
}

/**
 * Принимает только полные действия, которые можно безопасно показать человеку.
 * Копия защищает уже показанное оповещение от изменения объекта вызывающей стороны.
 */
function normalizeActions(actions: readonly UiToastAction[] = []): readonly UiToastAction[] {
  return Object.freeze(actions.filter((action) => action &&
    typeof action.id === 'string' && Boolean(action.id.trim()) &&
    Boolean(action.label) && Boolean(resolveUiText(action.label).trim()) &&
    typeof action.run === 'function').slice(0, UI_TOAST_ACTION_LIMIT)
    .map((action) => Object.freeze({
    ...action,
    label: snapshotText(action.label),
  })));
}

/**
 * Приводит входные данные к неизменяемому снимку для всех подписчиков.
 * Нулевая длительность сохраняется: срочное оповещение не исчезает само.
 */
function normalizeToast(options: UiToastOptions): UiToast {
  const durationMs = typeof options.durationMs === 'number' &&
    Number.isFinite(options.durationMs) && options.durationMs >= 0 ?
    options.durationMs : UI_TOAST_DEFAULT_DURATION_MS;

  return Object.freeze({
    id: options.id,
    title: snapshotText(options.title),
    scope: String(options.scope ?? ''),
    tone: options.tone === 'warning' || options.tone === 'danger' ? options.tone : 'accent',
    body: snapshotText(options.body ?? ''),
    detail: snapshotText(options.detail ?? ''),
    durationMs,
    actions: normalizeActions(options.actions),
  });
}

/**
 * Создаёт независимый центр оповещений для одного окна.
 * Таймеры передаются снаружи, чтобы проверять время без настоящего ожидания.
 */
export function createToastCenter(timers: UiToastTimers = {
  set(callback, ms) {
    return setTimeout(callback, ms);
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
}): UiToastCenter {
  let toasts: UiToast[] = [];
  const listeners = new Set<UiToastListener>();
  const dismissListeners = new Set<UiToastDismissListener>();
  const handles = new Map<string, unknown>();
  let documentVisible = true;
  const paused = new Set<string>();

  function clearTimer(id: string): void {
    if (handles.has(id)) {
      timers.clear(handles.get(id));
      handles.delete(id);
    }
  }

  /**
   * Снимает тост вместе с таймером и публикует новый снимок.
   * Неизвестный id не создаёт лишнего события; причина уходит подписчикам ухода.
   */
  function dismiss(id: string, reason: UiToastDismissReason = 'program'): boolean {
    const removed = toasts.find((toast) => toast.id === id);

    if (!removed) {
      return false;
    }

    clearTimer(id);
    paused.delete(id);
    toasts = toasts.filter((toast) => toast.id !== id);
    emit();
    emitDismissal(removed, reason);

    return true;
  }

  function arm(toast: UiToast): void {
    if (toast.durationMs > 0 && documentVisible && !paused.has(toast.id)) {
      handles.set(toast.id, timers.set(() => dismiss(toast.id, 'timeout'), toast.durationMs));
    }
  }

  function emitDismissal(toast: UiToast, reason: UiToastDismissReason): void {
    dismissListeners.forEach((listener) => listener(toast, reason));
  }

  function emit(): void {
    const snapshot = Object.freeze([...toasts]);

    listeners.forEach((listener) => listener(snapshot));
  }

  return {

    /**
     * Заменяет тост с тем же id и делает его самым новым.
     * Ограничение хранения снимает также таймер и паузу старого тоста.
     */
    show(options: UiToastOptions): boolean {
      if (typeof options.id !== 'string' || !options.id.trim() ||
        !options.title || !resolveUiText(options.title).trim()) {
        return false;
      }

      clearTimer(options.id);
      paused.delete(options.id);
      toasts = toasts.filter((toast) => toast.id !== options.id);

      const toast = normalizeToast(options);

      toasts.push(toast);

      const overflow: UiToast[] = [];

      while (toasts.length > UI_TOAST_STORE_LIMIT) {
        const oldest = toasts.shift()!;

        clearTimer(oldest.id);
        paused.delete(oldest.id);
        overflow.push(oldest);
      }

      arm(toast);
      emit();
      overflow.forEach((oldest) => emitDismissal(oldest, 'overflow'));

      return true;
    },
    setDocumentVisible(visible: boolean): void {
      documentVisible = visible;
      toasts.forEach((toast) => {
        clearTimer(toast.id);
        arm(toast);
      });
    },
    pause(id: string): void {
      if (toasts.some((toast) => toast.id === id)) {
        paused.add(id);
        clearTimer(id);
      }
    },

    /**
     * Возвращает полную длительность после ухода мыши или клавиатурного фокуса.
     * Скрытый документ сохраняет тост до следующего изменения видимости.
     */
    resume(id: string): void {
      paused.delete(id);
      clearTimer(id);

      const toast = toasts.find((item) => item.id === id);

      if (toast) {
        arm(toast);
      }
    },
    dismissScope(scope: string, reason: UiToastDismissReason = 'program'): string[] {
      const ids = scope ? toasts.filter((toast) => toast.scope === scope).map((toast) => toast.id) :
        [];

      ids.forEach((id) => dismiss(id, reason));

      return ids;
    },
    dismissAll(reason: UiToastDismissReason = 'program'): string[] {
      const ids = toasts.map((toast) => toast.id);

      ids.forEach((id) => dismiss(id, reason));

      return ids;
    },

    /**
     * Снимает запрос до выполнения, чтобы повторное нажатие не повторило эффект.
     * Ошибка действия остаётся в консоли и не ломает остальные оповещения.
     */
    async runAction(toastId: string, actionId: string): Promise<boolean> {
      const action = toasts.find((toast) => toast.id === toastId)?.actions
        .find((item) => item.id === actionId);

      if (!action) {
        return false;
      }

      dismiss(toastId, 'action');

      try {
        await action.run();
      } catch (error) {
        console.error('Действие оповещения не выполнено', error);
      }

      return true;
    },
    dismiss,
    subscribeDismissals(listener: UiToastDismissListener): () => void {
      dismissListeners.add(listener);

      return () => {
        dismissListeners.delete(listener);
      };
    },
    subscribe(listener: UiToastListener): () => void {
      listeners.add(listener);
      listener(Object.freeze([...toasts]));

      return () => {
        listeners.delete(listener);
      };
    },
    list(): readonly UiToast[] {
      return Object.freeze([...toasts]);
    },
  };
}

const center = createToastCenter();
export const showToast = (options: UiToastOptions): boolean => center.show(options);
export const dismissToast = (id: string, reason?: UiToastDismissReason): boolean => (
  center.dismiss(id, reason)
);
export const dismissToastScope = (scope: string, reason?: UiToastDismissReason): string[] => (
  center.dismissScope(scope, reason)
);
export const dismissAllToasts = (reason?: UiToastDismissReason): string[] => center.dismissAll(reason);
export const listToasts = (): readonly UiToast[] => center.list();
export const subscribeToasts = (listener: UiToastListener): (() => void) => center.subscribe(listener);
export const subscribeToastDismissals = (listener: UiToastDismissListener): (() => void) => (
  center.subscribeDismissals(listener)
);
export const pauseToast = (id: string): void => center.pause(id);
export const resumeToast = (id: string): void => center.resume(id);
export const setToastsVisible = (visible: boolean): void => center.setDocumentVisible(visible);
export const runToastAction = (toastId: string, actionId: string): Promise<boolean> => (
  center.runAction(toastId, actionId)
);
