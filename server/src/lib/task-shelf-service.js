// Предметный слой полки: scope всегда выводится из текущей портальной сессии,
// а клиент получает только непрозрачный хеш и полный server-confirmed снимок.
import { b24AccountScope } from './b24-account-scope.js';

export class TaskShelfIdentityError extends Error {
  constructor(message = 'Не удалось определить B24-пользователя', cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'TaskShelfIdentityError';
    this.code = 'B24_IDENTITY_UNAVAILABLE';
  }
}

function withScope(scope, snapshot) {
  const result = {
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
  /** @param {{ store: import('./task-shelf-store.js').TaskShelfStore, b24: object }} opts */
  constructor({ store, b24 }) {
    this.store = store;
    this.b24 = b24;
  }

  async _scope() {
    let identity;
    try {
      identity = await this.b24.accountIdentity();
      return b24AccountScope(identity);
    } catch (error) {
      throw new TaskShelfIdentityError(undefined, error);
    }
  }

  async list() {
    const scope = await this._scope();
    return withScope(scope, await this.store.list(scope));
  }

  async put(taskId, value) {
    const scope = await this._scope();
    return withScope(scope, await this.store.put(scope, taskId, value));
  }

  async remove(taskId) {
    const scope = await this._scope();
    return withScope(scope, await this.store.remove(scope, taskId));
  }
}
