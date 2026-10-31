import type { TrackerReadOptions } from './trackers/contract.ts';
// Предметный слой полки: scope всегда выводится из текущей портальной сессии,
// а клиент получает только непрозрачный хеш и полный server-confirmed снимок.
import { trackerAccountScope } from './trackers/accountScope.ts';
import type { TrackerIdentity } from './trackers/accountScope.ts';
import type { ShelfSnapshot, TaskShelfStore } from './taskShelfStore.ts';
import type { ShelfState } from '../../../shared/trackers/shelfContracts.ts';

export interface TaskShelfIdentitySource {
  accountIdentity(options?: TrackerReadOptions): Promise<TrackerIdentity | null>;
}

export interface TaskShelfResult extends ShelfState {
  // Тот же служебный флаг, что и у хранилища: он не перечисляется и в ответ не попадает.
  readonly changed?: boolean;
}

export class TaskShelfIdentityError extends Error {
  code: string;

  constructor(message = 'Не удалось определить пользователя трекера', cause: unknown = null) {
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

  tracker: TaskShelfIdentitySource;

  constructor({ store, tracker }: { store: TaskShelfStore; tracker: TaskShelfIdentitySource }) {
    this.store = store;
    this.tracker = tracker;
  }

  /**
   * Scope берётся только из подтверждённой серверной identity.
   * Signal отменяет чтение; локальные мутации сохраняют прежнюю доставку.
   */
  async _scope(options: TrackerReadOptions = {}): Promise<string> {
    try {
      const identity = await this.tracker.accountIdentity(options);

      return trackerAccountScope(identity);
    } catch (error) {
      throw new TaskShelfIdentityError(undefined, error);
    }
  }

  /**
   * Чтение полки снимает только своего подписчика при закрытии HTTP-ответа.
   * Состав снимка и не перечисляемый changed сохраняются общим withScope.
   */
  async list(options: TrackerReadOptions = {}): Promise<TaskShelfResult> {
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
