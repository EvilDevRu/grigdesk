import {
  dismissAllToasts,
  dismissToast,
  dismissToastScope,
  showToast,
  subscribeToastDismissals,
  subscribeToasts,
} from '../ui';
import type { UiToastAction, UiToastTone } from '../ui';
import { closeSystemNotification, notify } from './notify.ts';
import { alertTargetHash, alertTargetLabel } from './alertTargets.ts';
import type { AlertTarget } from './alertTargets.ts';
import { createAlertHistory } from './alertHistory.ts';
import type { AlertHistoryListener } from './alertHistory.ts';

export const ALERT_OPEN_ACTION_ID = 'open';

export interface AlertInput {
  id: string;
  title: string;
  scope?: string;
  tone?: UiToastTone;
  body?: string;
  detail?: string;
  target?: AlertTarget;
  actions?: readonly UiToastAction[];
  sticky?: boolean;
}

let subscribed = false;
const systemIds = new Set<string>();
const history = createAlertHistory();
let targetOpener: ((target: AlertTarget) => void) | null = null;

/**
 * Оболочка задаёт переходы только на время своей жизни.
 * Действие читает текущую открывалку, даже если она сменилась после показа тоста.
 */
export function setAlertTargetOpener(open: ((target: AlertTarget) => void) | null): void {
  targetOpener = open;
}

/**
 * Видимость без фокуса не означает, что человек смотрит на кокпит.
 * В среде без метода hasFocus достаточно видимого документа.
 */
export function userIsHere(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'visible' &&
    (typeof document.hasFocus !== 'function' || document.hasFocus());
}

/**
 * Публикует тост и при отсутствии человека добавляет системный канал.
 * Подписка связывает их время жизни, включая таймер, замену и ручное закрытие.
 */
export function alertUser(input: AlertInput): boolean {
  if (typeof input.id !== 'string' || !input.id.trim() ||
    typeof input.title !== 'string' || !input.title.trim()) {
    return false;
  }
  if (!subscribed) {
    subscribed = true;
    subscribeToasts((toasts) => {
      const visibleIds = new Set(toasts.map((toast) => toast.id));

      for (const id of systemIds) {
        if (!visibleIds.has(id)) {
          systemIds.delete(id);
          void closeSystemNotification(id);
        }
      }
    });
    subscribeToastDismissals((toast, reason) => {
      history.toastGone(toast.id, reason);
    });
  }

  const actions = [...(input.actions || [])];
  const target = input.target;

  if (target) {
    actions.push({
      id: ALERT_OPEN_ACTION_ID,
      label: alertTargetLabel(target),
      tone: 'accent',
      variant: 'outline',
      run() {
        targetOpener?.(target);
      },
    });
  }

  const shown = showToast({
    id: input.id,
    title: input.title,
    scope: input.scope,
    tone: input.tone || 'accent',
    body: input.body,
    detail: input.detail,
    durationMs: input.sticky ? 0 : undefined,
    actions,
  });

  if (shown) {
    history.record({
      id: input.id,
      scope: input.scope,
      tone: input.tone || 'accent',
      title: input.title,
      body: input.body,
      target,
    });
  }

  if (shown && !userIsHere()) {
    const url = target ? new URL(alertTargetHash(target), window.location.href).href : '';

    systemIds.add(input.id);
    void notify(input.title, input.body || '', input.id, url);
  }

  return shown;
}

/**
 * Снимает тосты одного события.
 * Связанные системные уведомления закрывает общая подписка.
 */
export function dismissAlert(id: string): void {
  history.resolve(id);
  dismissToast(id);
}

/**
 * Снимает тосты всех событий области.
 * Связанные системные уведомления закрывает общая подписка.
 */
export function dismissAlertScope(scope: string): void {
  history.resolveScope(scope);
  dismissToastScope(scope);
}

/**
 * Снимает тосты всех событий окна.
 * Связанные системные уведомления закрывает общая подписка.
 */
export function dismissAllAlerts(): void {
  dismissAllToasts();
}

/**
 * Колокольчик подписывается на историю окна: снимок приходит сразу и после каждого
 * изменения — новое оповещение, уход тоста, разбор повода или очистка.
 */
export function subscribeAlertHistory(listener: AlertHistoryListener): () => void {
  return history.subscribe(listener);
}

/**
 * Открытая история значит «человек посмотрел»: пропущенные записи перестают считаться
 * в значке колокольчика. С ключом отмечается одна запись.
 */
export function markAlertHistorySeen(key?: string): void {
  history.markSeen(key);
}

/**
 * История держит текст переписки, поэтому стирается целиком: при выходе из кокпита
 * и по кнопке «Очистить» в колокольчике.
 */
export function clearAlertHistory(): void {
  history.clear();
}

/**
 * Переход из истории идёт той же открывалкой, что у тоста. Запись при этом становится
 * просмотренной; без цели или открывалки ничего не происходит.
 */
export function openAlertHistoryEntry(key: string): boolean {
  const entry = history.find(key);

  if (!entry?.target || !targetOpener) {
    return false;
  }

  history.markSeen(key);
  targetOpener(entry.target);

  return true;
}
