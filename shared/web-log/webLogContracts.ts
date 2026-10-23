// Общий контракт журнала не зависит ни от браузера, ни от Fastify.
// Любой текст из автоматических событий сначала проходит здесь через закрытый каталог.

import { recordOrNull } from '../lib/objects.ts';

import { isApiRouteTemplate } from './webLogApiRoutes.ts';

export const WEB_LOG_LIMITS = {
  ringEntries: 500,
  ringBytes: 1024 * 1024,
  entryBytes: 4 * 1024,
  markedEntryBytes: 32 * 1024,
  dumpEntries: 100,
  dumpBytes: 24 * 1024,
  queueEntries: 200,
  queueBytes: 64 * 1024,
  batchEntries: 50,
  batchBytes: 48 * 1024,
  serverEntries: 200,
  serverBytes: 256 * 1024,
} as const;

export const WEB_LOG_EVENTS = {
  'app.start': 'info',
  'app.pagehide': 'info',
  'page.show': 'info',
  'page.visibility': 'debug',
  'page.freeze': 'info',
  'page.resume': 'info',
  'net.online': 'info',
  'net.offline': 'info',
  'vue.error': 'error',
  'js.error': 'error',
  'js.rejection': 'error',
  'res.error': 'error',
  'router.nav': 'debug',
  'router.error': 'error',
  'api.fail': 'warn',
  'api.slow': 'warn',
  'sse.open': 'info',
  'sse.hello': 'info',
  'sse.error': 'warn',
  'auth.change': 'info',
  'sw.updatefound': 'info',
  'sw.controllerchange': 'info',
  'sw.needRefresh': 'info',
  'store.error': 'error',
  'ui.layer': 'debug',
  'ui.focus': 'debug',
  mark: 'warn',
  'log.transport': 'warn',
  'log.loss': 'warn',
  'log.suppressed': 'info',
} as const;

export type WebLogEvent = keyof typeof WEB_LOG_EVENTS;
export type WebLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type WebLogKey = { page: string; seq: number };

export type SafeDescriptor = { tag: string; context?: string };

export type SafeError = {
  name: string;
  category: string;
  message: string;
  stack?: string;
};

export type WebLogData = {
  'app.start': {
    browser?: string;
    os?: string;
    w?: number;
    h?: number;
    dpr?: number;
    standalone?: boolean;
    wasDiscarded?: boolean;
    sw?: string;
    queued?: number;
    storage?: boolean;
  };
  'app.pagehide': { persisted: boolean };
  'page.show': { persisted: boolean };
  'page.visibility': { state: 'visible' | 'hidden' };
  'page.freeze': Record<string, never>;
  'page.resume': Record<string, never>;
  'net.online': Record<string, never>;
  'net.offline': Record<string, never>;
  'vue.error': {
    error: SafeError;
    info?: string;
    component?: string;
  };
  'js.error': {
    error: SafeError;
    source?: string | null;
    line?: number;
    col?: number;
  };
  'js.rejection': { error: SafeError };
  'res.error': {
    tag: string;
    category: string;
    src?: string | null;
  };
  'router.nav': {
    from: string;
    to: string;
    ms: number;
    result: string;
  };
  'router.error': { to: string; error: SafeError };
  'api.fail': {
    method: string;
    path: string;
    status?: number;
    name?: string;
    ms: number;
    attempt: number;
    willRetry: boolean;
  };
  'api.slow': {
    method: string;
    path: string;
    ms: number;
    attempt: number;
  };
  'sse.open': { gapMs?: number; retries?: number };
  'sse.hello': { boot: string | null; changed: boolean };
  'sse.error': { uptimeMs?: number; retries?: number };
  'auth.change': {
    ready: boolean;
    authenticated: boolean;
    reason: string;
  };
  'sw.updatefound': Record<string, never>;
  'sw.controllerchange': Record<string, never>;
  'sw.needRefresh': Record<string, never>;
  'store.error': {
    store: string;
    action: string;
    error: SafeError;
  };
  'ui.layer': {
    op: string;
    kind: string;
    id: number;
    depth: number;
  };
  'ui.focus': { target: SafeDescriptor };
  mark: { text: string };
  'log.transport': {
    status?: number;
    name?: string;
    pending: number;
    reason: string;
  };
  'log.loss': {
    queueEvicted: number;
    storageFailed: number;
    invalid: number;
    quotaDropped: number;
  };
  'log.suppressed': {
    signature: string;
    count: number;
    periodMs: number;
  };
};

