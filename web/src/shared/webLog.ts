import {
  WEB_LOG_EVENTS,
  WEB_LOG_LIMITS,
  projectWebLogEntry,
  utf8Bytes,
} from '../../../shared/web-log/webLogContracts.ts';
import {
  allowsWebLogEvent,
  filterWebLogEntry,
} from '../../../shared/web-log/diagnosticLogging.ts';

import type {
  WebLogData,
  WebLogDump,
  WebLogEntry,
  WebLogEvent,
  WebLogFlatEntry,
  WebLogKey,
} from '../../../shared/web-log/webLogContracts.ts';
import type { DiagnosticLevel } from '../../../shared/web-log/diagnosticLogging.ts';

// Потери доставки: записи, которые должны были уйти на сервер, но не ушли.
// Штатная ротация кольца и подавленные повторы сюда не входят.
export type WebLogLoss = {
  queueEvicted: number;
  storageFailed: number;
  invalid: number;
  quotaDropped: number;
};

export type WebLogContext = {
  route?: string;
  vis?: 'visible' | 'hidden';
  boot?: string | null;
};

export type WebLogOptions = {
  now: () => Date;
  monotonicNow: () => number;
  pageId: string;
  tabId: string;
  version: string;
  context: () => WebLogContext;
  level?: DiagnosticLevel | null;
};

export type WebLogSnapshot = {
  entries: WebLogEntry[];
  count: number;
  bytes: number;
  page: string;
  seq: number;
  loss: WebLogLoss;
  ringEvicted: number;
  suppressed: number;
  from: string | null;
  to: string | null;
  level: DiagnosticLevel | null;
};

export type WebLogStatus = Omit<WebLogSnapshot, 'entries'>;

export type WebLog = {
  record<E extends WebLogEvent>(ev: E, data: WebLogData[E]): WebLogKey | null;
  mark(text: string): WebLogKey | null;
  dump(n?: number): WebLogDump;
  subscribe(fn: (entry: WebLogEntry) => void): () => void;
  snapshot(): WebLogSnapshot;
  status(): WebLogStatus;
  noteLoss(kind: keyof WebLogLoss, count?: number): void;
  sweep(): void;
  clear(): void;
  level(): DiagnosticLevel | null;
  setLevel(level: DiagnosticLevel | null): void;
  subscribeLevel(fn: (level: DiagnosticLevel | null) => void): () => void;
};

type Signature = {
  family: string;
  windowStart: number;
  seen: number;
  suppressed: number;
};

const SUPPRESS_WINDOW_MS = 60_000;
const SUPPRESS_AFTER = 5;
const SIGNATURE_LIMIT = 100;
const EARLY_LIMIT = 100;

const SUPPRESSIBLE = new Set<WebLogEvent>([
  'api.fail',
  'vue.error',
  'js.error',
  'js.rejection',
  'router.error',
  'res.error',
  'store.error',
]);

/**
 * Сигнатура повтора строится из уже очищенных полей, поэтому разные ошибки
 * одного вида не делят общий счётчик, а исходный текст в неё не попадает.
 */
function signatureOf(ev: WebLogEvent, data: WebLogData[WebLogEvent]): string {
  const body = data as Record<string, unknown>;
  const error = (body.error ?? {}) as Record<string, unknown>;
  const frame = typeof error.stack === 'string' ? error.stack.split('\n', 1)[0] : '';
  const parts = [
    ev, error.name, error.category, error.message, frame, body.component, body.info,
    body.store, body.action, body.source, body.line, body.col, body.method, body.path,
    body.status, body.name, body.tag, body.category, body.src, body.to,
  ];

  return parts.map((part) => (part === undefined || part === null ? '' : String(part))).join('|');
}

/**
 * Чистое ядро хранит только проверенные записи. Даже повреждённый вход,
 * бросающий getter или подписчик не может прервать приложение.
 */
