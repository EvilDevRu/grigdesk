import type { B24ReadOptions } from './b24/readOperations.ts';
// Предметный слой полки: scope всегда выводится из текущей портальной сессии,
// а клиент получает только непрозрачный хеш и полный server-confirmed снимок.
import { b24AccountScope } from './b24AccountScope.ts';
import type { B24Identity } from './b24AccountScope.ts';
import type { ShelfSnapshot, TaskShelfStore } from './taskShelfStore.ts';
import type { ShelfState } from '../../../shared/b24/shelfContracts.ts';

export interface TaskShelfIdentitySource {
  accountIdentity(options?: B24ReadOptions): Promise<unknown>;
}

export interface TaskShelfResult extends ShelfState {
  // Тот же служебный флаг, что и у хранилища: он не перечисляется и в ответ не попадает.
  readonly changed?: boolean;
}

export class TaskShelfIdentityError extends Error {
  code: string;

  constructor(message = 'Не удалось определить B24-пользователя', cause: unknown = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'TaskShelfIdentityError';
    this.code = 'B24_IDENTITY_UNAVAILABLE';
  }
}

function withScope(scope: string, snapshot: ShelfSnapshot): TaskShelfResult {
  const result: TaskShelfResult = {
    scope,
    revision: snapshot.revision,
    entries: snapshot.entries,
  };
  Object.defineProperty(result, 'changed', {
    value: snapshot.changed === true,
    enumerable: false,
  });
  return result;
}

export class TaskShelfService {
  store: TaskShelfStore;

  b24: TaskShelfIdentitySource;

  constructor({ store, b24 }: { store: TaskShelfStore; b24: TaskShelfIdentitySource }) {
    this.store = store;
    this.b24 = b24;
  }

  /**
   * Scope берётся только из подтверждённой серверной identity.
   * Signal отменяет чтение; локальные мутации сохраняют прежнюю доставку.
   */
  async _scope(options: B24ReadOptions = {}): Promise<string> {
    try {
      const identity = await this.b24.accountIdentity(options);

      return b24AccountScope(identity as B24Identity | null);
    } catch (error) {
      throw new TaskShelfIdentityError(undefined, error);
    }
  }

  /**
   * Чтение полки снимает только своего подписчика при закрытии HTTP-ответа.
   * Состав снимка и не перечисляемый changed сохраняются общим withScope.
   */
  async list(options: B24ReadOptions = {}): Promise<TaskShelfResult> {
    const scope = await this._scope(options);

    return withScope(scope, await this.store.list(scope));
  }

  async put(taskId: unknown, value: unknown): Promise<TaskShelfResult> {
    const scope = await this._scope();
    return withScope(scope, await this.store.put(scope, taskId, value));
  }

  async remove(taskId: unknown): Promise<TaskShelfResult> {
    const scope = await this._scope();
    return withScope(scope, await this.store.remove(scope, taskId));
  }
}