export type WebLogFlatEntry = {
  v: 1;
  t: string;
  seq: number;
  tab: string;
  page: string;
  ver: string;
  boot: string | null;
  lvl: WebLogLevel;
  ev: WebLogEvent;
  route: string;
  vis: 'visible' | 'hidden';
  data: WebLogData[WebLogEvent];
};

export type WebLogDump = {
  entries: WebLogFlatEntry[];
  omitted: number;
  from: string | null;
  to: string | null;
};

export type WebLogEntry = WebLogFlatEntry & { dump?: WebLogDump };

// Каталог шаблонов /api. Сервер передаёт живой набор; reader и браузер без него
// проверяют только форму шаблона.
export type ApiRouteCatalog = { has(template: string): boolean };

export type ProjectOptions = {
  nested?: boolean;
  apiRoutes?: ApiRouteCatalog | null;
};

type FieldKind = 'bool' | 'number' | 'count' | 'id' | 'route' | 'api' | 'method'
  | 'error' | 'failureName' | 'descriptor' | 'text' | 'source' | 'vueSource' | 'component'
  | 'store' | 'action' | 'signature' | 'browser' | 'os' | 'sw' | 'tag' | 'category'
  | 'result' | 'authReason' | 'transportReason' | 'visibility' | 'operation' | 'layer';

type FieldSchema = Record<string, FieldKind>;

const DATA_FIELDS: Record<WebLogEvent, FieldSchema> = {
  'app.start': {
    browser: 'browser',
    os: 'os',
    w: 'number',
    h: 'number',
    dpr: 'number',
    standalone: 'bool',
    wasDiscarded: 'bool',
    sw: 'sw',
    queued: 'count',
    storage: 'bool',
  },
  'app.pagehide': { persisted: 'bool' },
  'page.show': { persisted: 'bool' },
  'page.visibility': { state: 'visibility' },
  'page.freeze': {},
  'page.resume': {},
  'net.online': {},
  'net.offline': {},
  'vue.error': {
    error: 'error',
    info: 'vueSource',
    component: 'component',
  },
  'js.error': {
    error: 'error',
    source: 'source',
    line: 'count',
    col: 'count',
  },
  'js.rejection': { error: 'error' },
  'res.error': {
    tag: 'tag',
    category: 'category',
    src: 'source',
  },
  'router.nav': {
    from: 'route',
    to: 'route',
    ms: 'number',
    result: 'result',
  },
  'router.error': { to: 'route', error: 'error' },
  'api.fail': {
    method: 'method',
    path: 'api',
    status: 'count',
    name: 'failureName',
    ms: 'number',
    attempt: 'count',
    willRetry: 'bool',
  },
  'api.slow': {
    method: 'method',
    path: 'api',
    ms: 'number',
    attempt: 'count',
  },
  'sse.open': { gapMs: 'number', retries: 'count' },
  'sse.hello': { boot: 'id', changed: 'bool' },
  'sse.error': { uptimeMs: 'number', retries: 'count' },
  'auth.change': {
    ready: 'bool',
    authenticated: 'bool',
    reason: 'authReason',
  },
  'sw.updatefound': {},
  'sw.controllerchange': {},
  'sw.needRefresh': {},
  'store.error': {
    store: 'store',
    action: 'action',
    error: 'error',
  },
  'ui.layer': {
    op: 'operation',
    kind: 'layer',
    id: 'count',
    depth: 'count',
  },
  'ui.focus': { target: 'descriptor' },
  mark: { text: 'text' },
  'log.transport': {
    status: 'count',
    name: 'failureName',
    pending: 'count',
    reason: 'transportReason',
  },
  'log.loss': {
    queueEvicted: 'count',
    storageFailed: 'count',
    invalid: 'count',
    quotaDropped: 'count',
  },
  'log.suppressed': {
    signature: 'signature',
    count: 'count',
    periodMs: 'number',
  },
};

