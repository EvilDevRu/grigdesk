import { resolveTrackerTarget } from '../shared/trackerTarget.ts';
import type { TaskSourceId } from '../../../shared/tasks/taskReference.ts';
import type { TaskSourceOptions, TaskPersonalSource } from '../../../shared/tasks/taskReference.ts';
import { trackerMutationOptions } from '../shared/trackerMutation.ts';
// Независимое серверное избранное трекера и GrigDesk. Строка фильтра меняется после подтверждения сервера.
// Ошибка мутации сохраняет прежний список без локального rollback.
import { defineStore } from 'pinia';
import type { StoreGeneric } from 'pinia';
import { api } from '../shared/apiClient.ts';
import { errorMessage } from '../../../shared/lib/errors.ts';
import { isRecord } from '../../../shared/lib/objects.ts';

function taskKey(value: unknown): string {
  return String(value ?? '').trim();
}

/**
 * Нормализует серверный снимок до применения revision и scope.
 * Порядок и дедупликация идентификаторов остаются прежними.
 */
function normalizedSnapshot(value: unknown) {
  if (!isRecord(value)) {
    throw new Error('Сервер вернул некорректное избранное');
  }

  const scope = String(value.scope || '');
  const revision = Number(value.revision);

  if (!scope || !Number.isSafeInteger(revision) || revision < 0 || !Array.isArray(value.taskIds)) {
    throw new Error('Сервер вернул некорректное избранное');
  }

  return {
    scope,
    revision,
    taskIds: [...new Set(value.taskIds.map(taskKey).filter(Boolean))],
  };
}

