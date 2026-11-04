import { personalWriteGuard, resolvePersonalScope, validateOwnPersonalTasks } from './taskPersonalScope.ts';
import type { PersonalScopeOptions, OwnTaskReader, PersonalIdentitySource } from './taskPersonalScope.ts';
import type { TrackerReadOptions } from './trackers/contract.ts';
// Предметный слой полки: scope всегда выводится из текущей портальной сессии,
// а клиент получает только непрозрачный хеш и полный server-confirmed снимок.
import { trackerAccountScope } from './trackers/accountScope.ts';
import type { TrackerIdentity } from './trackers/accountScope.ts';
import type { ShelfSnapshot, TaskShelfStore } from './taskShelfStore.ts';
import type { ShelfState } from '../../../shared/trackers/shelfContracts.ts';

export interface TaskShelfIdentitySource extends PersonalIdentitySource {
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

  readonly ownTasks?: OwnTaskReader;

  constructor({ store, tracker, ownTasks }: {
    store: TaskShelfStore;
    tracker: TaskShelfIdentitySource;
    ownTasks?: OwnTaskReader
  }) {
    this.store = store;
    this.tracker = tracker;
    this.ownTasks = ownTasks;
  }

  /**
   * Scope берётся только из подтверждённой серверной identity.
   * Signal отменяет чтение; локальные мутации сохраняют прежнюю доставку.
   */
  async _scope(readOptions: TrackerReadOptions = {}, options: PersonalScopeOptions = {}): Promise<string> {
    try {
      return await resolvePersonalScope(this.tracker, options, readOptions);
    } catch (error) {
      if ((error as { status?: number }).status === 409) {
        throw error;
      }

      throw new TaskShelfIdentityError(undefined, error);
    }
  }

  /**
   * Чтение полки снимает только своего подписчика при закрытии HTTP-ответа.
   * Состав снимка и не перечисляемый changed сохраняются общим withScope.
   */
  async list(
    options: TrackerReadOptions = {},
    sourceOptions: PersonalScopeOptions = {},
  ): Promise<TaskShelfResult> {
    const scope = await this._scope(options, sourceOptions);

    return withScope(scope, await this.store.list(scope));
  }

  /**
   * Локальная мутация проверяет источник и собственную запись до очереди сохранения.
   * Проверка поколения повторяется внутри транзакции, не затрагивая own-пространство.
   */
  async put(taskId: unknown, value: unknown, options: PersonalScopeOptions = {}): Promise<TaskShelfResult> {
    const beforeWrite = personalWriteGuard(this.tracker, options);
    const scope = await this._scope({}, options);

    if (options.source === 'grigdesk') {
      await validateOwnPersonalTasks([taskId], this.ownTasks, true);
    }

    return withScope(scope, await this.store.put(scope, taskId, value, beforeWrite));
  }

  /**
   * Локальная мутация проверяет источник и собственную запись до очереди сохранения.
   * Проверка поколения повторяется внутри транзакции, не затрагивая own-пространство.
   */
  async remove(taskId: unknown, options: PersonalScopeOptions = {}): Promise<TaskShelfResult> {
    const beforeWrite = personalWriteGuard(this.tracker, options);
    const scope = await this._scope({}, options);

    if (options.source === 'grigdesk') {
      await validateOwnPersonalTasks([taskId], this.ownTasks, false);
    }

    return withScope(scope, await this.store.remove(scope, taskId, beforeWrite));
  }
}
