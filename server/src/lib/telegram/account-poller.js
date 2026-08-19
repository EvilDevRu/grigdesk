// Long-poll Telegram поверх immutable account lease.
//
// Объект не знает путей и не кэширует глобальный offset. Каждый tick
// захватывает ровно один account context; network
// result старой generation не может попасть в stores новой. Disconnect сначала
// вызывает stop(), ждёт tick, и только затем drain-ит runtime/закрывает activation.
import * as defaultApi from './api.js';
import { scrubToken } from './api.js';
import { normalizeTelegramBotId } from './account-bindings.js';
import { normalizeUpdate } from './updates.js';

// callback_query — кнопки телеграм-пульта; читатель getUpdates ровно один,
// поэтому нажатия принимает этот же цикл, а не второй.
const ALLOWED_UPDATES = ['message', 'edited_message', 'message_reaction', 'callback_query'];
const IDLE_PAUSE_MS = 1_000;
const ERROR_PAUSE_MS = 15_000;

function safeOffset(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function validLease(value) {
  return value && typeof value === 'object'
    && typeof value.isCurrent === 'function'
    && typeof value.release === 'function'
    && value.context && typeof value.context === 'object';
}

export class TelegramAccountPoller {
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
    this.acquireLease = acquireLease;
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

  _current(lease) {
    return Boolean(lease.isCurrent());
  }

  _context(lease) {
    if (!validLease(lease)) throw new Error('telegram account lease имеет неверный contract');
    const context = lease.context;
    if (!context.archive || typeof context.archive.append !== 'function'
        || !context.pollState || typeof context.pollState.read !== 'function'
        || typeof context.pollState.write !== 'function') {
      throw new Error('telegram account context не выдал archive/pollState');
    }
    const credentials = context.credentials;
    if (!credentials || typeof credentials.token !== 'string') return null;
    const ownerBotId = normalizeTelegramBotId(context.botId, 'context.botId');
    const credentialBotId = normalizeTelegramBotId(credentials.botId, 'credentials.botId');
    if (ownerBotId !== credentialBotId) {
      throw new Error('telegram credentials принадлежат другому account context');
    }
    return { context, credentials };
  }

  _failure(error, token) {
    const why = scrubToken(error?.message || 'unknown', token);
    if (error?.status === 409) {
      this.conflict = true;
      this.lastError = {
        code: 'poll_conflict',
        message: 'Апдейты этого бота уже читает другой экземпляр — Telegram отдаёт их только одному.',
      };
    } else if (error?.kind === 'transport') {
      this.lastError = { code: 'poll_unreachable', message: `Telegram не отвечает: ${why}` };
    } else {
      this.lastError = { code: 'poll_rejected', message: `Telegram отказал: ${why}` };
    }
    this.log.warn?.({ code: this.lastError.code }, `telegram: ${this.lastError.message}`);
    return { ...this.lastError };
  }

  async _handle(raw, lease, context) {
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
    if (!this._current(lease) || !await this._enabled()) return false;
    this.lastMessageAt = Number(update.msg.date || 0) * 1_000 || null;
    await this.onMessage?.(update.msg, update.type, lease);
    return this._current(lease) && await this._enabled();
  }

  async _tick() {
    if (!await this._enabled()) return { polled: false, reason: 'plugin_disabled' };
    let lease;
    try {
      lease = this.acquireLease();
    } catch (error) {
      if (['channel_disconnected', 'account_draining'].includes(error?.code)) {
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

      let updates;
      try {
        updates = await this.botApi.callBotApi(credentials.token, 'getUpdates', {
          offset,
          limit: 100,
          timeout: this.timeoutSec,
          allowed_updates: ALLOWED_UPDATES,
        }, { timeoutMs: (this.timeoutSec + 10) * 1_000 });
      } catch (error) {
        return { polled: true, error: this._failure(error, credentials.token) };
      }
      if (!this._current(lease) || !await this._enabled()) {
        return { polled: true, discarded: true, reason: 'account_changed' };
      }

      this.lastPollAt = this.now();
      this.lastError = null;
      this.conflict = false;
      let nextOffset = offset;
      let done = 0;
      for (const raw of Array.isArray(updates) ? updates : []) {
        try {
          if (!await this._handle(raw, lease, context)) {
            return { polled: true, updates: done, discarded: true, reason: 'account_changed' };
          }
        } catch (error) {
          this.lastError = {
            code: 'poll_handle_failed',
            message: `Не удалось принять Telegram update: ${error?.message || 'unknown'}`,
          };
          this.log.error?.({ code: error?.code }, 'telegram: приём update сорвался');
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
          this.log.warn?.({ code: error?.code }, 'telegram: archive записан, но SSE не отправлен');
        }
      }
      return { polled: true, updates: done };
    } finally {
      await lease?.release?.();
    }
  }

  /** Все tick-и сериализованы: один bot token никогда не получает двух getUpdates. */
  tick() {
    this.pending += 1;
    const operation = async () => {
      try { return await this._tick(); } finally {
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

  start() {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      let pause = IDLE_PAUSE_MS;
      try {
        const result = await this.tick();
        if (result.error || result.polled === false) pause = ERROR_PAUSE_MS;
      } catch (error) {
        this.log.error?.({ code: error?.code }, 'telegram: account-aware poll упал');
        pause = ERROR_PAUSE_MS;
      }
      if (!this.running) return;
      this.timer = setTimeout(loop, pause);
      this.timer.unref?.();
    };
    void loop();
  }

  /** Запрещает следующий loop и ждёт уже начатые/поставленные tick-и. */
  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending > 0) {
      await new Promise((resolve) => this.drainWaiters.push(resolve));
    }
  }
}
