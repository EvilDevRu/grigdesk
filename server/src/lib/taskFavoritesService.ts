import type { B24ReadOptions } from './b24/readOperations.ts';
// Предметный слой избранного: браузер не передаёт account scope, он выводится
// из текущего B24-портала и пользователя и возвращается только как opaque hash.
import { b24AccountScope } from './b24AccountScope.ts';
import type { B24Identity } from './b24AccountScope.ts';
import type { TaskFavoritesStore, FavoritesScope } from './taskFavoritesStore.ts';
import type { B24Adapter } from '../adapters/b24.ts';

export class TaskFavoritesIdentityError extends Error {
  readonly code = 'B24_IDENTITY_UNAVAILABLE';

  constructor(message = 'Не удалось определить B24-пользователя', cause: unknown = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'TaskFavoritesIdentityError';
  }
}

export function favoriteScopeFor(identity: B24Identity | null | undefined): string {
  try {
    return b24AccountScope(identity);
  } catch (error) {
    throw new TaskFavoritesIdentityError(undefined, error);
  }
}

export class TaskFavoritesService {
  readonly store: TaskFavoritesStore;

  // Адаптер портала: из него берётся текущая учётная запись, а не из запроса браузера.
  readonly b24: Pick<B24Adapter, 'accountIdentity'>;

  constructor({ store, b24 }: { store: TaskFavoritesStore; b24: Pick<B24Adapter, 'accountIdentity'> }) {
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
      throw new TaskFavoritesIdentityError(undefined, error);
    }
    return favoriteScopeFor(identity);
  }

  /**
   * GET может снять своего подписчика холодного определения scope.
   * Локальные мутации используют прежний вызов _scope без HTTP-отмены.
   */
  async list(options: B24ReadOptions = {}): Promise<FavoritesScope & { scope: string }> {
    const scope = await this._scope(options);

    return { scope, ...await this.store.list(scope) };
  }

  async add(taskId: unknown): Promise<FavoritesScope & { scope: string }> {
    const scope = await this._scope();
    return { scope, ...await this.store.add(scope, taskId) };
  }

  async remove(taskId: unknown): Promise<FavoritesScope & { scope: string }> {
    const scope = await this._scope();
    return { scope, ...await this.store.remove(scope, taskId) };
  }
}
