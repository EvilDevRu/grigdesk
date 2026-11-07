import { personalWriteGuard, resolvePersonalScope, validateOwnPersonalTasks } from './taskPersonalScope.ts';
import type { PersonalScopeOptions, OwnTaskReader } from './taskPersonalScope.ts';
import type { TrackerReadOptions } from './trackers/contract.ts';
// Предметный слой избранного: браузер не передаёт account scope, он выводится
// из текущего трекера и пользователя и возвращается только как opaque hash.
import { trackerAccountScope } from './trackers/accountScope.ts';
import type { TrackerIdentity } from './trackers/accountScope.ts';
import type { TaskFavoritesStore, FavoritesScope } from './taskFavoritesStore.ts';
import type { PersonalIdentitySource } from './taskPersonalScope.ts';

export class TaskFavoritesIdentityError extends Error {
  readonly code = 'B24_IDENTITY_UNAVAILABLE';

  constructor(message = 'Не удалось определить пользователя трекера', cause: unknown = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'TaskFavoritesIdentityError';
  }
}

/**
 * Избранное использует общий ключ учётной записи и скрывает причину отказа источника.
 * Неполная идентичность не позволяет прочитать либо изменить чужую подборку.
 */
export function favoriteScopeFor(identity: TrackerIdentity | null | undefined): string {
  try {
    return trackerAccountScope(identity);
  } catch (error) {
    throw new TaskFavoritesIdentityError(undefined, error);
  }
}

export class TaskFavoritesService {
  readonly store: TaskFavoritesStore;

  // Фасад трекера: из него берётся текущая учётная запись, а не из запроса браузера.
  readonly tracker: PersonalIdentitySource;

  readonly ownTasks?: OwnTaskReader;

  constructor({ store, tracker, ownTasks }: {
    ownTasks?: OwnTaskReader;
    store: TaskFavoritesStore;
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

      throw new TaskFavoritesIdentityError(undefined, error);
    }
  }

  /**
   * GET может снять своего подписчика холодного определения scope.
   * Локальные мутации используют прежний вызов _scope без HTTP-отмены.
   */
  async list(
    options: TrackerReadOptions = {},
    sourceOptions: PersonalScopeOptions = {},
  ): Promise<FavoritesScope & { scope: string }> {
    const scope = await this._scope(options, sourceOptions);

    return { scope, ...await this.store.list(scope) };
  }

  /**
   * Локальная мутация проверяет источник и собственную запись до очереди сохранения.
   * Проверка поколения повторяется внутри транзакции, не затрагивая own-пространство.
   */
  async add(
    taskId: unknown,
    options: PersonalScopeOptions = {},
  ): Promise<FavoritesScope & { scope: string }> {
    const beforeWrite = personalWriteGuard(this.tracker, options);
    const scope = await this._scope({}, options);

    if (options.source === 'grigdesk') {
      await validateOwnPersonalTasks([taskId], this.ownTasks, true);
    }

    return { scope, ...await this.store.add(scope, taskId, beforeWrite) };
  }

  /**
   * Локальная мутация проверяет источник и собственную запись до очереди сохранения.
   * Проверка поколения повторяется внутри транзакции, не затрагивая own-пространство.
   */
  async remove(
    taskId: unknown,
    options: PersonalScopeOptions = {},
  ): Promise<FavoritesScope & { scope: string }> {
    const beforeWrite = personalWriteGuard(this.tracker, options);
    const scope = await this._scope({}, options);

    if (options.source === 'grigdesk') {
      await validateOwnPersonalTasks([taskId], this.ownTasks, false);
    }

    return { scope, ...await this.store.remove(scope, taskId, beforeWrite) };
  }
}
