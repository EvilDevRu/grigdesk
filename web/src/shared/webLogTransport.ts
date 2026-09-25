import { WEB_LOG_LIMITS, projectWebLogEntry, utf8Bytes } from '../../../shared/webLogContracts.ts';
import { diagnosticLevel, filterWebLogEntry } from '../../../shared/diagnosticLogging.ts';

import type { WebLogData, WebLogEntry, WebLogKey } from '../../../shared/webLogContracts.ts';
import type { WebLog, WebLogLoss } from './webLog.ts';

const STORAGE_KEY = 'cockpit-web-log-queue-v1';

export type TransportAuth = {
  ready: boolean;
  authenticated: boolean;
  epoch: number;
  confirmation: number;
};

export type Delivery = {
  key: WebLogKey;
  status: 'pending' | 'ack' | 'drop' | 'evicted';
};

export type WebLogTransportOptions = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  url: string;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  beacon: (url: string, body: Blob) => boolean;
  auth: () => TransportAuth;
  timers?: Pick<typeof globalThis, 'setInterval' | 'clearInterval' | 'setTimeout' | 'clearTimeout'>;
  now?: () => number;
  random?: () => number;
};

export type TransportSnapshot = {
  pending: WebLogEntry[];
  pendingBytes: number;
  storageAvailable: boolean;
  paused: boolean;
  retryAt: number;
  lastError: string | null;
};

export type TransportStatus = Omit<TransportSnapshot, 'pending' | 'pendingBytes'> & {
  pendingCount: number;
};

function keyOf(entry: WebLogKey): string {
  return `${entry.page}:${entry.seq}`;
}

function envelope(entries: WebLogEntry[]): { v: 1; entries: WebLogEntry[] } {
  return { v: 1, entries };
}

/**
 * Sender живёт отдельно от instrumented API: его 401 не разлогинивает
 * приложение, а его ошибки не превращаются в собственные api.fail.
 */
