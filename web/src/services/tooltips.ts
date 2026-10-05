import type { UiOverlayPlacement } from '../types/uiOverlays.ts';

export const TOOLTIP_SHOW_DELAY_MS = 300;
export const TOOLTIP_HIDE_DELAY_MS = 80;
export const TOOLTIP_WARM_MS = 300;

export type TooltipTarget = HTMLElement | SVGElement;
export type TooltipReason = 'pointer' | 'focus';

export interface TooltipState {
  target: TooltipTarget;
  text: string;
  placement: UiOverlayPlacement;
}

interface ActiveTarget extends TooltipState {
  reasons: Set<TooltipReason>;
  sequence: number;
}

const active = new Map<TooltipTarget, ActiveTarget>();
const listeners = new Set<(state: TooltipState | null) => void>();
let state: TooltipState | null = null;
let pending: TooltipTarget | null = null;
let hiddenAt: number | null = null;
let sequence = 0;
let generation = 0;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Все callbacks привязаны к поколению, а отмена инвалидирует уже поставленные вызовы.
 * Отдельная pending-цель не позволяет повторному наведению сбрасывать задержку.
 */
function cancelTimers(): void {
  generation += 1;

  if (showTimer !== null) {
    clearTimeout(showTimer);
  }
  if (hideTimer !== null) {
    clearTimeout(hideTimer);
  }

  showTimer = null;
  hideTimer = null;
  pending = null;
}

/**
 * Подписчикам передаётся новый снимок только при изменении видимой справки.
 * Момент скрытия хранится отдельно, чтобы следующая цель могла открыться без задержки.
 */
function publish(entry: ActiveTarget | null): void {
  const next = entry ? {
    target: entry.target,
    text: entry.text,
    placement: entry.placement,
  } : null;

  if (state?.target === next?.target && state?.text === next?.text
    && state?.placement === next?.placement) {
    return;
  }

  if (state && !next) {
    hiddenAt = Date.now();
  }

  state = next;

  for (const listener of [...listeners]) {
    listener(state);
  }
}

/**
 * Сначала выбираем последнюю активированную семью целей.
 * Среди её вложенных элементов побеждает самый глубокий независимо от порядка событий.
 */
function winner(): ActiveTarget | null {
  const entries = [...active.values()].sort((left, right) => right.sequence - left.sequence);
  let selected = entries[0] ?? null;

  for (const entry of entries) {
    if (selected?.target.contains(entry.target)) {
      selected = entry;
    }
  }

  return selected;
}

/**
 * Видимая справка и недавнее скрытие разрешают немедленный переход между целями.
 * Для холодной цели остаётся один таймер; пустой набор отменяет ожидание или гасит поверхность.
 */
function reconcile(immediate = false): void {
  const next = winner();

  if (!next) {
    if (hideTimer !== null && !immediate) {
      return;
    }

    cancelTimers();

    if (immediate || !state) {
      publish(null);

      return;
    }

    const run = generation;

    hideTimer = setTimeout(() => {
      if (run === generation && active.size === 0) {
        hideTimer = null;
        publish(null);
      }
    }, TOOLTIP_HIDE_DELAY_MS);

    return;
  }

  const warm = state !== null || (hiddenAt !== null && Date.now() - hiddenAt < TOOLTIP_WARM_MS);

  if (warm || immediate) {
    cancelTimers();
    publish(next);

    return;
  }
  if (pending === next.target && showTimer !== null) {
    return;
  }

  cancelTimers();
  pending = next.target;

  const run = generation;

  showTimer = setTimeout(() => {
    const selected = winner();

    if (run === generation && selected?.target === pending) {
      showTimer = null;
      pending = null;
      publish(selected);
    }
  }, TOOLTIP_SHOW_DELAY_MS);
}

/**
 * Каждая цель удерживается отдельно наведением и клавиатурным фокусом.
 * Повтор той же причины не меняет порядок активации и не перезапускает показ.
 */
export function requestTooltip(
  target: TooltipTarget,
  text: string,
  placement: UiOverlayPlacement = 'top',
  reason: TooltipReason = 'pointer',
): void {
  if (!text.trim()) {
    return;
  }

  let entry = active.get(target);

  if (entry?.reasons.has(reason)) {
    return;
  }
  if (!entry) {
    entry = {
      target,
      text,
      placement,
      reasons: new Set(),
      sequence: 0,
    };
    active.set(target, entry);
  }

  entry.reasons.add(reason);
  entry.sequence = ++sequence;
  reconcile();
}

/**
 * Уход одной причины не снимает вторую, например фокус после ухода мыши.
 * Пересчёт выбирает другую активную цель или планирует скрытие.
 */
export function releaseTooltip(target: TooltipTarget, reason: TooltipReason = 'pointer'): void {
  const entry = active.get(target);

  if (!entry || !entry.reasons.delete(reason)) {
    return;
  }
  if (entry.reasons.size === 0) {
    active.delete(target);
  }

  reconcile();
}

/**
 * Обновление меняет только уже активную цель, сохраняя её причины и очередь показа.
 * Пустой текст снимает цель сразу, даже если курсор ещё остаётся над ней.
 */
export function updateTooltip(
  target: TooltipTarget,
  text: string,
  placement: UiOverlayPlacement = 'top',
): void {
  const entry = active.get(target);

  if (!entry) {
    return;
  }
  if (!text.trim()) {
    forgetTooltipTarget(target);

    return;
  }

  entry.text = text;
  entry.placement = placement;
  reconcile();
}
/**
 * Размонтирование снимает все причины цели и отменяет её отложенный callback.
 * Видимая внутренняя цель сразу уступает внешней, а последняя скрывается немедленно.
 */
export function forgetTooltipTarget(target: TooltipTarget): void {
  const visible = state?.target === target;

  if (!active.delete(target)) {
    return;
  }

  reconcile(visible);
}

/**
 * Нажатие или Escape снимает все активные цели, не позволяя таймеру воскресить справку.
 * Момент закрытия сохраняет тёплый переход к следующему наведению.
 */
export function hideTooltip(): void {
  active.clear();
  cancelTimers();
  publish(null);
  hiddenAt = Date.now();
}

/**
 * Сброс делает следующую цель холодной и очищает все причины показа.
 * Подписчики остаются подключёнными и получают скрытие текущей поверхности.
 */
export function resetTooltips(): void {
  active.clear();
  cancelTimers();
  publish(null);
  hiddenAt = null;
}

/**
 * Возвращает текущий снимок для хоста и изолированных проверок.
 * Ожидающая цель ещё не считается видимой подсказкой.
 */
export function currentTooltip(): TooltipState | null {
  return state;
}

/**
 * Хост сразу получает состояние, даже если смонтирован после запроса.
 * Отписка прекращает уведомления без изменения активной подсказки.
 */
export function subscribeTooltip(listener: (state: TooltipState | null) => void): () => void {
  listeners.add(listener);
  listener(state);

  return () => {
    listeners.delete(listener);
  };
}
