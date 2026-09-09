// Однопроцессный manager immutable account contexts для provider channels.
// Он не знает credentials/stores конкретного канала: только generation, leases и draining.

import { assertAccountRef, assertChannel } from './inbox/identity.ts';

export class AccountRuntimeError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message);
    this.name = 'AccountRuntimeError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (code, message, statusCode) => {
  throw new AccountRuntimeError(code, message, statusCode);
};

export class AccountRuntimeManager {
  constructor({ channel, onDrain = null } = {}) {
    this.channel = assertChannel(channel);
    if (onDrain !== null && typeof onDrain !== 'function') {
      fail('invalid_runtime_config', 'onDrain должен быть функцией.', 500);
    }
    this.onDrain = onDrain;
    this.current = null;
    this.nextGeneration = 1;
    this.lifecycle = Promise.resolve();
  }

  _queued(operation) {
    const result = this.lifecycle.then(operation, operation);
    this.lifecycle = result.catch(() => {});
    return result;
  }

  /** Без accountRef: это безопасная runtime-диагностика для public channel state. */
  status() {
    const record = this.current;
    if (!record) return { connection: 'disconnected', generation: null, leases: 0, reason: '' };
    return {
      connection: record.phase === 'active' ? 'connected' : 'disconnecting',
      generation: record.generation,
      leases: record.leases,
      reason: record.reason,
    };
  }

  /** Internal snapshot для lifecycle/provider module; наружу API его не отдаёт. */
  snapshot() {
    const record = this.current;
    return record ? {
      channel: this.channel,
      accountRef: record.accountRef,
      generation: record.generation,
      phase: record.phase,
      leases: record.leases,
      context: record.context,
    } : null;
  }

  isCurrent(accountRef, generation) {
    const record = this.current;
    return Boolean(record
      && record.phase === 'active'
      && record.accountRef === accountRef
      && record.generation === generation);
  }

  acquire() {
    const record = this.current;
    if (!record) fail('channel_disconnected', `Канал ${this.channel} не подключён.`, 409);
    if (record.phase !== 'active') fail('account_draining', `Канал ${this.channel} переключается.`, 409);
    record.leases += 1;
    let released = false;
    return Object.freeze({
      channel: this.channel,
      accountRef: record.accountRef,
      generation: record.generation,
      context: record.context,
      isCurrent: () => this.isCurrent(record.accountRef, record.generation),
      release: () => {
        if (released) return;
        released = true;
        record.leases -= 1;
        if (record.leases === 0) {
          for (const resolve of record.waiters.splice(0)) resolve();
        }
      },
    });
  }

  async withLease(operation) {
    if (typeof operation !== 'function') fail('invalid_runtime_operation', 'withLease требует функцию.', 500);
    const lease = this.acquire();
    try {
      return await operation(lease);
    } finally {
      lease.release();
    }
  }

  async _drainRecord(record, reason) {
    if (!record) return null;
    if (record.phase === 'active') {
      record.phase = 'draining';
      record.reason = String(reason || 'lifecycle');
      await this.onDrain?.({
        channel: this.channel,
        accountRef: record.accountRef,
        generation: record.generation,
        context: record.context,
        reason: record.reason,
      });
    }
    if (record.leases > 0) {
      await new Promise((resolve) => record.waiters.push(resolve));
    }
    if (this.current === record) this.current = null;
    return {
      channel: this.channel,
      accountRef: record.accountRef,
      generation: record.generation,
      context: record.context,
      reason: record.reason,
    };
  }

  /**
   * Публикует уже проверенный provider context. Старый сначала становится draining:
   * поздние результаты перестают быть current до ожидания их release.
   */
  install({ accountRef, context, reason = 'switch' } = {}) {
    const trustedAccountRef = assertAccountRef(accountRef);
    if (!context || typeof context !== 'object') {
      fail('invalid_runtime_context', 'Account runtime context должен быть объектом.', 500);
    }
    return this._queued(async () => {
      await this._drainRecord(this.current, reason);
      const record = {
        accountRef: trustedAccountRef,
        generation: this.nextGeneration,
        context: Object.freeze({ ...context }),
        phase: 'active',
        reason: '',
        leases: 0,
        waiters: [],
      };
      this.nextGeneration += 1;
      this.current = record;
      return this.snapshot();
    });
  }

  /** Local revoke: новые leases и publish запрещены до ожидания текущих операций. */
  drain({ reason = 'disconnect' } = {}) {
    return this._queued(() => this._drainRecord(this.current, reason));
  }
}
