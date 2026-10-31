// Предметный слой просмотренных задач: scope выводится из текущего трекера и
// пользователя, наружу уходит только opaque hash — клиент не может попросить чужой набор.
import { trackerAccountScope } from './trackers/accountScope.ts';
import type { TrackerIdentity } from './trackers/accountScope.ts';
import type { TaskSeenStore, SeenScope } from './taskSeenStore.ts';
import type { TrackerFacade } from './trackers/facade.ts';

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
  readonly tracker: Pick<TrackerFacade, 'accountIdentity'>;

  constructor({ store, tracker }: {
    store: TaskSeenStore;
    tracker: Pick<TrackerFacade, 'accountIdentity'>;
  }) {
    this.store = store;
    this.tracker = tracker;
  }

  /**
   * Идентичность берётся у выбранного драйвера перед каждой операцией сервиса.
   * Неполные реквизиты и сетевые отказы превращаются в безопасную ошибку области.
   */
  private async _scope(): Promise<string> {
    let identity: Awaited<ReturnType<TrackerFacade['accountIdentity']>>;

    try {
      identity = await this.tracker.accountIdentity();
    } catch (error) {
      throw new TaskSeenIdentityError(undefined, error);
    }
    return seenScopeFor(identity);
  }

  async list(): Promise<SeenScope & { scope: string }> {
    const scope = await this._scope();
    return { scope, ...await this.store.list(scope) };
  }

  async markSeen(
    taskIds: unknown,
    options: { baseline?: boolean } = {},
  ): Promise<SeenScope & { scope: string }> {
    const scope = await this._scope();
    return { scope, ...await this.store.markSeen(scope, taskIds, options) };
  }
}
