// Long-poll Telegram поверх immutable account lease.
//
// Объект не знает путей и не кэширует глобальный offset. Каждый tick
// захватывает ровно один account context; network
// result старой generation не может попасть в stores новой. Disconnect сначала
// вызывает stop(), ждёт tick, и только затем drain-ит runtime/закрывает activation.
import * as defaultApi from './api.ts';
import { scrubToken } from './api.ts';
import { normalizeTelegramBotId } from './accountBindings.ts';
import { normalizeUpdate } from './updates.ts';

// callback_query — кнопки телеграм-пульта; читатель getUpdates ровно один,
// поэтому нажатия принимает этот же цикл, а не второй.
type Payload = Record<string, unknown>;

// Аренда одного аккаунта: пока она жива, поколение не меняется, и результат
// сети старого поколения не попадёт в хранилища нового.
export interface PollerLease {
  context: Payload;
  generation?: unknown;
  isCurrent: () => boolean;
  release?: () => unknown;
}

interface PollerContext extends Payload {
  archive: { append: (msg: unknown) => Promise<unknown>; flush?: () => Promise<unknown> };
  pollState: {
    read: () => Promise<{ offset?: number } | null>;
    write: (value: Payload) => Promise<unknown>;
  };
}

interface TickResult {
  polled: boolean;
  reason?: string;
  updates?: number;
  discarded?: boolean;
  error?: { code: string; message: string };
}

type LogPort = {
  warn?: (details: unknown, message: string) => void;
  error?: (details: unknown, message: string) => void;
};

const errorCode = (err: unknown) => (err as { code?: unknown } | null)?.code;
const errorText = (err: unknown) => (err instanceof Error ? err.message : 'unknown');

const ALLOWED_UPDATES = ['message', 'edited_message', 'message_reaction', 'callback_query'];
const IDLE_PAUSE_MS = 1_000;
const ERROR_PAUSE_MS = 15_000;

function safeOffset(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? value as number : 0;
}

function validLease(value: unknown): boolean {
  const lease = value as PollerLease | null;

  return Boolean(lease && typeof lease === 'object'
    && typeof lease.isCurrent === 'function'
    && typeof lease.release === 'function'
    && lease.context && typeof lease.context === 'object');
}

export class TelegramAccountPoller {
  acquireLease: () => PollerLease;

  botApi: typeof defaultApi;

  isEnabled: () => Promise<unknown> | unknown;

  onMessage: ((msg: Payload, type: string, lease: PollerLease) => unknown) | null;

  onReaction: ((reaction: unknown, lease: PollerLease) => unknown) | null;

  onCallback: ((callback: unknown, lease: PollerLease) => unknown) | null;

  onChanged: ((payload: Payload) => unknown) | null;

  now: () => number;

  log: LogPort;

  timeoutSec: number;

  running: boolean;

  controller: AbortController;

  timer: ReturnType<typeof setTimeout> | null;

  queue: Promise<unknown>;

  pending: number;

  drainWaiters: (() => void)[];

  generation: unknown;

  offset: number;

  lastPollAt: number | null;

  lastMessageAt: number | null;

  lastError: { code: string; message: string } | null;

  conflict: boolean;

  constructor({
    acquireLease,
    botApi = defaultApi,
    isEnabled = () => true,
    onMessage = null,
    onReaction = null,
    onCallback = null,
    onChanged = null,
    now = Date.now,
    log = console,
    timeoutSec = 25,
  }: {
    acquireLease?: () => PollerLease;
    botApi?: typeof defaultApi;
    isEnabled?: () => Promise<unknown> | unknown;
    onMessage?: ((msg: Payload, type: string, lease: PollerLease) => unknown) | null;
    onReaction?: ((reaction: unknown, lease: PollerLease) => unknown) | null;
    onCallback?: ((callback: unknown, lease: PollerLease) => unknown) | null;
    onChanged?: ((payload: Payload) => unknown) | null;
    now?: () => number;
    log?: LogPort;
    timeoutSec?: number;
  } = {}) {
    if (typeof acquireLease !== 'function' || typeof isEnabled !== 'function'
        || typeof now !== 'function') {
      throw new TypeError('TelegramAccountPoller: acquireLease/isEnabled/now обязательны.');
    }
    if (!botApi || typeof botApi.callBotApi !== 'function') {
      throw new TypeError('TelegramAccountPoller: botApi.callBotApi обязателен.');
    }
    if (![onMessage, onReaction, onCallback, onChanged].every((callback) => (
      callback === null || typeof callback === 'function'
    ))) {
      throw new TypeError('TelegramAccountPoller: callbacks должны быть функциями или null.');
    }
    if (!Number.isSafeInteger(timeoutSec) || timeoutSec < 0 || timeoutSec > 60) {
      throw new TypeError('TelegramAccountPoller: timeoutSec должен быть целым 0..60.');
    }
    this.acquireLease = acquireLease as () => PollerLease;
    this.botApi = botApi;
    this.isEnabled = isEnabled;
    this.onMessage = onMessage;
    this.onReaction = onReaction;
    this.onCallback = onCallback;
    this.onChanged = onChanged;
    this.now = now;
    this.log = log;
    this.timeoutSec = timeoutSec;

    this.running = false;
    this.controller = new AbortController();
    this.timer = null;
    this.queue = Promise.resolve();
    this.pending = 0;
    this.drainWaiters = [];
    this.generation = null;
    this.offset = 0;
    this.lastPollAt = null;
    this.lastMessageAt = null;
    this.lastError = null;
    this.conflict = false;
  }