export function attachTransport(log: WebLog, options: WebLogTransportOptions) {
  const timers = options.timers ?? globalThis;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const deliveries = new Set<(event: Delivery) => void>();
  let pending: WebLogEntry[] = [];
  let storageAvailable = !!options.storage;
  let retryAt = 0;
  let retryCount = 0;
  let lastError: string | null = null;
  let pausedConfirmation: number | null = null;
  let knownEpoch = options.auth().epoch;
  let generation = 0;
  let disposed = false;
  let departed = false;
  let inFlight: Promise<void> | null = null;
  let controller: AbortController | null = null;
  let lastTransportEventAt = -Infinity;
  let lastLossReport = JSON.stringify(log.status().loss);

  /**
   * Публикуем исход доставки конкретного ключа отметки.
   * Ошибка наблюдателя не меняет очередь и ACK.
   */
  function emit(key: WebLogKey, status: Delivery['status']): void {
    for (const listener of deliveries) {
      try {
        listener({ key, status });
      } catch {
        /* наблюдатель не влияет на доставку */
      }
    }
  }

  /**
   * Сохраняем очередь с конвертом до любой попытки отправки.
   * Сбой sessionStorage учитываем без остановки журнала.
   */
  function persist(): void {
    try {
      options.storage?.setItem(STORAGE_KEY, JSON.stringify(envelope(pending)));
      storageAvailable = !!options.storage;
    } catch {
      storageAvailable = false;
      log.noteLoss('storageFailed');
    }
  }

  /**
   * Удаляем сохранённую очередь при смене auth-эпохи.
   * Недоступность storage фиксируем отдельным счётчиком.
   */
  function clearStorage(): void {
    try {
      options.storage?.removeItem(STORAGE_KEY);
    } catch {
      storageAvailable = false;
      log.noteLoss('storageFailed');
    }
  }

  /**
   * Восстановленный sessionStorage недоверен. Любая повреждённая часть
   * конверта отбрасывается целиком, пока она не попала в запрос.
   */
  function restore(): void {
    try {
      const text = options.storage?.getItem(STORAGE_KEY);

      if (!text) {
        return;
      }
      if (new TextEncoder().encode(text).byteLength > WEB_LOG_LIMITS.queueBytes) {
        throw new Error('oversized_storage');
      }

      const raw: unknown = JSON.parse(text);

      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('bad_storage');
      }

      const body = raw as { v?: unknown; entries?: unknown };

      if (
        body.v !== 1 ||
        !Array.isArray(body.entries) ||
        body.entries.length > WEB_LOG_LIMITS.queueEntries
      ) {
        throw new Error('bad_storage');
      }

      const cleaned: WebLogEntry[] = [];

      for (const item of body.entries) {
        const entry = projectWebLogEntry(item);

        if (!entry || entry.lvl === 'debug' || entry.ev === 'log.transport') {
          throw new Error('bad_storage');
        }

        cleaned.push(entry);
      }

      pending = cleaned;

      if (log.level() !== null) {
        reconcilePolicy(log.level());
      }
    } catch {
      pending = [];
      log.noteLoss('invalid');
      clearStorage();
    }
  }

  /**
   * Общая политика удаляет запрещённые корневые события и поля предыстории.
   * Смену уровня применяем и к сохранённой очереди, и к активному запросу.
   */
  function reconcilePolicy(level: ReturnType<WebLog['level']>): boolean {
    const before = JSON.stringify(pending);
    const removed: WebLogEntry[] = [];
    const next: WebLogEntry[] = [];

    for (const entry of pending) {
      const filtered = filterWebLogEntry(level, entry);

      if (filtered) {
        next.push(filtered);
      } else {
        removed.push(entry);
      }
    }

    pending = next;

    if (JSON.stringify(pending) !== before) {
      generation += 1;
      controller?.abort();
      persist();

      for (const entry of removed) {
        emit(entry, 'drop');
      }

      return true;
    }

    return false;
  }

  /**
   * Вытесняем старые записи, соблюдая оба ограничения очереди.
   * Текущую ручную отметку по возможности сохраняем.
   */
  function trimQueue(protectedKey: string): void {
    while (
      pending.length > WEB_LOG_LIMITS.queueEntries ||
      utf8Bytes(envelope(pending)) > WEB_LOG_LIMITS.queueBytes
    ) {
      let index = pending.findIndex(
        (entry) => keyOf(entry) !== protectedKey && entry.lvl === 'info',
      );

      if (index < 0) {
        index = pending.findIndex((entry) => keyOf(entry) !== protectedKey);
      }
      if (index < 0) {
        index = 0;
      }

      const [removed] = pending.splice(index, 1);

      if (!removed) {
        break;
      }

      log.noteLoss('queueEvicted');
      emit(removed, 'evicted');
    }
  }

  /**
   * Добавляем проверенную запись один раз по ключу page и seq.
   * После сохранения критичные события отправляются без ожидания интервала.
   */
  function enqueue(entry: WebLogEntry): void {
    if (
      entry.lvl === 'debug' ||
      entry.ev === 'log.transport' ||
      (entry.ev === 'auth.change' && (entry.data as WebLogData['auth.change']).reason === 'logout')
    ) {
      return;
    }

    const key = keyOf(entry);

    if (pending.some((existing) => keyOf(existing) === key)) {
      return;
    }

    pending.push(entry);
    trimQueue(key);
    persist();
    emit(entry, 'pending');

    if (
      entry.ev === 'mark' ||
      pending.length >= WEB_LOG_LIMITS.batchEntries ||
      utf8Bytes(envelope(pending)) >= WEB_LOG_LIMITS.batchBytes
    ) {
      queueMicrotask(() => {
        void flush();
      });
    }
  }

  /**
   * Собираем префикс очереди в пределах лимита POST.
   * Размер включает UTF-8 байты всего конверта.
   */
  function selectBatch(): WebLogEntry[] {
    const batch: WebLogEntry[] = [];

    for (const entry of pending) {
      if (batch.length >= WEB_LOG_LIMITS.batchEntries) {
        break;
      }
      if (utf8Bytes(envelope([...batch, entry])) > WEB_LOG_LIMITS.batchBytes) {
        break;
      }

      batch.push(entry);
    }

    return batch;
  }

  /**
   * Применяем ответ сервера к точным ключам отправленной пачки.
   * Записи, добавленные во время запроса, остаются pending.
   */
  function removeBatch(
    batch: WebLogEntry[],
    accepted: number,
    dropped: number,
    quota = false,
  ): void {
    const completed = new Set(batch.slice(0, accepted + dropped).map(keyOf));

    pending = pending.filter((entry) => !completed.has(keyOf(entry)));
    persist();

    for (const entry of batch.slice(0, accepted)) {
      emit(entry, 'ack');
    }
    for (const entry of batch.slice(accepted, accepted + dropped)) {
      emit(entry, 'drop');
    }

    if (dropped && quota) {
      log.noteLoss('quotaDropped', dropped);
    }
  }

  /**
   * Обновляем видимый статус транспорта и редкое диагностическое событие.
   * Событие самого журнала не возвращается в очередь.
   */
  function reportFailure(reason: string, status?: number): void {
    lastError = reason;

    if (now() - lastTransportEventAt >= 60_000) {
      lastTransportEventAt = now();
      log.record('log.transport', {
        pending: pending.length,
        reason,
        ...(status === undefined ? {} : { status }),
      });
    }
  }

  /**
   * Вычисляем backoff с небольшим разбросом из номера попытки и Retry-After.
   * Ожидание ограничено одной минутой.
   */
  function postpone(response?: Response): void {
    const seconds = Number(response?.headers.get('Retry-After'));
    const fromHeader = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
    const step = Math.min(60_000, 5000 * 2 ** Math.min(4, retryCount));

    retryCount += 1;

    const jittered = Math.round(step * (0.9 + random() * 0.2));

    retryAt = now() + Math.min(60_000, Math.max(jittered, fromHeader));
  }

  /**
   * На 401 ждём новый номер успешной проверки auth.load. Неизменившиеся
   * authenticated/ready сами по себе паузу не снимают.
   */
  function authChanged(): void {
    const state = options.auth();

    if (state.epoch !== knownEpoch) {
      knownEpoch = state.epoch;
      generation += 1;
      controller?.abort();
      pending = [];
      log.clear();
      clearStorage();
      retryAt = 0;
      retryCount = 0;
      pausedConfirmation = null;

      return;
    }
    if (
      state.ready &&
      state.authenticated &&
      pausedConfirmation !== null &&
      state.confirmation > pausedConfirmation
    ) {
      pausedConfirmation = null;
      retryAt = 0;
    }
  }

  /** Частые обновления UI читают счётчики без копирования очереди. */
  function status(): TransportStatus {
    return {
      pendingCount: pending.length,
      storageAvailable,
      paused: pausedConfirmation !== null,
      retryAt,
      lastError,
    };
  }

  function snapshot(): TransportSnapshot {
    return {
      pending: structuredClone(pending),
      pendingBytes: utf8Bytes(envelope(pending)),
      storageAvailable,
      paused: pausedConfirmation !== null,
      retryAt,
      lastError,
    };
  }

  /**
   * Пачка фиксируется по ID до запроса. ACK удаляет только эти ID, поэтому
   * новое событие во время ожидания ответа остаётся в очереди.
   */
  async function sendBatch(): Promise<void> {
    const batch = selectBatch();

    if (!batch.length) {
      return;
    }

    persist();

    const batchGeneration = generation;

    controller = new AbortController();

    let timeout: ReturnType<typeof setTimeout> | null = null;
    let response: Response | null = null;

    try {
      const request = options.fetch(options.url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(envelope(batch)),
        signal: controller.signal,
      });

      response = await Promise.race([
        request,
        new Promise<null>((resolve) => {
          timeout = timers.setTimeout(() => {
            controller?.abort();
            resolve(null);
          }, 10_000);
        }),
      ]);

      authChanged();

      if (batchGeneration !== generation || disposed) {
        return;
      }
      if (!response) {
        reportFailure('timeout');
        postpone();

        return;
      }
      if (response.status === 401) {
        pausedConfirmation = options.auth().confirmation;
        reportFailure('401', 401);

        return;
      }
      if (response.status === 409) {
        const body: unknown = await response.json().catch(() => null);

        authChanged();

        if (batchGeneration !== generation || disposed) {
          return;
        }

        const value = body && typeof body === 'object'
          ? diagnosticLevel((body as { level?: unknown }).level)
          : null;

        if (value !== null) {
          const changed = log.level() !== value;

          log.setLevel(value);

          const pruned = reconcilePolicy(value);

          if (changed || pruned) {
            retryAt = 0;
            retryCount = 0;
            lastError = null;

            return;
          }
        }

        reportFailure('policy', 409);
        postpone(response);

        return;
      }
      if (response.status === 404 || response.status === 405) {
        reportFailure('http', response.status);
        retryAt = now() + 60_000;

        return;
      }
      if (response.status === 400 || response.status === 413) {
        reportFailure('http', response.status);
        removeBatch(batch, 0, batch.length);
        log.noteLoss('invalid', batch.length);

        return;
      }
      if (!response.ok) {
        reportFailure('http', response.status);
        postpone(response);

        return;
      }

      const ack: unknown = await response.json();

      authChanged();

      if (batchGeneration !== generation || disposed) {
        return;
      }

      if (!ack || typeof ack !== 'object' || Array.isArray(ack)) {
        reportFailure('invalid-ack');
        postpone();

        return;
      }

      const result = ack as {
        accepted?: unknown;
        dropped?: unknown;
        reason?: unknown;
      };

      if (
        !Number.isSafeInteger(result.accepted) ||
        !Number.isSafeInteger(result.dropped) ||
        (result.accepted as number) < 0 ||
        (result.dropped as number) < 0 ||
        (result.accepted as number) + (result.dropped as number) !== batch.length ||
        (result.dropped ? result.reason !== 'daily_limit' : result.reason !== null)
      ) {
        reportFailure('invalid-ack');
        postpone();

        return;
      }

      retryCount = 0;
      retryAt = 0;
      lastError = null;

      const accepted = result.accepted as number;
      const dropped = result.dropped as number;

      removeBatch(batch, accepted, dropped, true);

      if (batch.slice(0, accepted).some((entry) => !entry.ev.startsWith('log.'))) {
        const current = log.status().loss;

        if (JSON.stringify(current) !== lastLossReport) {
          lastLossReport = JSON.stringify(current);
          log.record('log.loss', current as WebLogLoss);
        }
      }
    } catch {
      authChanged();

      if (batchGeneration === generation && !disposed) {
        reportFailure('offline');
        postpone(response ?? undefined);
      }
    } finally {
      if (timeout !== null) {
        timers.clearTimeout(timeout);
      }

      controller = null;
    }
  }

  /**
   * Проверяем авторизацию, паузу и наличие активного POST.
   * Одновременно исполняется не более одного обычного запроса.
   */
  function flush(): Promise<void> {
    if (disposed) {
      return Promise.resolve();
    }

    authChanged();

    const auth = options.auth();

    if (
      !auth.ready || !auth.authenticated ||
      log.level() === null || log.level() === 'off' ||
      pausedConfirmation !== null || retryAt > now()
    ) {
      return Promise.resolve();
    }
    if (inFlight) {
      return inFlight;
    }

    inFlight = sendBatch().finally(() => {
      inFlight = null;
    });

    return inFlight;
  }

  /**
   * Сохраняем очередь и один раз пробуем отправить Beacon.
   * Даже успешный вызов Beacon не удаляет pending до ACK.
   */
  function onHidden(): void {
    persist();

    if (departed || inFlight) {
      return;
    }

    departed = true;

    const auth = options.auth();

    if (!auth.ready || !auth.authenticated || log.level() === null || log.level() === 'off') {
      return;
    }

    const batch = selectBatch();

    if (!batch.length) {
      return;
    }

    try {
      options.beacon(
        options.url,
        new Blob([JSON.stringify(envelope(batch))], {
          type: 'application/json',
        }),
      );
    } catch {
      /* даже true не является ACK */
    }
  }

  function onVisible(): void {
    departed = false;
    void flush();
  }

  function subscribeDelivery(fn: (event: Delivery) => void): () => void {
    deliveries.add(fn);

    return () => deliveries.delete(fn);
  }

  restore();

  const unsubscribe = log.subscribe(enqueue);
  const stopLevel = log.subscribeLevel((level) => {
    generation += 1;
    controller?.abort();
    reconcilePolicy(level);
  });
  const interval = timers.setInterval(() => {
    void flush();
  }, 5000);

  /**
   * Прерываем запрос и удаляем таймеры и подписчиков транспорта.
   * Поздний ответ уже не изменит состояние очереди.
   */
  function dispose(): void {
    disposed = true;
    generation += 1;
    controller?.abort();
    timers.clearInterval(interval);
    unsubscribe();
    stopLevel();
    deliveries.clear();
  }

  return {
    flush,
    snapshot,
    status,
    subscribeDelivery,
    authChanged,
    onHidden,
    onVisible,
    dispose,
  };
}
