import { randomUUID } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// Запрос разрешения в том виде, в каком его ставит исполнитель. Форма открытая:
// поля карточки объявляет тот, кто спрашивает, очередь их только переносит.
export interface PermissionRequest {
  pid?: unknown;
  at?: number;
  origin?: string;
  canRemember?: unknown;
  [field: string]: unknown;
}

// Решение по запросу: что уходит вызывающему коду вместо ожидания.
export interface PermissionDecision {
  allow: boolean;
  error?: string;
  comment?: string;
  answers?: unknown[];
  remember?: boolean;
  choice?: string;
}

// Запись очереди без внутренних полей — ровно то, что видно наружу.
export interface PermissionEntry extends PermissionRequest {
  pid: string;
  at: number;
  result: Promise<PermissionDecision>;
}

// Полная запись очереди: сверх публичной ещё resolve и таймер ожидания.
interface QueuedEntry extends PermissionEntry {
  resolve: (value: PermissionDecision) => void;
  timer?: { unref?: () => void };
}

// Событие очереди для подписчиков: появился вопрос либо он закрыт.
export interface PermissionEvent {
  type: 'waiting' | 'done';
  pid?: string;
  origin?: string;
  reason?: string;
  entry?: PermissionEntry;
}

// Настройка очереди. Таймеры и хранилище подменяются в тестах.
export interface PermissionQueueOptions {
  entries?: Map<string, QueuedEntry>;
  timeoutMs?: number;
  setTimer?: (handler: () => void, ms: number) => { unref?: () => void };
  clearTimer?: (timer: unknown) => void;
  onChange?: (event: PermissionEvent) => void;
}

// Что умеет очередь: поставить вопрос, решить его за человека и ответить на него.
export interface PermissionQueue {
  enqueue: (request?: PermissionRequest) => PermissionEntry;
  decide: (
    request?: PermissionRequest,
    value?: PermissionDecision,
    reason?: string,
  ) => PermissionEntry;
  answer: (
    pid: unknown,
    expectedOrigin: string,
    decision?: Record<string, unknown>,
  ) => Promise<{ ok: boolean; error?: string }>;
  cancel: (pid: unknown, value?: PermissionDecision) => boolean;
  cancelWhere: (
    predicate: (entry: QueuedEntry) => boolean,
    value: PermissionDecision | ((entry: QueuedEntry) => PermissionDecision),
  ) => void;
  waiting: () => PermissionEntry[];
  get: (pid: unknown) => QueuedEntry | null;
  entries: Map<string, QueuedEntry>;
  subscribe: (listener: (event: PermissionEvent) => void) => () => void;
}

/**
 * Одна process-owned очередь вопросов человеку. Проверка origin выполняется до
 * удаления записи: старый клиент не способен случайно решить SSH-подтверждение.
 */
