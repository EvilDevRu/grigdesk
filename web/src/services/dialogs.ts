import { snapshotText } from '../../../shared/i18n/core.ts';
import type { UiText } from '../../../shared/i18n/core.ts';

import type {
  AlertDialogOptions,
  AlertDialogRequest,
  ConfirmDialogOptions,
  ConfirmDialogRequest,
  DialogHostRequest,
  DialogResult,
  PromptDialogOptions,
  PromptDialogRequest,
} from '../types/uiOverlays';

interface ConfirmQueueItem {
  request: ConfirmDialogRequest;
  resolve(value: boolean): void;
}

interface PromptQueueItem {
  request: PromptDialogRequest;
  resolve(value: string | null): void;
}

interface AlertQueueItem {
  request: AlertDialogRequest;
  resolve(): void;
}

type DialogQueueItem = ConfirmQueueItem | PromptQueueItem | AlertQueueItem;

function isConfirmItem(item: DialogQueueItem): item is ConfirmQueueItem {
  return item.request.kind === 'confirm';
}

function isPromptItem(item: DialogQueueItem): item is PromptQueueItem {
  return item.request.kind === 'prompt';
}

export interface DialogHostController {
  show(request: DialogHostRequest): void;
  hide(requestId: number): void;
}

const queue: DialogQueueItem[] = [];
let active: DialogQueueItem | null = null;
let sequence = 0;
let host: { token: symbol; controller: DialogHostController } | null = null;
let pumpQueued = false;

function schedulePump(): void {
  if (pumpQueued) return;
  pumpQueued = true;
  queueMicrotask(() => {
    pumpQueued = false;
    pump();
  });
}

function pump(): void {
  if (!host || active || queue.length === 0) return;
  active = queue.shift() ?? null;
  if (active) host.controller.show(active.request);
}

function enqueue(item: DialogQueueItem): void {
  queue.push(item);
  pump();
}

export function registerDialogHost(controller: DialogHostController): () => void {
  const token = Symbol('ui-dialog-host');
  host = { token, controller };
  if (active) controller.show(active.request);
  else pump();

  return () => {
    if (host?.token !== token) return;
    host = null;
  };
}

export function completeDialogRequest(requestId: number, result: DialogResult): boolean {
  const item = active;
  if (!item || item.request.id !== requestId) return false;

  if (isConfirmItem(item) && typeof result !== 'boolean') return false;
  if (isPromptItem(item) && result !== null && typeof result !== 'string') return false;
  if (!isConfirmItem(item) && !isPromptItem(item) && result !== undefined) return false;

  host?.controller.hide(requestId);
  active = null;
  if (isConfirmItem(item)) item.resolve(result as boolean);
  else if (isPromptItem(item)) item.resolve(result as string | null);
  else item.resolve();
  schedulePump();
  return true;
}

/**
 * Очередь хранит снимок текста и параметров, сохраняя выбор одного открытого диалога.
 * Host переводит descriptor при показе, не выполняя подтверждение повторно.
 */
export function confirmDialog(text: UiText, options: ConfirmDialogOptions = {}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const request: ConfirmDialogRequest = Object.freeze({
      id: ++sequence,
      kind: 'confirm',
      text: snapshotText(text ?? ''),
      options: snapshotOptions(options),
    });
    enqueue({ request, resolve });
  });
}

export function promptDialog(options: PromptDialogOptions = {}): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const request: PromptDialogRequest = Object.freeze({
      id: ++sequence,
      kind: 'prompt',
      options: snapshotOptions(options),
    });
    enqueue({ request, resolve });
  });
}

/**
 * Сообщение ставится в общую очередь со снимком descriptor и кнопок.
 * Переключение языка не меняет обещание завершения и порядок показа.
 */
export function alertDialog(text: UiText, options: AlertDialogOptions = {}): Promise<void> {
  return new Promise<void>((resolve) => {
    const request: AlertDialogRequest = Object.freeze({
      id: ++sequence,
      kind: 'alert',
      text: snapshotText(text ?? ''),
      options: snapshotOptions(options),
    });
    enqueue({ request, resolve });
  });
}

/** Диагностический read-only state для component-тестов. */
export function pendingDialogCount(): number {
  return queue.length + (active ? 1 : 0);
}

/**
 * Опции сохраняют callback и ввод, а тексты получают отдельный неизменяемый снимок.
 * Переключение языка не создаёт новый запрос и не повторяет действие диалога.
 */
function snapshotOptions<T extends object>(options: T): Readonly<T> {
  const copy = { ...options };

  for (const key of ['title', 'text', 'placeholder', 'okText', 'cancelText']) {
    const value = (copy as Record<string, unknown>)[key];

    if (value !== undefined) {
      (copy as Record<string, unknown>)[key] = snapshotText(value as UiText);
    }
  }

  return Object.freeze(copy);
}
