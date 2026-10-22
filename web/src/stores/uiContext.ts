import { ref } from 'vue';
import { defineStore } from 'pinia';

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

interface JsonObject {
  [key: string]: JsonValue;
}

interface WarningEvent {
  code: string;
  source: string;
  key?: string;
}

type WarningSink = (event: WarningEvent) => void;

interface SanitizeState {
  keys: number;
  seen: WeakSet<object>;
  warn: WarningSink | null;
}

interface RegistryEntry {
  id: string;
  value: unknown;
  focusRevision: number;
  active: boolean;
}

interface RegistryOwner {
  update(value?: unknown): boolean;
  focus(): boolean;
  dispose(): boolean;
}

interface CaptureRoute {
  path?: unknown;
  meta?: { title?: unknown };
}

interface PromptContext {
  page: string;
  path: string;
  details?: JsonObject;
}

// Контекст интерфейса — это bounded-снимок, а не канал полномочий.
// Каждый видимый модуль регистрирует owner-token и удаляет только его. Так
// поздний unmount старого overlay не сносит уже открытую карточку.

export const UI_CONTEXT_LIMITS = Object.freeze({
  depth: 4,
  keys: 64,
  array: 32,
  string: 512,
  bytes: 8 * 1024,
});

const LAYER_PRIORITY: Readonly<Record<string, number>> = Object.freeze({
  background: 0,
  dock: 100,
  page: 200,
  overlay: 300,
});
const FORBIDDEN_KEYS = new Set([
  'password', 'passwd', 'token', 'secret', 'authorization', 'cookie', 'credential',
  'buffer', 'output', 'command', 'transcript', '__proto__', 'prototype', 'constructor',
]);
const CONTROL_OR_BIDI = new RegExp(
  '[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f'
    + '\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ud800-\\udfff]',
  'gu',
);
const TASK_ID_RE = /^[1-9][0-9]{0,18}$/;

function forbiddenName(value: unknown): boolean {
  return FORBIDDEN_KEYS.has(String(value || '').toLocaleLowerCase('en-US'));
}

/**
 * Диагностика описывает отбрасывание данных, но не управляет захватом контекста.
 * Ошибка внешнего обработчика не прерывает получение безопасного снимка.
 */
function safeWarn(warn: WarningSink | null, code: string, source: unknown, key = ''): void {
  try {
    warn?.({
      code,
      source: String(source || ''),
      ...(key ? { key } : {}),
    });
  } catch {
    // Диагностика не ломает capture.
  }
}

function textValue(value: unknown): string {
  return Array.from(String(value).replace(CONTROL_OR_BIDI, '')).slice(0, UI_CONTEXT_LIMITS.string).join('');
}

/**
 * Читает только собственное поле данных, не вызывая пользовательский getter.
 * Невалидный объект или отказ proxy превращается в отсутствие поля.
 */
function dataProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function defineData(target: JsonObject, key: string, value: JsonValue): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Снимает ограниченную JSON-проекцию недоверенных данных без вызова аксессоров.
 * Общий бюджет ключей, глубины и строк применяется ко всем источникам снимка.
 */
function sanitizeValue(
  value: unknown,
  state: SanitizeState,
  depth: number,
  source: string,
): JsonValue | undefined {
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return textValue(value);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
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
      const out: JsonValue[] = [];
      const max = Math.min(value.length, UI_CONTEXT_LIMITS.array);

      for (let index = 0; index < max; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));

        if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
          safeWarn(state.warn, 'accessor_value', source, String(index));

          continue;
        }

        const next = sanitizeValue(descriptor.value, state, depth + 1, source);

        if (next !== undefined) {
          out.push(next);
        }
      }

  
    return out;
    }

    const proto = Object.getPrototypeOf(value);

    if (proto !== Object.prototype && proto !== null) {
      safeWarn(state.warn, 'non_plain_object', source);

      return undefined;
    }

    const out: JsonObject = {};
    const descriptors = Object.getOwnPropertyDescriptors(value);

    for (const key of Object.keys(descriptors).sort()) {
      if (state.keys >= UI_CONTEXT_LIMITS.keys) {
        safeWarn(state.warn, 'key_limit', source);

        break;
      }

      const descriptor = descriptors[key]!;
      const cleanKey = textValue(key);
      const normalizedKey = cleanKey.toLocaleLowerCase('en-US');

      if (FORBIDDEN_KEYS.has(normalizedKey)) {
        safeWarn(state.warn, 'forbidden_key', source, key);

        continue;
      }
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        if (descriptor.enumerable) {
          safeWarn(state.warn, 'accessor_value', source, key);
        }

        continue;
      }

      state.keys += 1;

      const next = sanitizeValue(descriptor.value, state, depth + 1, source);

      if (next !== undefined && cleanKey) {
        defineData(out, cleanKey, next);
      }
    }

    return out;
  } finally {
    state.seen.delete(value);
  }
}