  status() {
    return {
      running: this.running,
      offset: this.offset,
      lastPollAt: this.lastPollAt,
      lastMessageAt: this.lastMessageAt,
      lastError: this.lastError ? { ...this.lastError } : null,
      conflict: this.conflict,
    };
  }

  async _enabled() {
    return Boolean(await this.isEnabled());
  }

  _current(lease: PollerLease): boolean {
    return Boolean(lease.isCurrent());
  }

  _context(lease: PollerLease) {
    if (!validLease(lease)) throw new Error('telegram account lease имеет неверный contract');
    const context = lease.context as PollerContext;

    if (!context.archive || typeof context.archive.append !== 'function'
        || !context.pollState || typeof context.pollState.read !== 'function'
        || typeof context.pollState.write !== 'function') {
      throw new Error('telegram account context не выдал archive/pollState');
    }
    const credentials = context.credentials as { token?: unknown; botId?: unknown } | null;

    if (!credentials || typeof credentials.token !== 'string') return null;
    const ownerBotId = normalizeTelegramBotId(context.botId, 'context.botId');
    const credentialBotId = normalizeTelegramBotId(credentials.botId, 'credentials.botId');
    if (ownerBotId !== credentialBotId) {
      throw new Error('telegram credentials принадлежат другому account context');
    }

    return { context, credentials: credentials as { token: string; botId: unknown } };
  }

  _failure(error: unknown, token: string) {
    const failure = error as { message?: unknown; status?: unknown; kind?: unknown } | null;
    const why = scrubToken(failure?.message || 'unknown', token);

    if (failure?.status === 409) {
      this.conflict = true;
      this.lastError = {
        code: 'poll_conflict',
        message: 'Апдейты этого бота уже читает другой экземпляр — Telegram отдаёт их только одному.',
      };
    } else if (failure?.kind === 'transport') {
      this.lastError = { code: 'poll_unreachable', message: `Telegram не отвечает: ${why}` };
    } else {
      this.lastError = { code: 'poll_rejected', message: `Telegram отказал: ${why}` };
    }
    this.log.warn?.({ code: this.lastError.code }, `telegram: ${this.lastError.message}`);
    return { ...this.lastError };
  }

  /**
   * Проверяет отмену до приёма очередного update и до пользовательского callback.
   * Уже завершённый callback учитывается в offset, даже если stop пришёл во время него.
   */
  async _handle(
    raw: unknown,
    lease: PollerLease,
    context: PollerContext,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted) {
      return false;
    }

    if (!this._current(lease) || !await this._enabled()) return false;
    const update = normalizeUpdate(raw);
    if (update.type === 'reaction') {
      await this.onReaction?.(update.reaction, lease);
      return this._current(lease) && await this._enabled();
    }
    // Нажатие кнопки — не переписка: в архив не пишется, только хук пульта.
    if (update.type === 'callback') {
      await this.onCallback?.(update.callback, lease);
      return this._current(lease) && await this._enabled();
    }
    if (!update.msg) return true;
    // AccountRuntime помечает generation draining до ожидания lease. Если switch
    // начался после этой проверки, append всё ещё завершается в захваченном СТАРОМ
    // context; новый context он физически получить не может.
    if (!this._current(lease) || !await this._enabled()) return false;
    await context.archive.append(update.msg);

    if (signal.aborted) {
      return false;
    }