const REQUIRED_FIELDS: Partial<Record<WebLogEvent, string[]>> = {
  'app.pagehide': ['persisted'],
  'page.show': ['persisted'],
  'page.visibility': ['state'],
  'vue.error': ['error'],
  'js.error': ['error'],
  'js.rejection': ['error'],
  'res.error': ['tag', 'category'],
  'router.nav': ['from', 'to', 'ms', 'result'],
  'router.error': ['to', 'error'],
  'api.fail': ['method', 'path', 'ms', 'attempt', 'willRetry'],
  'api.slow': ['method', 'path', 'ms', 'attempt'],
  'sse.hello': ['boot', 'changed'],
  'auth.change': ['ready', 'authenticated', 'reason'],
  'store.error': ['store', 'action', 'error'],
  'ui.layer': ['op', 'kind', 'id', 'depth'],
  'ui.focus': ['target'],
  mark: ['text'],
  'log.transport': ['pending', 'reason'],
  'log.loss': ['queueEvicted', 'storageFailed', 'invalid', 'quotaDropped'],
  'log.suppressed': ['signature', 'count', 'periodMs'],
};

// Шаблоны маршрутов окна. Тест сверяет список с web/src/router.js.
export const WEB_LOG_ROUTES = [
  '/', '/board', '/pipeline', '/sandboxes', '/showcase/:id?', '/chats',
  '/diff', '/documents', '/terminal', '/ssh', '/db', '/docker', '/routes',
  '/projects/:id?', '/code', '/shelf', '/tools', '/ext/:id', '/video', '/inbox',
  '/github', '/telegram', '/settings', '/3d', '/surface',
] as const;

const LAYERS = [
  'tools', 'dock', 'dialog', 'diff-workspace', 'document', 'banner',
  'tooltip', 'popover', 'confirm', 'other',
] as const;

// Источник ошибки Vue: код production-сборки, имя в журнале и текст dev-сборки.
const VUE_ERROR_SOURCES = [
  ['sp', 'serverPrefetch', 'serverPrefetch hook'],
  ['bc', 'beforeCreate', 'beforeCreate hook'],
  ['c', 'created', 'created hook'],
  ['bm', 'beforeMount', 'beforeMount hook'],
  ['m', 'mounted', 'mounted hook'],
  ['bu', 'beforeUpdate', 'beforeUpdate hook'],
  ['u', 'updated', 'updated'],
  ['bum', 'beforeUnmount', 'beforeUnmount hook'],
  ['um', 'unmounted', 'unmounted hook'],
  ['a', 'activated', 'activated hook'],
  ['da', 'deactivated', 'deactivated hook'],
  ['ec', 'errorCaptured', 'errorCaptured hook'],
  ['rtc', 'renderTracked', 'renderTracked hook'],
  ['rtg', 'renderTriggered', 'renderTriggered hook'],
  ['0', 'setup', 'setup function'],
  ['1', 'render', 'render function'],
  ['2', 'watcher-getter', 'watcher getter'],
  ['3', 'watcher-callback', 'watcher callback'],
  ['4', 'watcher-cleanup', 'watcher cleanup function'],
  ['5', 'native-event', 'native event handler'],
  ['6', 'component-event', 'component event handler'],
  ['7', 'vnode-hook', 'vnode hook'],
  ['8', 'directive-hook', 'directive hook'],
  ['9', 'transition-hook', 'transition hook'],
  ['10', 'app-error-handler', 'app errorHandler'],
  ['11', 'app-warn-handler', 'app warnHandler'],
  ['12', 'ref-function', 'ref function'],
  ['13', 'async-loader', 'async component loader'],
  ['14', 'scheduler', 'scheduler flush'],
  ['15', 'component-update', 'component update'],
  ['16', 'app-unmount', 'app unmount cleanup function'],
] as const;

const VUE_SOURCE_NAMES: readonly string[] = VUE_ERROR_SOURCES.map(([, name]) => name);

const INVALID = Symbol('invalid');

type Invalid = typeof INVALID;

/**
 * Размер записи в байтах UTF-8 её JSON. Все лимиты журнала считаются так,
 * включая кириллицу и экранирование.
 */
export function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/**
 * Путь окна превращается в шаблон зарегистрированного маршрута:
 * `/projects/abc` → `/projects/:id?`. Незнакомый путь становится `other`.
 */
