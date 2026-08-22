// Контекст интерфейса — это bounded-снимок, а не канал полномочий.
// Каждый видимый модуль регистрирует owner-token и удаляет только его. Так
// поздний unmount старого overlay не сносит уже открытую карточку.
import { ref } from 'vue';
import { defineStore } from 'pinia';

export const UI_CONTEXT_LIMITS = Object.freeze({
  depth: 4,
  keys: 64,
  array: 32,
  string: 512,
  bytes: 8 * 1024,
});

const LAYER_PRIORITY = Object.freeze({ background: 0, dock: 100, page: 200, overlay: 300 });
const FORBIDDEN_KEYS = new Set([
  'password', 'passwd', 'token', 'secret', 'authorization', 'cookie', 'credential',
  'buffer', 'output', 'command', 'transcript', '__proto__', 'prototype', 'constructor',
]);
const CONTROL_OR_BIDI = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/gu;
const TASK_ID_RE = /^[1-9][0-9]{0,18}$/;

function forbiddenName(value) {
  return FORBIDDEN_KEYS.has(String(value || '').toLocaleLowerCase('en-US'));
}

function safeWarn(warn, code, source, key = '') {
  try { warn?.({ code, source: String(source || ''), ...(key ? { key } : {}) }); } catch { /* диагностика не ломает capture */ }
}

function textValue(value) {
  return Array.from(String(value).replace(CONTROL_OR_BIDI, '')).slice(0, UI_CONTEXT_LIMITS.string).join('');
}

