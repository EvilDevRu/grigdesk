import { personalWriteGuard, resolvePersonalScope, validateOwnPersonalTasks } from './taskPersonalScope.ts';
import type { PersonalScopeOptions, OwnTaskReader } from './taskPersonalScope.ts';
import type { TrackerReadOptions } from './trackers/contract.ts';
// Предметный слой просмотренных задач: scope выводится из текущего B24-портала и
// пользователя, наружу уходит только opaque hash — клиент не может попросить чужой набор.
import { trackerAccountScope } from './trackers/accountScope.ts';
import type { TrackerIdentity } from './trackers/accountScope.ts';
import type { TaskSeenStore, SeenScope } from './taskSeenStore.ts';
import type { PersonalIdentitySource } from './taskPersonalScope.ts';

export class TaskSeenIdentityError extends Error {
  readonly code = 'B24_IDENTITY_UNAVAILABLE';

  constructor(message = 'Не удалось определить пользователя трекера', cause: unknown = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'TaskSeenIdentityError';
  }
}

/**
 * Просмотренные задачи используют тот же ключ учётной записи, что избранное и полка.
 * Отказ определения пользователя остаётся безопасной ошибкой предметного сервиса.
 */
export function seenScopeFor(identity: TrackerIdentity | null | undefined): string {
  try {
    return trackerAccountScope(identity);
  } catch (error) {
    throw new TaskSeenIdentityError(undefined, error);
  }
}

export class TaskSeenService {
  readonly store: TaskSeenStore;

  // Фасад трекера: из него берётся текущая учётная запись, а не из запроса браузера.
  readonly tracker: PersonalIdentitySource;

  readonly ownTasks?: OwnTaskReader;

  constructor({ store, tracker, ownTasks }: {
    ownTasks?: OwnTaskReader;
    store: TaskSeenStore;
    tracker: PersonalIdentitySource;
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

      throw new TaskSeenIdentityError(undefined, error);
    }
  }

  /**
   * Чтение отметок передаёт срок жизни HTTP до общего определения identity.
   * Серверный scope по-прежнему не может быть выбран полем запроса.
   */
  async list(
    options: TrackerReadOptions = {},
    sourceOptions: PersonalScopeOptions = {},
  ): Promise<SeenScope & { scope: string }> {
    const scope = await this._scope(options, sourceOptions);

    return { scope, ...await this.store.list(scope) };
  }

  /**
   * Локальная мутация проверяет источник и собственную запись до очереди сохранения.
   * Проверка поколения повторяется внутри транзакции, не затрагивая own-пространство.
   */
  async markSeen(
    taskIds: unknown,
    options: PersonalScopeOptions & { baseline?: boolean; baselineId?: string } = {},
  ): Promise<SeenScope & { scope: string }> {
    const beforeWrite = personalWriteGuard(this.tracker, options);
    const scope = await this._scope({}, options);

    if (options.source === 'grigdesk') {
      await validateOwnPersonalTasks(Array.isArray(taskIds) ? taskIds : [taskIds], this.ownTasks);
    }

    return {
      scope,
      ...await this.store.markSeen(scope, taskIds, {
      ...options,
      beforeWrite,
      initializeOnce: options.source === 'grigdesk'
    })
    };
  }
}
