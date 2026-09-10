// Однопроцессный manager immutable account contexts для provider channels.
// Он не знает credentials/stores конкретного канала: только generation, leases и draining.

import { assertAccountRef, assertChannel } from './inbox/identity.ts';

export class AccountRuntimeError extends Error {
  readonly code: string;

  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 409) {
    super(message);
    this.name = 'AccountRuntimeError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Отказ канала. Объявлен функцией, а не стрелкой в const: только у объявления
 * компилятор считает `never` признаком «дальше кода нет» и сужает по нему тип.
 */
function fail(code: string, message: string, statusCode?: number): never {
  throw new AccountRuntimeError(code, message, statusCode);
}

// Контекст канала собирает сам канал: runtime знает о нём только то, что он объект
// и что его нельзя менять после публикации.
export type AccountContext = Readonly<Record<string, unknown>>;

// Запись поколения. `waiters` ждут освобождения последней аренды: пока она держится,
// переключение аккаунта не завершено, и поздний ответ ещё считается текущим.
interface AccountRecord {
  accountRef: string;
  generation: number;
  context: AccountContext;
  phase: 'active' | 'draining';
  reason: string;
  leases: number;
  waiters: (() => void)[];
}

// Безопасная диагностика канала: без accountRef, потому что её отдают наружу.
export interface AccountRuntimeStatus {
  connection: 'connected' | 'disconnecting' | 'disconnected';
  generation: number | null;
  leases: number;
  reason: string;
}

// Внутренний снимок для lifecycle и модуля канала. Наружу API его не отдаёт.
export interface AccountRuntimeSnapshot {
  channel: string;
  accountRef: string;
  generation: number;
  phase: 'active' | 'draining';
  leases: number;
  context: AccountContext;
}

// Итог слива поколения: тем же набором о нём узнаёт и `onDrain`.
export interface AccountDrainResult {
  channel: string;
  accountRef: string;
  generation: number;
  context: AccountContext;
  reason: string;
}

// Аренда текущего поколения. `isCurrent()` спрашивают ПОСЛЕ долгой операции: за это
// время аккаунт мог смениться, и результат уже не принадлежит этому каналу.
export interface AccountLease {
  channel: string;
  accountRef: string;
  generation: number;
  context: AccountContext;
  isCurrent: () => boolean;
  release: () => void;
}

export interface AccountRuntimeOptions {
  channel: string;
  onDrain?: ((result: AccountDrainResult) => void | Promise<void>) | null;
}

export class AccountRuntimeManager {
  readonly channel: string;

  private readonly onDrain: AccountRuntimeOptions['onDrain'];

  private current: AccountRecord | null;

  private nextGeneration: number;

  private lifecycle: Promise<unknown>;

  constructor({ channel, onDrain = null }: AccountRuntimeOptions) {
    this.channel = assertChannel(channel);
    if (onDrain !== null && typeof onDrain !== 'function') {
      fail('invalid_runtime_config', 'onDrain должен быть функцией.', 500);
    }
    this.onDrain = onDrain;
    this.current = null;
    this.nextGeneration = 1;
    this.lifecycle = Promise.resolve();
  }

  /**
   * Очередь жизненного цикла: установка и слив не имеют права идти одновременно.
   * Отказ предыдущей операции очередь не останавливает — иначе один сбой канала
   * навсегда запретил бы переподключение.
   */
  private _queued<Value>(operation: () => Promise<Value>): Promise<Value> {
    const result = this.lifecycle.then(operation, operation);
    this.lifecycle = result.catch(() => {});
    return result;
  }

  /** Без accountRef: это безопасная runtime-диагностика для public channel state. */
  status(): AccountRuntimeStatus {
    const record = this.current;

    if (!record) {
      return {
        connection: 'disconnected',
        generation: null,
        leases: 0,
        reason: '',
      };
    }

    return {
      connection: record.phase === 'active' ? 'connected' : 'disconnecting',
      generation: record.generation,
      leases: record.leases,
      reason: record.reason,
    };
  }

  /** Internal snapshot для lifecycle/provider module; наружу API его не отдаёт. */
  snapshot(): AccountRuntimeSnapshot | null {
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

  isCurrent(accountRef: string, generation: number): boolean {
    const record = this.current;
    return Boolean(record
      && record.phase === 'active'
      && record.accountRef === accountRef
      && record.generation === generation);
  }

  acquire(): AccountLease {
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

  async withLease<Value>(operation: (lease: AccountLease) => Promise<Value>): Promise<Value> {
    if (typeof operation !== 'function') fail('invalid_runtime_operation', 'withLease требует функцию.', 500);
    const lease = this.acquire();
    try {
      return await operation(lease);
    } finally {
      lease.release();
    }
  }

  private async _drainRecord(
    record: AccountRecord | null,
    reason: string,
  ): Promise<AccountDrainResult | null> {
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
      await new Promise<void>((resolve) => record.waiters.push(resolve));
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
  install({ accountRef, context, reason = 'switch' }: {
    accountRef: unknown;
    context: unknown;
    reason?: string;
  }): Promise<AccountRuntimeSnapshot | null> {
    const trustedAccountRef = assertAccountRef(accountRef) as string;
    if (!context || typeof context !== 'object') {
      fail('invalid_runtime_context', 'Account runtime context должен быть объектом.', 500);
    }
    return this._queued(async () => {
      await this._drainRecord(this.current, reason);
      const record: AccountRecord = {
        accountRef: trustedAccountRef,
        generation: this.nextGeneration,
        context: Object.freeze({ ...(context as Record<string, unknown>) }),
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
  drain({ reason = 'disconnect' }: { reason?: string } = {}): Promise<AccountDrainResult | null> {
    return this._queued(() => this._drainRecord(this.current, reason));
  }
}