interface FavoritesBranch extends Pick<StoreGeneric, '$onAction'> {
  scope: string;
  revision: number;
  taskIds: string[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  clear(options?: TaskSourceOptions): void;
  load(force?: boolean, options?: TaskSourceOptions): Promise<boolean>;
  pending: Record<string, boolean>;
  isFavorite(id: unknown): boolean;
  isPending(id: unknown): boolean;
  setFavorite(id: unknown, favorite: boolean, options?: TaskSourceOptions): Promise<boolean>;
  toggle(id: unknown, options?: TaskSourceOptions): Promise<boolean>;
}

/**
 * Один алгоритм личного состояния создаётся для каждой подтверждённой учётной записи.
 * Раздельные эпохи и очереди сохраняют соседние источники при смене реквизитов.
 */
const createTaskFavoritesStore = (
  storeId: string, source: TaskPersonalSource, taskSource?: string,
) => {
  const prefix = source === 'grigdesk' ? 'grigdesk-tasks'
    : taskSource ? `tracker/${encodeURIComponent(taskSource.split('@')[0]!)}` : 'tracker';
  const url = `/api/${prefix}/task-favorites`;

  return defineStore(storeId, {
  state: () => ({
    sources: [] as string[],
    scope: '',
    revision: -1,
    taskIds: [] as string[],
    loaded: false,
    loading: false,
    error: null as string | null,
    pending: {} as Record<string, boolean>,
    _epoch: 0,
    _requestSeq: 0,
    _scopeRequestSeq: 0,
  }),
  getters: {
    external: (state): FavoritesBranch[] => state.sources.map((id) => externalBranches.get(id)!()),
    own: (): FavoritesBranch => useGrigdeskTaskFavoritesStore(),
    count: (state) => state.taskIds.length,
    isFavorite: (state) => (id: unknown) => state.taskIds.includes(taskKey(id)),
    isPending: (state) => (id: unknown) => !!state.pending[taskKey(id)],
  },
  actions: {
    /**
     * Полный источник выбирает независимую ветку личного состояния.
     * Собственные задачи и прежний default сохраняют свои публичные обращения.
     */
    forSource(target?: string): FavoritesBranch {
      if (target === 'grigdesk') {
        return useGrigdeskTaskFavoritesStore();
      }
      if (!target || !target.includes('@')) {
        return this;
      }

      if (!taskSource && !this.sources.includes(target)) {
        this.sources.push(target);
      }

      let useBranch = externalBranches.get(target);

      if (!useBranch) {
        useBranch = createTaskFavoritesStore(`taskFavorites-${target}`, 'tracker', target);
        externalBranches.set(target, useBranch);
      }

      return useBranch();
    },
    /**
     * Принимает только новый scope или неустаревшую ревизию текущего владельца.
     * Поздний ответ старого аккаунта не восстанавливает его список.
     */
    applySnapshot(value: unknown, requestSeq: number | null = null) {
      const snapshot = normalizedSnapshot(value);

      if (source === 'grigdesk' && snapshot.scope !== 'grigdesk') {
        throw new Error('Некорректный источник личных меток GrigDesk');
      }

      const seq = requestSeq ?? ++this._requestSeq;

      if (snapshot.scope !== this.scope && seq < this._scopeRequestSeq) {
        return false;
      }
      if (snapshot.scope === this.scope && snapshot.revision < this.revision) {
        return false;
      }

      this.scope = snapshot.scope;
      this.revision = snapshot.revision;
      this.taskIds = snapshot.taskIds;
      this.loaded = true;
      this._scopeRequestSeq = Math.max(this._scopeRequestSeq, seq);

      return true;
    },

    /**
     * Загрузка сохраняет прежнее правило единственного запроса и кеша снимка.
     * Смена эпохи отменяет применение ответа и его служебных флагов.
     */
    async load(force = false, options: TaskSourceOptions = {}): Promise<boolean> {
      if (options.source === 'grigdesk' && source !== 'grigdesk') {
        return useGrigdeskTaskFavoritesStore().load(force);
      }

      if (this.loading) {
        return false;
      }
      if (this.loaded && !force) {
        return true;
      }

      const epoch = this._epoch;
      const requestSeq = ++this._requestSeq;

      this.loading = true;
      this.error = null;

      try {
        const target = taskSource ? await resolveTrackerTarget(taskSource as TaskSourceId, api) : null;
          const snapshot = await api.get(url, target?.options);

        if (epoch !== this._epoch) {
          return false;
        }

        this.applySnapshot(snapshot, requestSeq);

        return true;
      } catch (error) {
        if (epoch === this._epoch) {
          this.error = errorMessage(error, 'Избранное недоступно');
        }

        return false;
      } finally {
        if (epoch === this._epoch) {
          this.loading = false;
        }
      }
    },

    /**
     * Меняет список только по подтверждённому серверному снимку.
     * Блокировка принадлежит задаче и снимается только в своей эпохе.
     */
    async setFavorite(id: unknown, favorite: boolean, options: TaskSourceOptions = {}): Promise<boolean> {
      if (options.source === 'grigdesk' && source !== 'grigdesk') {
        return useGrigdeskTaskFavoritesStore().setFavorite(id, favorite);
      }

      const key = taskKey(id);

      if (!key || this.pending[key]) {
        return false;
      }
      if (!this.loaded) {
        this.error = 'Избранное ещё не загружено';

        return false;
      }

      const epoch = this._epoch;
      const requestSeq = ++this._requestSeq;

      this.pending = { ...this.pending, [key]: true };
      this.error = null;

      try {
        const target = taskSource ? await resolveTrackerTarget(taskSource as TaskSourceId, api) : null;
        const snapshot = favorite
          ? await api.put(`${url}/${encodeURIComponent(key)}`, undefined,
            target?.options ?? (source === 'tracker' ? trackerMutationOptions() : {}))
          : await api.del(`${url}/${encodeURIComponent(key)}`, undefined,
            target?.options ?? (source === 'tracker' ? trackerMutationOptions() : {}));

        if (epoch !== this._epoch) {
          return false;
        }

        this.applySnapshot(snapshot, requestSeq);

        return true;
      } catch (error) {
        if (epoch === this._epoch) {
          this.error = errorMessage(error, 'Не удалось изменить избранное');
        }

        return false;
      } finally {
        if (epoch === this._epoch) {
          const { [key]: _, ...rest } = this.pending;

          this.pending = rest;
        }
      }
    },

    toggle(id: unknown, options: TaskSourceOptions = {}): Promise<boolean> {
      if (options.source === 'grigdesk' && source !== 'grigdesk') {
        return useGrigdeskTaskFavoritesStore().toggle(id);
      }

      return this.setFavorite(id, !this.isFavorite(id));
    },

    /**
     * Выход из аккаунта сбрасывает снимок и повышает эпоху запросов.
     * Летящие ответы больше не могут восстановить избранное.
     */
    clear(options: TaskSourceOptions = {}): void {
      if (!taskSource && source === 'tracker') {
        this.external.forEach((branch) => branch.clear());
      }

      if (!taskSource && source === 'tracker' && options.source !== 'tracker') {
        useGrigdeskTaskFavoritesStore().clear();
      }

      this._epoch += 1;
      this._requestSeq += 1;
      this._scopeRequestSeq = this._requestSeq;
      this.scope = '';
      this.revision = -1;
      this.taskIds = [];
      this.loaded = false;
      this.loading = false;
      this.error = null;
      this.pending = {};
    },
  },
  });
};

const externalBranches = new Map<string, ReturnType<typeof createTaskFavoritesStore>>();

export const useTaskFavoritesStore = createTaskFavoritesStore('taskFavorites', 'tracker');
export const useGrigdeskTaskFavoritesStore = createTaskFavoritesStore('grigdeskTaskFavorites', 'grigdesk');