/**
 * Замораживает только уже очищенную структуру снимка.
 * Повторный обход замороженного значения не меняет его идентичность.
 */
function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return value;
}

/**
 * Убирает query и hash из пути, попадающего в текстовый контекст.
 * Некорректный или сетевой путь сохраняет прежний корневой fallback.
 */
function canonicalPath(route: CaptureRoute | null | undefined): string {
  const raw = typeof route?.path === 'string' ? route.path : '';

  if (!raw.startsWith('/') || raw.startsWith('//')) {
    return '/';
  }

  return textValue(raw.split(/[?#]/u, 1)[0] || '/');
}

/**
 * Разрешает маршрутизацию только явно описанной задачи с допустимым номером.
 * Остальные данные источника остаются текстовым контекстом без полномочий.
 */
function normalizeScope(scope: unknown): { kind: 'task'; taskId: string } | null {
  if (dataProperty(scope, 'kind') !== 'task') {
    return null;
  }

  const taskId = String(dataProperty(scope, 'taskId') || '').trim();

  return TASK_ID_RE.test(taskId) ? { kind: 'task', taskId } : null;
}

function descriptorPriority(value: unknown): number {
  const priority = dataProperty(value, 'priority');

  if (Number.isFinite(priority)) {
    return Math.max(-1000, Math.min(1000, Number(priority)));
  }

  return LAYER_PRIORITY[dataProperty(value, 'layer') as string] ?? LAYER_PRIORITY.background!;
}

/**
 * Реестр без зависимостей, используемый Pinia и unit-тестами. Регистрация никогда не выполняет
 * сетевую работу или обращение к модели; единственный побочный эффект — ограниченная локальная диагностика.
 */
export function createUiContextRegistry({ warn = null }: { warn?: WarningSink | null } = {}) {
  const entries = new Map<symbol, RegistryEntry>();
  let revision = 0;

  /**
   * Создаёт владельца источника с отдельным токеном и ревизией фокуса.
   * Повторное имя диагностируется, но не подменяет запись прежнего владельца.
   */
  function register(id: unknown, initial: unknown = {}): RegistryOwner {
    const source = textValue(id || '');

    if (!source) {
      throw new TypeError('ui-context source id обязателен');
    }
    if ([...entries.values()].some((entry) => entry.id === source && entry.active)) {
      safeWarn(warn, 'duplicate_source', source);
    }

    const token = Symbol(source);
    const entry: RegistryEntry = {
      id: source,
      value: initial || {},
      focusRevision: ++revision,
      active: dataProperty(initial, 'active') !== false,
    };

    entries.set(token, entry);

    let disposed = false;

    return Object.freeze({
      /**
       * Обновляет данные своего источника без изменения очереди фокуса.
       * Закрытая ручка не может воскресить снятый контекст.
       */
      update(next: unknown = {}): boolean {
        if (disposed || entries.get(token) !== entry) {
          return false;
        }

        entry.value = next || {};
        entry.active = dataProperty(next, 'active') !== false;

        return true;
      },
      /**
       * Возвращает источнику активность и двигает его ревизию фокуса.
       * Остальные записи остаются зарегистрированными с прежним порядком.
       */
      focus() {
        if (disposed || entries.get(token) !== entry) {
          return false;
        }

        entry.active = true;
        entry.focusRevision = ++revision;

        return true;
      },
      /**
       * Освобождает только запись данного токена и увеличивает ревизию реестра.
       * Поздний disposer не может удалить нового владельца того же имени.
       */
      dispose() {
        if (disposed || entries.get(token) !== entry) {
          return false;
        }

        disposed = true;
        entries.delete(token);
        revision += 1;

        return true;
      },
    });
  }

  /**
   * Выбирает активные источники по слою и фокусу, затем очищает общий снимок.
   * Контекст и маршрут задачи замораживаются вместе после проверки бюджетов.
   */
  function capture(route: CaptureRoute | null | undefined) {
    const active = [...entries.values()].filter((entry) => (
      entry.active && dataProperty(entry.value, 'active') !== false
    ));
    const rank = (entry: RegistryEntry): [number, number] => [
      descriptorPriority(entry.value),
      entry.focusRevision,
    ];
    const compare = (left: RegistryEntry, right: RegistryEntry): number => {
      const a = rank(left);
      const b = rank(right);

      return b[0] - a[0] || b[1] - a[1];
    };

    active.sort(compare);


    const state = {
      keys: 0,
      seen: new WeakSet<object>(),
      warn,
    };
    const details: JsonObject = {};
    const chosen = new Set<string>();

    for (const entry of active) {
      const rawDetails = dataProperty(entry.value, 'details');

      if (chosen.has(entry.id) || rawDetails == null) {
        continue;
      }

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

        if (clean !== undefined
            && (typeof clean !== 'object' || Object.keys(clean!).length || Array.isArray(clean))) {
          defineData(details, entry.id, clean);
        }
      } catch {
        safeWarn(warn, 'provider_failed', entry.id);
      }
    }

    const promptContext: PromptContext = {
      page: textValue(route?.meta?.title || canonicalPath(route)),
      path: canonicalPath(route),
      ...(Object.keys(details).length ? { details } : {}),
    };

    if (byteLength(JSON.stringify(promptContext)) > UI_CONTEXT_LIMITS.bytes) {
      delete promptContext.details;
    }

    const scoped = active.find((entry) => normalizeScope(dataProperty(entry.value, 'routingScope')));

    return deepFreeze({
      routingScope: scoped ? normalizeScope(dataProperty(scoped.value, 'routingScope')) : null,
      promptContext,
    });
  }

  return Object.freeze({
    register,
    capture,
    size: () => entries.size,
  });
}

export const useUiContextStore = defineStore('uiContext', () => {
  const revision = ref(0);
  const registry = createUiContextRegistry({
    warn(event) {
      console.warn('[ui-context]', event.code, event.source, event.key || '');
    },
  });

  function wrap(handle: RegistryOwner): RegistryOwner {
    return {
      update(value: unknown) {
        const changed = handle.update(value);

        if (changed) {
          revision.value += 1;
        }

        return changed;
      },
      /**
       * Возвращает источнику активность и двигает его ревизию фокуса.
       * Остальные записи остаются зарегистрированными с прежним порядком.
       */
      focus() {
        const changed = handle.focus();

        if (changed) {
          revision.value += 1;
        }

        return changed;
      },
      /**
       * Освобождает только запись данного токена и увеличивает ревизию реестра.
       * Поздний disposer не может удалить нового владельца того же имени.
       */
      dispose() {
        const changed = handle.dispose();

        if (changed) {
          revision.value += 1;
        }

        return changed;
      },
    };
  }

  function register(id: unknown, value: unknown): RegistryOwner {
    const handle = wrap(registry.register(id, value));

    revision.value += 1;

    return handle;
  }
  /**
   * Выбирает активные источники по слою и фокусу, затем очищает общий снимок.
   * Контекст и маршрут задачи замораживаются вместе после проверки бюджетов.
   */
  function capture(route: CaptureRoute | null | undefined) {
    // Чтение revision делает capture реактивным в computed, но не меняет снимок.
    void revision.value;

    return registry.capture(route);
  }

  return {
    revision,
    register,
    capture,
  };
});
