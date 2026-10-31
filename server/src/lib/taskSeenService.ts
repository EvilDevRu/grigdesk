import type { B24ReadOptions } from './b24/readOperations.ts';
// Предметный слой просмотренных задач: scope выводится из текущего B24-портала и
// пользователя, наружу уходит только opaque hash — клиент не может попросить чужой набор.
import { b24AccountScope } from './b24AccountScope.ts';
import type { B24Identity } from './b24AccountScope.ts';
import type { TaskSeenStore, SeenScope } from './taskSeenStore.ts';
import type { B24Adapter } from '../adapters/b24.ts';

export class TaskSeenIdentityError extends Error {
  readonly code = 'B24_IDENTITY_UNAVAILABLE';

  constructor(message = 'Не удалось определить B24-пользователя', cause: unknown = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'TaskSeenIdentityError';
  }
}

export function seenScopeFor(identity: B24Identity | null | undefined): string {
  try {
    return b24AccountScope(identity);
  } catch (error) {
    throw new TaskSeenIdentityError(undefined, error);
  }
}

export class TaskSeenService {
  readonly store: TaskSeenStore;

  // Адаптер портала: из него берётся текущая учётная запись, а не из запроса браузера.
  readonly b24: Pick<B24Adapter, 'accountIdentity'>;

  constructor({ store, b24 }: { store: TaskSeenStore; b24: Pick<B24Adapter, 'accountIdentity'> }) {
    this.store = store;
    this.b24 = b24;
  }

  /**
   * Scope берётся только из подтверждённой серверной identity.
   * Signal отменяет чтение; локальные мутации сохраняют прежнюю доставку.
   */
  private async _scope(options: B24ReadOptions = {}): Promise<string> {
    let identity: Awaited<ReturnType<B24Adapter['accountIdentity']>>;

    try {
      identity = await this.b24.accountIdentity(options);
    } catch (error) {
      throw new TaskSeenIdentityError(undefined, error);
    }
    return seenScopeFor(identity);
  }

  /**
   * Чтение отметок передаёт срок жизни HTTP до общего определения identity.
   * Серверный scope по-прежнему не может быть выбран полем запроса.
   */
  async list(options: B24ReadOptions = {}): Promise<SeenScope & { scope: string }> {
    const scope = await this._scope(options);

    return { scope, ...await this.store.list(scope) };
  }

  async markSeen(
    taskIds: unknown,
    options: { baseline?: boolean } = {},
  ): Promise<SeenScope & { scope: string }> {
    const scope = await this._scope();
    return { scope, ...await this.store.markSeen(scope, taskIds, options) };
  }
}