export function createWebLog(options: WebLogOptions): WebLog {
  const entries: WebLogEntry[] = [];
  const subscribers = new Set<(entry: WebLogEntry) => void>();
  const levelSubscribers = new Set<(level: DiagnosticLevel | null) => void>();
  const deferred: WebLogFlatEntry[] = [];
  const signatures = new Map<string, Signature>();
  const loss: WebLogLoss = {
    queueEvicted: 0,
    storageFailed: 0,
    invalid: 0,
    quotaDropped: 0,
  };
  let seq = 0;
  let bytes = 0;
  let ringEvicted = 0;
  let suppressedTotal = 0;
  let lastErrorDump = -Infinity;
  let currentLevel = options.level === undefined ? 'verbose' : options.level;

  /**
   * Единый вход политики: при снижении уровня удаляем прежнюю предысторию,
   * не перенумеровывая записи текущего документа.
   */
  function setLevel(level: DiagnosticLevel | null): void {
    if (currentLevel === level) {
      return;
    }

    currentLevel = level;

    const retained = entries.flatMap((entry) => {
      const filtered = filterWebLogEntry(level, entry);

      return filtered ? [filtered] : [];
    });

    entries.splice(0, entries.length, ...retained);
    bytes = retained.reduce((total, entry) => total + utf8Bytes(entry), 0);
    signatures.clear();

    const early = deferred.splice(0);

    for (const entry of early) {
      if (allowsWebLogEvent(level, entry.ev)) {
        recordInternal(entry.ev, entry.data, true, entry);
      }
    }

    for (const fn of levelSubscribers) {
      try {
        fn(level);
      } catch {
        /* наблюдатель политики не влияет на приложение */
      }
    }
  }

  function subscribeLevel(fn: (level: DiagnosticLevel | null) => void): () => void {
    levelSubscribers.add(fn);

    return () => levelSubscribers.delete(fn);
  }

  function noteLoss(kind: keyof WebLogLoss, count = 1): void {
    if (Number.isSafeInteger(count) && count > 0) {
      loss[kind] += count;
    }
  }

  /** Метаданные для часто обновляемой панели без копирования всего кольца. */
  function status(): WebLogStatus {
    return {
      count: entries.length,
      bytes,
      page: options.pageId,
      seq,
      loss: { ...loss },
      ringEvicted,
      suppressed: suppressedTotal,
      from: entries[0]?.t ?? null,
      to: entries.at(-1)?.t ?? null,
      level: currentLevel,
    };
  }

  function snapshot(): WebLogSnapshot {
    return {
      entries: structuredClone(entries),
      ...status(),
    };
  }

  /**
   * Дамп берёт свежий суффикс и проецирует каждую запись без её собственного дампа.
   * Ограничение по байтам относится и к метаданным, поэтому подбираем суффикс целиком.
   */
  function dump(n = WEB_LOG_LIMITS.dumpEntries): WebLogDump {
    const wanted = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
    const tail = entries.slice(-Math.min(wanted, WEB_LOG_LIMITS.dumpEntries));
    const flat = tail.map(({ dump: _nested, ...entry }) => structuredClone(entry));
    let omitted = Math.min(entries.length, wanted) - flat.length;
    const result: WebLogDump = {
      entries: flat,
      omitted,
      from: null,
      to: null,
    };

    while (true) {
      result.from = result.entries[0]?.t ?? null;
      result.to = result.entries.at(-1)?.t ?? null;
      result.omitted = omitted;

      if (utf8Bytes(result) <= WEB_LOG_LIMITS.dumpBytes) {
        break;
      }

      result.entries.shift();
      omitted += 1;
    }

    return result;
  }

  /**
   * Отдаём подписчикам независимую копию проверенной записи.
   * Сбой подписчика учитывается и не мешает другим получателям.
   */
  function notify(entry: WebLogEntry): void {
    for (const fn of subscribers) {
      try {
        fn(structuredClone(entry));
      } catch {
        noteLoss('invalid');
      }
    }
  }

  /**
   * Закрываем истёкшие окна подавления и пишем сводку без исходного текста.
   * Вызывается перед записью ошибки и периодически из runtime.
   */
  function sweep(): void {
    const now = options.monotonicNow();

    for (const [signature, state] of [...signatures]) {
      if (now - state.windowStart < SUPPRESS_WINDOW_MS) {
        continue;
      }

      signatures.delete(signature);

      if (state.suppressed > 0) {
        recordInternal('log.suppressed', {
          signature: state.family,
          count: state.suppressed,
          periodMs: SUPPRESS_WINDOW_MS,
        }, false);
      }
    }
  }

  /**
   * Первые пять повторов одной сигнатуры за минуту проходят, остальные только
   * считаются. Таблица ограничена: самая старая сигнатура уступает место новой.
   */
  function shouldSuppress(ev: WebLogEvent, data: WebLogData[WebLogEvent]): boolean {
    if (!SUPPRESSIBLE.has(ev)) {
      return false;
    }

    const signature = signatureOf(ev, data);
    let state = signatures.get(signature);

    if (!state) {
      if (signatures.size >= SIGNATURE_LIMIT) {
        signatures.delete(signatures.keys().next().value!);
      }

      state = {
        family: ev.split('.')[0]!,
        windowStart: options.monotonicNow(),
        seen: 0,
        suppressed: 0,
      };
      signatures.set(signature, state);
    }

    state.seen += 1;

    if (state.seen <= SUPPRESS_AFTER) {
      return false;
    }

    state.suppressed += 1;
    suppressedTotal += 1;

    return true;
  }

  function candidateOf(event: WebLogEvent, data: unknown, nextSeq: number): Record<string, unknown> {
    const context = options.context();

    return {
      v: 1,
      t: options.now().toISOString(),
      seq: nextSeq,
      page: options.pageId,
      tab: options.tabId,
      ver: options.version,
      boot: context.boot ?? null,
      route: context.route ?? 'other',
      vis: context.vis ?? 'visible',
      ev: event,
      lvl: WEB_LOG_EVENTS[event],
      data,
    };
  }

  /**
   * Пока уровень неизвестен, ранние записи ждут в памяти ограниченным буфером.
   * Переполнение — потеря записей, которые иначе ушли бы на сервер.
   */
  function defer(flat: WebLogEntry): void {
    const { dump: _dump, ...entry } = flat;

    deferred.push(entry);

    while (deferred.length > EARLY_LIMIT || utf8Bytes(deferred) > WEB_LOG_LIMITS.queueBytes) {
      deferred.shift();
      noteLoss('queueEvicted');
    }
  }

  /**
   * Отметка получает дамп всегда, ошибка — не чаще раза в минуту. Если дамп
   * не проходит проекцию даже после сокращения, запись сохраняется без него.
   */
  function withDump(
    event: WebLogEvent,
    candidate: Record<string, unknown>,
    flat: WebLogEntry,
  ): WebLogEntry {
    const errorDue = WEB_LOG_EVENTS[event] === 'error'
      && options.monotonicNow() - lastErrorDump >= SUPPRESS_WINDOW_MS;

    if (event !== 'mark' && !errorDue) {
      return flat;
    }

    const attached = dump();
    const full = {
      ...candidate,
      dump: attached,
    };
    let clean = projectWebLogEntry(full);

    while (!clean && attached.entries.length > 0) {
      attached.entries.shift();
      attached.omitted += 1;
      attached.from = attached.entries[0]?.t ?? null;
      attached.to = attached.entries.at(-1)?.t ?? null;
      clean = projectWebLogEntry(full);
    }

    if (!clean) {
      return flat;
    }
    if (errorDue) {
      lastErrorDump = options.monotonicNow();
    }

    return clean;
  }

  /**
   * Номер выдаётся только принятой записи; готовая копия кладётся в ограниченное
   * кольцо до уведомления транспорта, чтобы подписчик видел полный снимок.
   */
  function recordInternal(
    ev: WebLogEvent | string,
    data: unknown,
    allowDump = true,
    captured?: WebLogFlatEntry,
  ): WebLogKey | null {
    try {
      if (!Object.hasOwn(WEB_LOG_EVENTS, ev)) {
        noteLoss('invalid');

        return null;
      }

      const event = ev as WebLogEvent;

      if (currentLevel !== null && !allowsWebLogEvent(currentLevel, event)) {
        return null;
      }
      if (currentLevel === null && event === 'mark') {
        return null;
      }
      if (SUPPRESSIBLE.has(event) && currentLevel !== null) {
        sweep();
      }

      const candidate = captured
        ? { ...captured, seq: seq + 1 }
        : candidateOf(event, data, seq + 1);
      const flat = projectWebLogEntry(candidate);

      if (!flat) {
        noteLoss('invalid');

        return null;
      }
      if (currentLevel === null) {
        defer(flat);

        return null;
      }
      if (shouldSuppress(event, flat.data)) {
        return null;
      }

      const clean = allowDump ? withDump(event, candidate, flat) : flat;

      seq = clean.seq;
      entries.push(clean);
      bytes += utf8Bytes(clean);

      while (entries.length > WEB_LOG_LIMITS.ringEntries || bytes > WEB_LOG_LIMITS.ringBytes) {
        const evicted = entries.shift()!;

        bytes -= utf8Bytes(evicted);
        ringEvicted += 1;
      }

      notify(clean);

      return {
        page: clean.page,
        seq: clean.seq,
      };
    } catch {
      noteLoss('invalid');

      return null;
    }
  }

  function record<E extends WebLogEvent>(ev: E, data: WebLogData[E]): WebLogKey | null {
    return recordInternal(ev, data);
  }

  function mark(text: string): WebLogKey | null {
    return recordInternal('mark', { text });
  }

  function subscribe(fn: (entry: WebLogEntry) => void): () => void {
    subscribers.add(fn);

    return () => subscribers.delete(fn);
  }

  /**
   * Очищаем данные пользователя при logout, сохраняя номер документа.
   * Следующее событие получает новый, ранее не использованный ключ.
   */
  function clear(): void {
    entries.length = 0;
    deferred.length = 0;
    bytes = 0;
    signatures.clear();
  }

  return {
    record,
    mark,
    dump,
    subscribe,
    snapshot,
    status,
    noteLoss,
    sweep,
    clear,
    level: () => currentLevel,
    setLevel,
    subscribeLevel,
  };
}
