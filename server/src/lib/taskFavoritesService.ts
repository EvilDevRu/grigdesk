import type { TrackerReadOptions } from './trackers/contract.ts';
// Предметный слой избранного: браузер не передаёт account scope, он выводится
// из текущего трекера и пользователя и возвращается только как opaque hash.
import { trackerAccountScope } from './trackers/accountScope.ts';
import type { TrackerIdentity } from './trackers/accountScope.ts';
import type { TaskFavoritesStore, FavoritesScope } from './taskFavoritesStore.ts';
import type { TrackerFacade } from './trackers/facade.ts';

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
  readonly tracker: Pick<TrackerFacade, 'accountIdentity'>;

  constructor({ store, tracker }: {
    store: TaskFavoritesStore;
    tracker: Pick<TrackerFacade, 'accountIdentity'>;
  }) {
    this.store = store;
    this.tracker = tracker;
  }

  /**
   * Scope берётся только из подтверждённой серверной identity.
   * Signal отменяет чтение; локальные мутации сохраняют прежнюю доставку.
   */
  private async _scope(options: TrackerReadOptions = {}): Promise<string> {
    let identity: Awaited<ReturnType<TrackerFacade['accountIdentity']>>;

    try {
      identity = await this.tracker.accountIdentity(options);
    } catch (error) {
      throw new TaskFavoritesIdentityError(undefined, error);
    }
    return favoriteScopeFor(identity);
  }

  /**
   * GET может снять своего подписчика холодного определения scope.
   * Локальные мутации используют прежний вызов _scope без HTTP-отмены.
   */
  async list(options: TrackerReadOptions = {}): Promise<FavoritesScope & { scope: string }> {
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
