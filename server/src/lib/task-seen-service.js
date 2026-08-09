// Предметный слой просмотренных задач: scope выводится из текущего B24-портала и
// пользователя, наружу уходит только opaque hash — клиент не может попросить чужой набор.
import { b24AccountScope } from './b24-account-scope.js';

export class TaskSeenIdentityError extends Error {
  constructor(message = 'Не удалось определить B24-пользователя', cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'TaskSeenIdentityError';
    this.code = 'B24_IDENTITY_UNAVAILABLE';
  }
}

export function seenScopeFor(identity) {
  try {
    return b24AccountScope(identity);
  } catch (error) {
    throw new TaskSeenIdentityError(undefined, error);
  }
}

export class TaskSeenService {
  /** @param {{ store: import('./task-seen-store.js').TaskSeenStore, b24: object }} opts */
  constructor({ store, b24 }) {
    this.store = store;
    this.b24 = b24;
  }

  async _scope() {
    let identity;
    try {
      identity = await this.b24.accountIdentity();
    } catch (error) {
      throw new TaskSeenIdentityError(undefined, error);
    }
    return seenScopeFor(identity);
  }

  async list() {
    const scope = await this._scope();
    return { scope, ...await this.store.list(scope) };
  }

  async markSeen(taskIds, options = {}) {
    const scope = await this._scope();
    return { scope, ...await this.store.markSeen(scope, taskIds, options) };
  }
}