export function normalizeRoute(value: unknown): string {
  if (typeof value !== 'string') {
    return 'other';
  }
  if ((WEB_LOG_ROUTES as readonly string[]).includes(value)) {
    return value;
  }

  const path = value.split(/[?#]/u, 1)[0] || '';

  for (const route of WEB_LOG_ROUTES) {
    if (!route.includes(':id')) {
      if (path === route) {
        return route;
      }

      continue;
    }

    const base = route.split('/:id')[0] || '';

    if (path === base && route.endsWith('?')) {
      return route;
    }
    if (path.startsWith(`${base}/`) && /^\/[^/]+$/u.test(path.slice(base.length))) {
      return route;
    }
  }

  return 'other';
}

/**
 * Vue сообщает место ошибки кодом `…#runtime-1` в production и текстом в dev.
 * Обе формы сводятся к одному имени каталога; прочее — `other`.
 */
export function vueErrorSource(info: unknown): string {
  if (typeof info !== 'string') {
    return 'other';
  }

  const code = /#runtime-([a-z]{1,3}|\d{1,2})$/u.exec(info)?.[1];
  const match = VUE_ERROR_SOURCES.find(([key, , text]) => key === code || text === info);

  return match ? match[1] : 'other';
}

/**
 * Значение из закрытого списка. Строка вне списка становится `other`,
 * а значение другого типа отклоняет всю запись.
 */
function safeEnum(value: unknown, choices: readonly string[]): string | Invalid {
  if (typeof value !== 'string') {
    return INVALID;
  }

  return choices.includes(value) ? value : 'other';
}

/**
 * Имена stores, actions и компонентов — идентификаторы исходного кода.
 * Шаблон не пропускает пробелы, пути и знаки, по которым ушёл бы текст данных.
 */
function safeIdentifier(value: unknown, pattern: RegExp): string | Invalid {
  if (typeof value !== 'string') {
    return INVALID;
  }

  return pattern.test(value) ? value : 'other';
}

/**
 * Адрес ресурса сохраняется только для файла сборки `/assets/<имя>-<хэш>`.
 * Чужие адреса, data: и blob: превращаются в null.
 */
function safeSource(value: unknown): string | null | Invalid {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    return INVALID;
  }

  const path = value.replace(/^https?:\/\/[^/]+/u, '').split(/[?#]/u, 1)[0] || '';

  return /^\/assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{6,}\.(?:js|css)$/u.test(path) ? path : null;
}

/**
 * Путь /api хранится только шаблоном. С живым каталогом сервера проверяется
 * членство, без него — форма шаблона; остальное становится `other`.
 */
function projectApiPath(value: unknown, apiRoutes?: ApiRouteCatalog | null): string | Invalid {
  if (typeof value !== 'string') {
    return INVALID;
  }
  if (value === 'other') {
    return value;
  }
  if (apiRoutes) {
    return apiRoutes.has(value) ? value : 'other';
  }

  return isApiRouteTemplate(value) ? value : 'other';
}

/**
 * От ошибки остаются имя, категория и сообщение из закрытых списков,
 * а стек — только кадрами файлов сборки без текста сообщения.
 */
function safeError(value: unknown): SafeError | Invalid {
  const raw = recordOrNull(value);

  if (!raw) {
    return INVALID;
  }

  const name = safeEnum(raw.name ?? 'Error', [
    'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError',
    'AggregateError', 'AbortError', 'TimeoutError', 'NetworkError',
  ]);
  const category = safeEnum(raw.category ?? 'unclassified', [
    'chunk-load', 'network', 'timeout', 'abort', 'http', 'render', 'unclassified',
  ]);
  const message = safeEnum(raw.message ?? 'unclassified', [
    'Failed to fetch', 'Load failed', 'NetworkError', 'The operation was aborted.',
    'Importing a module script failed.', 'unclassified',
  ]);

  if (name === INVALID || category === INVALID || message === INVALID) {
    return INVALID;
  }

  const result: SafeError = {
    name: name === 'other' ? 'Error' : name,
    category: category === 'other' ? 'unclassified' : category,
    message: message === 'other' ? 'unclassified' : message,
  };

  if (raw.stack !== undefined) {
    if (typeof raw.stack !== 'string') {
      return INVALID;
    }

    const frames = [...raw.stack.matchAll(
      /\/assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{6,}\.js:(\d{1,7}):(\d{1,7})/gu,
    )].slice(0, 20);

    result.stack = frames.map((frame) => frame[0]).join('\n').slice(0, 2000);
  }

  return result;
}

/**
 * DOM-цель описывается тегом и областью интерфейса из закрытых списков,
 * без текста, классов и атрибутов.
 */
function safeDescriptor(value: unknown): SafeDescriptor | Invalid {
  const raw = recordOrNull(value);

  if (!raw || typeof raw.tag !== 'string') {
    return INVALID;
  }

  const tag = safeEnum(raw.tag.toUpperCase(), [
    'DIV', 'SPAN', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'A', 'HEADER', 'NAV',
    'MAIN', 'SECTION', 'DIALOG', 'LABEL', 'SVG', 'BODY', 'HTML', 'OTHER',
  ]);

  if (tag === INVALID) {
    return INVALID;
  }

  const result: SafeDescriptor = { tag };

  if (raw.context !== undefined) {
    const context = safeEnum(raw.context, ['topbar', 'dialog', 'other']);

    if (context === INVALID) {
      return INVALID;
    }

    result.context = context;
  }

  return result;
}

/**
 * Конечное число в разумных пределах; для счётчиков — ещё и целое неотрицательное.
 * Иное значение отклоняет всю запись.
 */
function numeric(value: unknown, count = false): number | Invalid {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1_000_000_000) {
    return INVALID;
  }
  if (count && (!Number.isInteger(value) || value < 0)) {
    return INVALID;
  }

  return value;
}

/** Закрытые перечисления полей: неизвестная строка становится `other`. */
const ENUMS: Partial<Record<FieldKind, readonly string[]>> = {
  signature: ['api', 'js', 'vue', 'store', 'router', 'res'],
  layer: LAYERS,
  visibility: ['visible', 'hidden'],
  method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  browser: ['Chrome', 'Firefox', 'Safari', 'Edge', 'other'],
  os: ['Linux', 'Windows', 'macOS', 'Android', 'iOS', 'other'],
  sw: ['active', 'none', 'unsupported'],
  tag: ['SCRIPT', 'LINK', 'IMG', 'VIDEO', 'AUDIO', 'other'],
  category: ['chunk-load', 'resource', 'external', 'data', 'blob', 'other'],
  result: ['success', 'cancelled', 'aborted', 'duplicated'],
  operation: ['open', 'close'],
  authReason: ['load', 'login', 'setup', '401', 'logout'],
  transportReason: ['timeout', 'offline', 'http', 'invalid-ack', 'policy', '401'],
  vueSource: VUE_SOURCE_NAMES,
  failureName: ['Error', 'AbortError', 'TimeoutError', 'TypeError', 'NetworkError', 'HTTPError'],
};

/**
 * Проекция одного поля по его виду. Для строк используются только каталоги
 * и шаблоны; свободный текст разрешён лишь для комментария человека к отметке.
 */
function projectField(
  kind: FieldKind,
  value: unknown,
  options: ProjectOptions,
): unknown | Invalid {
  const choices = ENUMS[kind];

  if (choices) {
    return safeEnum(value, choices);
  }
  if (kind === 'bool') {
    return typeof value === 'boolean' ? value : INVALID;
  }
  if (kind === 'number' || kind === 'count') {
    return numeric(value, kind === 'count');
  }
  if (kind === 'route') {
    return typeof value === 'string' ? normalizeRoute(value) : INVALID;
  }
  if (kind === 'api') {
    return projectApiPath(value, options.apiRoutes);
  }
  if (kind === 'id') {
    return value === null || (typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/u.test(value))
      ? value
      : INVALID;
  }
  if (kind === 'error') {
    return safeError(value);
  }
  if (kind === 'descriptor') {
    return safeDescriptor(value);
  }
  if (kind === 'source') {
    return safeSource(value);
  }
  if (kind === 'component') {
    return safeIdentifier(value, /^[A-Z][A-Za-z0-9]{0,63}$/u);
  }
  if (kind === 'store') {
    return safeIdentifier(value, /^[A-Za-z][A-Za-z0-9-]{0,39}$/u);
  }
  if (kind === 'action') {
    return safeIdentifier(value, /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u);
  }
  if (kind === 'text') {
    if (typeof value !== 'string') {
      return INVALID;
    }

    return value.replace(/[\u0000-\u001F\u007F-\u009F]/gu, ' ').slice(0, 500);
  }

  return INVALID;
}

/**
 * Данные события проходят по схеме своего вида: лишние поля отбрасываются,
 * ошибка типа или отсутствие обязательного поля отклоняет запись.
 */
function projectData(
  ev: WebLogEvent,
  value: unknown,
  options: ProjectOptions,
): WebLogData[WebLogEvent] | null {
  const raw = recordOrNull(value);

  if (!raw) {
    return null;
  }

  const output: Record<string, unknown> = {};

  for (const [name, kind] of Object.entries(DATA_FIELDS[ev])) {
    if (raw[name] === undefined) {
      continue;
    }

    const cleaned = projectField(kind, raw[name], options);

    if (cleaned === INVALID) {
      return null;
    }

    output[name] = cleaned;
  }

  for (const name of REQUIRED_FIELDS[ev] || []) {
    if (!Object.hasOwn(output, name)) {
      return null;
    }
  }

  return output as WebLogData[WebLogEvent];
}

/** Конверт записи: версия, время, ключ и контекст документа строгого вида. */
function envelopeValid(raw: Record<string, unknown>, ev: WebLogEvent): boolean {
  const id = /^[A-Za-z0-9_-]{8,64}$/u;

  return raw.lvl === WEB_LOG_EVENTS[ev]
    && typeof raw.t === 'string' && /^\d{4}-\d{2}-\d{2}T/u.test(raw.t)
    && Number.isFinite(Date.parse(raw.t))
    && typeof raw.seq === 'number' && Number.isSafeInteger(raw.seq) && raw.seq >= 1
    && typeof raw.page === 'string' && id.test(raw.page)
    && typeof raw.tab === 'string' && id.test(raw.tab)
    && typeof raw.ver === 'string' && /^(?:dev|[a-f0-9]{7,40})$/u.test(raw.ver)
    && (raw.boot === null || (typeof raw.boot === 'string' && id.test(raw.boot)))
    && (raw.vis === 'visible' || raw.vis === 'hidden')
    && typeof raw.route === 'string';
}

/**
 * Дамп — только плоские записи того же документа и с меньшим seq. Метаданные
 * периода пересчитываются из самих записей, а размер ограничен вместе с ними.
 */
function projectDump(
  value: unknown,
  entry: WebLogEntry,
  options: ProjectOptions,
): WebLogDump | null {
  const dump = recordOrNull(value);

  if (
    !dump || !Array.isArray(dump.entries) || dump.entries.length > WEB_LOG_LIMITS.dumpEntries
    || typeof dump.omitted !== 'number' || !Number.isSafeInteger(dump.omitted) || dump.omitted < 0
  ) {
    return null;
  }

  const entries: WebLogFlatEntry[] = [];

  for (const candidate of dump.entries) {
    const cleaned = projectWebLogEntry(candidate, {
      ...options,
      nested: true,
    });

    if (!cleaned || cleaned.page !== entry.page || cleaned.seq >= entry.seq) {
      return null;
    }

    entries.push(cleaned);
  }

  const result: WebLogDump = {
    entries,
    omitted: dump.omitted,
    from: entries[0]?.t ?? null,
    to: entries.at(-1)?.t ?? null,
  };

  return utf8Bytes(result) <= WEB_LOG_LIMITS.dumpBytes ? result : null;
}

/**
 * Сервер повторяет эту проекцию для всего тела и записей дампа. Лишние поля
 * удаляются, ошибочные типы и превышение байтового лимита отклоняются.
 */
export function projectWebLogEntry(
  value: unknown,
  options: ProjectOptions = {},
): WebLogEntry | null {
  const raw = recordOrNull(value);

  if (
    !raw || raw.v !== 1 || typeof raw.ev !== 'string' || !Object.hasOwn(WEB_LOG_EVENTS, raw.ev)
    || (options.nested && raw.dump !== undefined)
  ) {
    return null;
  }

  const ev = raw.ev as WebLogEvent;

  if (!envelopeValid(raw, ev)) {
    return null;
  }

  const data = projectData(ev, raw.data, options);

  if (!data) {
    return null;
  }

  const entry: WebLogEntry = {
    v: 1,
    t: raw.t as string,
    seq: raw.seq as number,
    page: raw.page as string,
    tab: raw.tab as string,
    ver: raw.ver as string,
    boot: raw.boot as string | null,
    lvl: WEB_LOG_EVENTS[ev],
    ev,
    route: normalizeRoute(raw.route),
    vis: raw.vis as 'visible' | 'hidden',
    data,
  };

  if (raw.dump !== undefined) {
    if (!(ev === 'mark' || entry.lvl === 'error')) {
      return null;
    }

    const dump = projectDump(raw.dump, entry, options);

    if (!dump) {
      return null;
    }

    entry.dump = dump;
  }

  const limit = entry.dump ? WEB_LOG_LIMITS.markedEntryBytes : WEB_LOG_LIMITS.entryBytes;

  return utf8Bytes(entry) <= limit ? entry : null;
}
