// Предметный слой избранного: браузер не передаёт account scope, он выводится
// из текущего B24-портала и пользователя и возвращается только как opaque hash.
import { createHash } from 'node:crypto';

export class TaskFavoritesIdentityError extends Error {
  constructor(message = 'Не удалось определить B24-пользователя', cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'TaskFavoritesIdentityError';
    this.code = 'B24_IDENTITY_UNAVAILABLE';
  }
}

function normalizedPortal(baseUrl) {
  const url = new URL(String(baseUrl));
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString().replace(/\/$/, '');
}

export function favoriteScopeFor(identity) {
  try {
    const userId = String(identity?.userId ?? '').trim();
    if (!/^[1-9]\d*$/.test(userId)) throw new Error('invalid user id');
    const portal = normalizedPortal(identity?.baseUrl);
    return createHash('sha256').update(`${portal}\0${userId}`).digest('hex');
  } catch (error) {
    throw new TaskFavoritesIdentityError(undefined, error);
  }
}

export class TaskFavoritesService {
  /** @param {{ store: import('./task-favorites-store.js').TaskFavoritesStore, b24: object }} opts */
  constructor({ store, b24 }) {
    this.store = store;
    this.b24 = b24;
  }

  async _scope() {
    let identity;
    try {
      identity = await this.b24.accountIdentity();
    } catch (error) {
      throw new TaskFavoritesIdentityError(undefined, error);
    }
    return favoriteScopeFor(identity);
  }

  async list() {
    const scope = await this._scope();
    return { scope, ...await this.store.list(scope) };
  }

  async add(taskId) {
    const scope = await this._scope();
    return { scope, ...await this.store.add(scope, taskId) };
  }

  async remove(taskId) {
    const scope = await this._scope();
    return { scope, ...await this.store.remove(scope, taskId) };
  }
}
