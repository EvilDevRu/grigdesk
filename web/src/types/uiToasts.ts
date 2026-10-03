import type { UiActionTone, UiActionVariant } from './uiActions';

export type UiToastTone = 'accent' | 'warning' | 'danger';

export interface UiToastAction {
  id: string;
  label: string;
  tone?: UiActionTone;
  variant?: UiActionVariant;
  run(): unknown;
}

export interface UiToastOptions {
  id: string;
  title: string;
  scope?: string;
  tone?: UiToastTone;
  body?: string;
  detail?: string;
  actions?: readonly UiToastAction[];
  durationMs?: number;
}

export interface UiToast {
  readonly id: string;
  readonly scope: string;
  readonly tone: UiToastTone;
  readonly title: string;
  readonly body: string;
  readonly detail: string;
  readonly durationMs: number;
  readonly actions: readonly UiToastAction[];
}

export type UiToastListener = (toasts: readonly UiToast[]) => void;

/**
 * Почему тост ушёл с экрана: истёк сам, его закрыл человек, нажато действие, его снял код
 * или вытеснил лимит. История оповещений отличает «проехало мимо» от «человек видел».
 */
export type UiToastDismissReason = 'timeout' | 'user' | 'action' | 'program' | 'overflow';

export type UiToastDismissListener = (toast: UiToast, reason: UiToastDismissReason) => void;

export interface UiToastTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
