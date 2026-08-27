import { randomUUID } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * Одна process-owned очередь вопросов человеку. Проверка origin выполняется до
 * удаления записи: старый клиент не способен случайно решить SSH-подтверждение.
 */
export function createPermissionQueue(options = {}) {
  const entries = options.entries || new Map();
  const resolved = new Set();
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const listeners = new Set(options.onChange ? [options.onChange] : []);

  function notify(event) {
    for (const listener of listeners) {
      listener(event);
    }
  }

  function finish(entry, value, reason = 'answered') {
    if (!entries.has(entry.pid)) {
      return false;
    }
    entries.delete(entry.pid);
    clearTimer(entry.timer);
    resolved.add(entry.pid);
    if (resolved.size > 2_000) {
      resolved.delete(resolved.values().next().value);
    }
    entry.resolve(value);
    notify({ type: 'done', pid: entry.pid, origin: entry.origin, reason });
    return true;
  }

  function enqueue(request = {}) {
    const pid = String(request.pid || `p${randomUUID().replaceAll('-', '')}`);
    const at = request.at ?? Date.now();
    let resolveResult;
    const result = new Promise((resolve) => {
      resolveResult = resolve;
    });
    const entry = {
      ...request,
      pid,
      at,
      canRemember: request.origin === 'ssh' ? false : request.canRemember,
      resolve: resolveResult,
      result,
    };
    entry.timer = setTimer(() => {
      const value = entry.origin === 'ssh'
        ? { allow: false, error: 'approval_expired' }
        : { allow: false, error: 'permission_expired' };
      finish(entry, value, 'expired');
    }, timeoutMs);
    entry.timer?.unref?.();
    entries.set(pid, entry);
    notify({ type: 'waiting', entry: publicEntry(entry) });
    return publicEntry(entry);
  }

  async function answer(pidValue, expectedOrigin, decision = {}) {
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
    const value = {
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

  function cancel(pidValue, value = { allow: false, error: 'cancelled' }) {
    const entry = entries.get(String(pidValue || ''));
    return entry ? finish(entry, value, 'cancelled') : false;
  }

  function cancelWhere(predicate, value) {
    for (const entry of entries.values()) {
      if (predicate(entry)) {
        finish(entry, typeof value === 'function' ? value(entry) : value, 'cancelled');
      }
    }
  }

  function waiting() {
    return [...entries.values()].map(publicEntry);
  }

  return {
    enqueue,
    answer,
    cancel,
    cancelWhere,
    waiting,
    get: (pid) => entries.get(String(pid || '')) || null,
    entries,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function publicEntry(entry) {
  const { resolve: _resolve, timer: _timer, ...value } = entry;
  return value;
}

export default createPermissionQueue;