export function createPermissionQueue(options: PermissionQueueOptions = {}): PermissionQueue {
  const entries = options.entries || new Map<string, QueuedEntry>();
  const resolved = new Set<string>();
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const setTimer = options.setTimer
    || ((handler: () => void, ms: number) => setTimeout(handler, ms));
  const clearTimer = options.clearTimer
    || ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const listeners = new Set(options.onChange ? [options.onChange] : []);

  function notify(event: PermissionEvent): void {
    for (const listener of listeners) {
      listener(event);
    }
  }

  function finish(entry: QueuedEntry, value: PermissionDecision, reason = 'answered'): boolean {
    if (!entries.has(entry.pid)) {
      return false;
    }
    entries.delete(entry.pid);
    clearTimer(entry.timer);
    resolved.add(entry.pid);
    if (resolved.size > 2_000) {
      const oldest = resolved.values().next().value;
      if (oldest !== undefined) resolved.delete(oldest);
    }
    entry.resolve(value);
    notify({ type: 'done', pid: entry.pid, origin: entry.origin, reason });
    return true;
  }

  function enqueue(request: PermissionRequest = {}): PermissionEntry {
    const pid = String(request.pid || `p${randomUUID().replaceAll('-', '')}`);
    const at = request.at ?? Date.now();
    let resolveResult: (value: PermissionDecision) => void = () => {};
    const result = new Promise<PermissionDecision>((resolve) => {
      resolveResult = resolve;
    });
    const entry: QueuedEntry = {
      ...request,
      pid,
      at,
      canRemember: ['ssh', 'db'].includes(String(request.origin)) ? false : request.canRemember,
      resolve: resolveResult,
      result,
    };
    entry.timer = setTimer(() => {
      const value = ['ssh', 'db'].includes(String(entry.origin))
        ? { allow: false, error: 'approval_expired' }
        : { allow: false, error: 'permission_expired' };
      finish(entry, value, 'expired');
    }, timeoutMs);
    entry.timer?.unref?.();
    entries.set(pid, entry);
    notify({ type: 'waiting', entry: publicEntry(entry) });
    return publicEntry(entry);
  }

  /** Внутренний fail-closed/auto verdict проходит через очередь, не создавая карточку. */
  function decide(
    request: PermissionRequest = {},
    value: PermissionDecision = { allow: false },
    reason = 'internal',
  ): PermissionEntry {
    const pid = String(request.pid || `p${randomUUID().replaceAll('-', '')}`);
    resolved.add(pid);
    notify({ type: 'done', pid, origin: request.origin, reason });
    return {
      ...request,
      pid,
      at: request.at ?? Date.now(),
      canRemember: false,
      result: Promise.resolve(value),
    };
  }

  async function answer(
    pidValue: unknown,
    expectedOrigin: string,
    decision: Record<string, unknown> = {},
  ): Promise<{ ok: boolean; error?: string }> {
    const pid = String(pidValue || '');
    const entry = entries.get(pid);
    if (!entry) {
      return {
        ok: false,
        error: resolved.has(pid) ? 'already_resolved' : 'not_found',
      };
    }
    if (entry.origin !== expectedOrigin) {
      return { ok: false, error: 'origin_mismatch' };
    }
    const value: PermissionDecision = {
      allow: decision.allow === true,
      ...(String(decision.comment || '').trim()
        ? { comment: String(decision.comment).trim().slice(0, 4_000) }
        : {}),
      ...(Array.isArray(decision.answers) ? { answers: decision.answers } : {}),
      ...(decision.remember === true ? { remember: true } : {}),
      ...(typeof decision.choice === 'string' ? { choice: decision.choice.slice(0, 100) } : {}),
    };
    if (!finish(entry, value)) {
      return { ok: false, error: 'already_resolved' };
    }
    return { ok: true };
  }

  function cancel(
    pidValue: unknown,
    value: PermissionDecision = { allow: false, error: 'cancelled' },
  ): boolean {
    const entry = entries.get(String(pidValue || ''));
    return entry ? finish(entry, value, 'cancelled') : false;
  }

  function cancelWhere(
    predicate: (entry: QueuedEntry) => boolean,
    value: PermissionDecision | ((entry: QueuedEntry) => PermissionDecision),
  ): void {
    for (const entry of entries.values()) {
      if (predicate(entry)) {
        finish(entry, typeof value === 'function' ? value(entry) : value, 'cancelled');
      }
    }
  }

  function waiting(): PermissionEntry[] {
    return [...entries.values()].map(publicEntry);
  }

  return {
    enqueue,
    decide,
    answer,
    cancel,
    cancelWhere,
    waiting,
    get: (pid: unknown) => entries.get(String(pid || '')) || null,
    entries,
    subscribe(listener: (event: PermissionEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function publicEntry(entry: QueuedEntry): PermissionEntry {
  const { resolve: _resolve, timer: _timer, ...value } = entry;
  return value;
}

export default createPermissionQueue;