function dataProperty(value, key) {
  if (!value || typeof value !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function defineData(target, key, value) {
  Object.defineProperty(target, key, {
    configurable: true, enumerable: true, writable: true, value,
  });
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function sanitizeValue(value, state, depth, source) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return textValue(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'object') {
    safeWarn(state.warn, 'invalid_value', source);
    return undefined;
  }
  if (depth >= UI_CONTEXT_LIMITS.depth || state.seen.has(value)) {
    safeWarn(state.warn, depth >= UI_CONTEXT_LIMITS.depth ? 'depth_limit' : 'cycle', source);
    return undefined;
  }
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out = [];
      const max = Math.min(value.length, UI_CONTEXT_LIMITS.array);
      for (let index = 0; index < max; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
          safeWarn(state.warn, 'accessor_value', source, String(index));
          continue;
        }
        const next = sanitizeValue(descriptor.value, state, depth + 1, source);
        if (next !== undefined) out.push(next);
      }
      return out;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      safeWarn(state.warn, 'non_plain_object', source);
      return undefined;
    }
    const out = {};
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Object.keys(descriptors).sort()) {
      if (state.keys >= UI_CONTEXT_LIMITS.keys) {
        safeWarn(state.warn, 'key_limit', source);
        break;
      }
      const descriptor = descriptors[key];
      const cleanKey = textValue(key);
      const normalizedKey = cleanKey.toLocaleLowerCase('en-US');
      if (FORBIDDEN_KEYS.has(normalizedKey)) {
        safeWarn(state.warn, 'forbidden_key', source, key);
        continue;
      }
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        if (descriptor.enumerable) safeWarn(state.warn, 'accessor_value', source, key);
        continue;
      }
      state.keys += 1;
      const next = sanitizeValue(descriptor.value, state, depth + 1, source);
      if (next !== undefined && cleanKey) defineData(out, cleanKey, next);
    }
    return out;
  } finally {
    state.seen.delete(value);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function canonicalPath(route) {
  const raw = typeof route?.path === 'string' ? route.path : '';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  return textValue(raw.split(/[?#]/u, 1)[0] || '/');
}

function normalizeScope(scope) {
  if (dataProperty(scope, 'kind') !== 'task') return null;
  const taskId = String(dataProperty(scope, 'taskId') || '').trim();
  return TASK_ID_RE.test(taskId) ? { kind: 'task', taskId } : null;
}

function descriptorPriority(value) {
  const priority = dataProperty(value, 'priority');
  if (Number.isFinite(priority)) return Math.max(-1000, Math.min(1000, Number(priority)));
  return LAYER_PRIORITY[dataProperty(value, 'layer')] ?? LAYER_PRIORITY.background;
}

/**
 * Реестр без зависимостей, используемый Pinia и unit-тестами. Регистрация никогда не выполняет
 * сетевую работу или обращение к модели; единственный побочный эффект — ограниченная локальная диагностика.
 */
export function createUiContextRegistry({ warn = null } = {}) {
  const entries = new Map();
  let revision = 0;

  function register(id, initial = {}) {
    const source = textValue(id || '');
    if (!source) throw new TypeError('ui-context source id обязателен');
    if ([...entries.values()].some((entry) => entry.id === source && entry.active)) {
      safeWarn(warn, 'duplicate_source', source);
    }
    const token = Symbol(source);
    const entry = {
      id: source,
      value: initial || {},
      focusRevision: ++revision,
      active: dataProperty(initial, 'active') !== false,
    };
    entries.set(token, entry);
    let disposed = false;
    return Object.freeze({
      update(next = {}) {
        if (disposed || entries.get(token) !== entry) return false;
        entry.value = next || {};
        entry.active = dataProperty(next, 'active') !== false;
        return true;
      },
      focus() {
        if (disposed || entries.get(token) !== entry) return false;
        entry.active = true;
        entry.focusRevision = ++revision;
        return true;
      },
      dispose() {
        if (disposed || entries.get(token) !== entry) return false;
        disposed = true;
        entries.delete(token);
        revision += 1;
        return true;
      },
    });
  }

  function capture(route) {
    const active = [...entries.values()].filter((entry) => entry.active && dataProperty(entry.value, 'active') !== false);
    const rank = (entry) => [descriptorPriority(entry.value), entry.focusRevision];
    const compare = (left, right) => {
      const a = rank(left); const b = rank(right);
      return b[0] - a[0] || b[1] - a[1];
    };
    active.sort(compare);

    const state = { keys: 0, seen: new WeakSet(), warn };
    const details = {};
    const chosen = new Set();
    for (const entry of active) {
      const rawDetails = dataProperty(entry.value, 'details');
      if (chosen.has(entry.id) || rawDetails == null) continue;
      chosen.add(entry.id);
      // Source id становится ключом details так же, как и имена
      // внутри provider payload. Поэтому denylist обязан работать на
      // обоих уровнях: `register('Token', ...)` не должен собрать
      // prompt, даже если сам payload выглядит безобидно.
      if (forbiddenName(entry.id)) {
        safeWarn(warn, 'forbidden_source', entry.id);
        continue;
      }
      try {
        const clean = sanitizeValue(rawDetails, state, 0, entry.id);
        if (clean !== undefined && (typeof clean !== 'object' || Object.keys(clean).length || Array.isArray(clean))) {
          defineData(details, entry.id, clean);
        }
      } catch {
        safeWarn(warn, 'provider_failed', entry.id);
      }
    }

    const promptContext = {
      page: textValue(route?.meta?.title || canonicalPath(route)),
      path: canonicalPath(route),
      ...(Object.keys(details).length ? { details } : {}),
    };
    if (byteLength(JSON.stringify(promptContext)) > UI_CONTEXT_LIMITS.bytes) delete promptContext.details;

    const scoped = active.find((entry) => normalizeScope(dataProperty(entry.value, 'routingScope')));
    return deepFreeze({
      routingScope: scoped ? normalizeScope(dataProperty(scoped.value, 'routingScope')) : null,
      promptContext,
    });
  }

  return Object.freeze({ register, capture, size: () => entries.size });
}

export const useUiContextStore = defineStore('uiContext', () => {
  const revision = ref(0);
  const registry = createUiContextRegistry({
    warn(event) { console.warn('[ui-context]', event.code, event.source, event.key || ''); },
  });

  function wrap(handle) {
    return {
      update(value) { const changed = handle.update(value); if (changed) revision.value += 1; return changed; },
      focus() { const changed = handle.focus(); if (changed) revision.value += 1; return changed; },
      dispose() { const changed = handle.dispose(); if (changed) revision.value += 1; return changed; },
    };
  }
  function register(id, value) {
    const handle = wrap(registry.register(id, value));
    revision.value += 1;
    return handle;
  }
  function capture(route) {
    // Чтение revision делает capture реактивным в computed, но не меняет снимок.
    void revision.value;
    return registry.capture(route);
  }

  return { revision, register, capture };
});