    if (!this._current(lease) || !await this._enabled()) return false;
    this.lastMessageAt = Number(update.msg.date || 0) * 1_000 || null;
    await this.onMessage?.(update.msg as unknown as Payload, update.type, lease);
    return this._current(lease) && await this._enabled();
  }

  /**
   * Один immutable lease охватывает long poll и запись принятого префикса updates.
   * Отмена прекращает сеть и следующий update, сохраняя уже подтверждённую обработку.
   */
  async _tick(signal: AbortSignal): Promise<TickResult> {
    if (signal.aborted) {
      return { polled: false, reason: 'stopped' };
    }

    if (!await this._enabled()) return { polled: false, reason: 'plugin_disabled' };

    if (signal.aborted) {
      return { polled: false, reason: 'stopped' };
    }


    let lease: PollerLease;

    try {
      lease = this.acquireLease();
    } catch (error) {
      if (['channel_disconnected', 'account_draining']
        .includes(String((error as { code?: unknown } | null)?.code))) {
        return { polled: false, reason: 'not_connected' };
      }
      throw error;
    }
    try {
      const owned = this._context(lease);
      if (!owned) return { polled: false, reason: 'not_configured' };
      const { context, credentials } = owned;
      if (!this._current(lease) || !await this._enabled()) {
        return { polled: false, reason: 'account_changed' };
      }
      const saved = await context.pollState.read();
      if (!this._current(lease) || !await this._enabled()) {
        return { polled: false, reason: 'account_changed' };
      }
      const offset = safeOffset(saved?.offset);
      if (this.generation !== lease.generation) {
        this.generation = lease.generation;
        this.offset = offset;
        this.lastPollAt = null;
        this.lastMessageAt = null;
        this.lastError = null;
        this.conflict = false;
      }

      if (signal.aborted) {
        return { polled: false, reason: 'stopped' };
      }

      let updates: unknown;

      try {
        updates = await this.botApi.callBotApi(credentials.token, 'getUpdates', {
          offset,
          limit: 100,
          timeout: this.timeoutSec,
          allowed_updates: ALLOWED_UPDATES,
        }, { timeoutMs: (this.timeoutSec + 10) * 1_000, signal });
      } catch (error) {
        if (signal.aborted) {
        return { polled: false, reason: 'stopped' };
      }

        return { polled: true, error: this._failure(error, credentials.token) };
      }
      if (!this._current(lease) || !await this._enabled()) {
        return { polled: true, discarded: true, reason: 'account_changed' };
      }

      if (signal.aborted) {
        return {
          polled: true,
          discarded: true,
          reason: 'stopped',
        };
      }

      this.lastPollAt = this.now();
      this.lastError = null;
      this.conflict = false;
      let nextOffset = offset;
      let done = 0;

      for (const raw of (Array.isArray(updates) ? updates : []) as Payload[]) {
        if (signal.aborted) {
          break;
        }

        try {
          if (!await this._handle(raw, lease, context, signal)) {
            if (signal.aborted) {
          break;
        }

            return { polled: true, updates: done, discarded: true, reason: 'account_changed' };
          }
        } catch (error) {
          this.lastError = {
            code: 'poll_handle_failed',
            message: `Не удалось принять Telegram update: ${errorText(error)}`,
          };
          this.log.error?.({ code: errorCode(error) }, 'telegram: приём update сорвался');
          break;
        }
        const updateId = Number(raw?.update_id);
        if (Number.isSafeInteger(updateId) && updateId >= 0) {
          nextOffset = Math.max(nextOffset, updateId + 1);
        }
        done += 1;
      }
      if (done > 0) {
        if (!this._current(lease) || !await this._enabled()) {
          return { polled: true, updates: done, discarded: true, reason: 'account_changed' };
        }
        await context.pollState.write({ offset: nextOffset, updatedAtMs: this.now() });
        await context.archive.flush?.();
        if (!this._current(lease) || !await this._enabled()) {
          return { polled: true, updates: done, discarded: true, reason: 'account_changed' };
        }
        this.offset = nextOffset;
        try {
          await this.onChanged?.({ itemRef: null, channel: 'telegram', status: 'new', taskId: null });
        } catch (error) {
          this.log.warn?.({ code: errorCode(error) }, 'telegram: archive записан, но SSE не отправлен');
        }
      }
      return { polled: true, updates: done };
    } finally {
      await lease?.release?.();
    }
  }

  /**
   * Сериализация исключает параллельный getUpdates с одним token.
   * Сигнал захватывается при постановке: stop/start не оживляет старые queued ticks.
   */
  tick(): Promise<TickResult> {
    const signal = this.controller.signal;

    this.pending += 1;

    // Завершение tick будит stop только после release его account lease.
    // Отмена queued tick также проходит finally и снимает pending ровно один раз.
    const operation = async () => {
      try {
        return await this._tick(signal);
      } finally {
        this.pending -= 1;
        if (this.pending === 0) {
          for (const resolve of this.drainWaiters.splice(0)) resolve();
        }
      }
    };
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }

  /**
   * Новый запуск получает новый сигнал, прежние операции сохраняют свою отмену.
   * Следующий timer ставится только после завершения текущего tick.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    if (this.controller.signal.aborted) {
      this.controller = new AbortController();
    }

    const loop = async () => {
      if (!this.running) return;
      let pause = IDLE_PAUSE_MS;
      try {
        const result = await this.tick();
        if (result.error || result.polled === false) pause = ERROR_PAUSE_MS;
      } catch (error) {
        this.log.error?.({ code: errorCode(error) }, 'telegram: account-aware poll упал');
        pause = ERROR_PAUSE_MS;
      }
      if (!this.running) return;
      this.timer = setTimeout(loop, pause);
      (this.timer as { unref?: () => void }).unref?.();
    };
    void loop();
  }

  /**
   * Запрещает следующие tick-и и отменяет текущий getUpdates с ожиданием его close.
   * Уже обработанный префикс updates сохраняет offset; оставшиеся примет новый запуск.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.controller.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending > 0) {
      await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
    }
  }
}
