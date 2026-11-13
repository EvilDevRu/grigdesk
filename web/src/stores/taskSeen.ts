import { resolveTrackerTarget } from '../shared/trackerTarget.ts';
import type { TaskSourceId } from '../../../shared/tasks/taskReference.ts';
import type { TaskSourceOptions, TaskPersonalSource } from '../../../shared/tasks/taskReference.ts';
import { trackerMutationOptions } from '../shared/trackerMutation.ts';
import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../shared/uiLocalePort.ts';


// Серверные отметки двух личных пространств синхронизируются между устройствами.
// Пока базовой линии нет, давние задачи не объявляются новыми.
import { defineStore } from 'pinia';
import type { StoreGeneric } from 'pinia';
import { api } from '../shared/apiClient.ts';
import { errorMessage } from '../../../shared/lib/errors.ts';
import { isRecord } from '../../../shared/lib/objects.ts';

const t = localeTranslator(uiLocalePort);

function taskKey(value: unknown): string {
  return String(value ?? '').trim();
}

/**
 * Проверяет снимок отметок до изменения scope и ревизии стора.
 * Прежняя нормализация сохраняет порядок уникальных идентификаторов.
 */
function normalizedSnapshot(value: unknown) {
  if (!isRecord(value)) {
    throw new Error(t('core.taskServerVernulNekorrektnyeOtmetki'));
  }

  const scope = String(value.scope || '');
  const revision = Number(value.revision);

  if (!scope || !Number.isSafeInteger(revision) || revision < 0
    || typeof value.initialized !== 'boolean' || !Array.isArray(value.taskIds)) {
    throw new Error(t('core.taskServerVernulNekorrektnyeOtmetki'));
  }

  return {
    scope,
    revision,
    initialized: value.initialized,
    taskIds: [...new Set(value.taskIds.map(taskKey).filter(Boolean))],
  };
}

interface SeenBranch extends Pick<StoreGeneric, '$onAction'> {
  scope: string;
  revision: number;
  taskIds: string[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  clear(options?: TaskSourceOptions): void;
  load(force?: boolean, options?: TaskSourceOptions): Promise<boolean>;
  initialized: boolean;
  marking: boolean;
  ready: boolean;
  isSeen(id: unknown): boolean;
  markSeen(ids: unknown, options?: TaskSourceOptions & {
    baseline?: boolean; baselineId?: string;
  }): Promise<boolean>;
}

/**
 * Один алгоритм личного состояния создаётся для каждой подтверждённой учётной записи.
 * Раздельные эпохи и очереди сохраняют соседние источники при смене реквизитов.
 */
const createTaskSeenStore = (
  storeId: string, source: TaskPersonalSource, taskSource?: string,
) => {
  const prefix = taskSource ? `tracker/${encodeURIComponent(taskSource.split('@')[0]!)}` : 'tracker';
  const url = `/api/${prefix}/task-seen`;

  return defineStore(storeId, {
  state: () => ({
    sources: [] as string[],
    scope: '',
    revision: -1,
    initialized: false,
    taskIds: [] as string[],
    loaded: false,
    loading: false,
    marking: false,
    error: null as string | null,
    _epoch: 0,
    _requestSeq: 0,
    _scopeRequestSeq: 0,
    _inflight: null as Promise<boolean> | null,
  }),
  getters: {
    external: (state): SeenBranch[] => state.sources.map((id) => externalBranches.get(id)!()),
    count: (state) => state.taskIds.length,
    isSeen: (state) => (id: unknown) => state.taskIds.includes(taskKey(id)),
    ready: (state) => state.loaded && state.initialized,
  },
  actions: {
    /**
     * Полный источник выбирает независимую ветку личного состояния.
     * Прежний числовой вход сохраняет обращения к доске по умолчанию.
     */
    forSource(target?: string): SeenBranch {
      if (!target || !target.includes('@')) {
        return this;
      }

      if (!taskSource && !this.sources.includes(target)) {
        this.sources.push(target);
      }

      let useBranch = externalBranches.get(target);

      if (!useBranch) {
        useBranch = createTaskSeenStore(`taskSeen-${target}`, 'tracker', target);
        externalBranches.set(target, useBranch);
      }

      return useBranch();
    },
    /**
     * Принимает только актуальный ответ текущего или более нового scope.
     * Старая ревизия одного владельца не откатывает уже показанные отметки.
     */
    applySnapshot(value: unknown, requestSeq: number | null = null) {
      const snapshot = normalizedSnapshot(value);


      const seq = requestSeq ?? ++this._requestSeq;

      if (snapshot.scope !== this.scope && seq < this._scopeRequestSeq) {
        return false;
      }
      if (snapshot.scope === this.scope && snapshot.revision < this.revision) {
        return false;
      }

      this.scope = snapshot.scope;
      this.revision = snapshot.revision;
      this.initialized = snapshot.initialized;
      this.taskIds = snapshot.taskIds;
      this.loaded = true;
      this._scopeRequestSeq = Math.max(this._scopeRequestSeq, seq);

      return true;
    },

    /**
     * Одновременные читатели ждут тот же запрос, вместо пропуска загрузки.
     * Ответ ушедшей эпохи не меняет снимок и флаги аккаунта.
     */
    async load(force = false, options: TaskSourceOptions = {}): Promise<boolean> {

      if (this._inflight) {
        return this._inflight;
      }
      if (this.loaded && !force) {
        return true;
      }

      const epoch = this._epoch;
      const requestSeq = ++this._requestSeq;

      this.loading = true;
      this.error = null;
      this._inflight = (async () => {
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
            this.error = errorMessage(error, t('core.coreOtmetkiProsmotraNedostupny'));
          }

          return false;
        } finally {
          if (epoch === this._epoch) {
            this.loading = false;
          }

          if (epoch === this._epoch) {
            this._inflight = null;
          }
        }
      })();

      return this._inflight;
    },

    /**
     * Базовый снимок один раз гасит новизну уже существующих задач.
     * Обычный просмотр не повторяет отправку уже подтверждённых отметок.
     */
    async markSeen(ids: unknown, {
      baseline = false, source: requestedSource, baselineId,
    }: TaskSourceOptions & {
      baseline?: boolean; baselineId?: string;
    } = {}): Promise<boolean> {

      const taskIds = [...new Set((Array.isArray(ids) ? ids : [ids]).map(taskKey).filter(Boolean))];

      if (!taskIds.length && !baseline && !baselineId) {
        return true;
      }
      if (!baseline && !baselineId && this.loaded && taskIds.every((id) => this.taskIds.includes(id))) {
        return true;
      }

      const epoch = this._epoch;
      const requestSeq = ++this._requestSeq;

      this.marking = true;
      this.error = null;

      try {
        const target = taskSource ? await resolveTrackerTarget(taskSource as TaskSourceId, api) : null;
        const snapshot = await api.post(url, {
          taskIds,
          baseline,
          ...(baselineId ? { baselineId } : {})
        },
          target?.options ?? (source === 'tracker' ? trackerMutationOptions() : {}));

        if (epoch !== this._epoch) {
          return false;
        }

        this.applySnapshot(snapshot, requestSeq);

        return true;
      } catch (error) {
        if (epoch === this._epoch) {
          this.error = errorMessage(error, t('core.coreNeUdalosOtmetitZadachu'));
        }

        return false;
      } finally {
        if (epoch === this._epoch) {
          this.marking = false;
        }
      }
    },

    /**
     * Удаляет данные аккаунта и обесценивает все его летящие ответы.
     * Базовая линия нового владельца будет загружена заново.
     */
    clear(options: TaskSourceOptions = {}): void {
      if (!taskSource && source === 'tracker') {
        this.external.forEach((branch) => branch.clear());
      }

      this._epoch += 1;
      this._requestSeq += 1;
      this._scopeRequestSeq = this._requestSeq;
      this._inflight = null;
      this.scope = '';
      this.revision = -1;
      this.initialized = false;
      this.taskIds = [];
      this.loaded = false;
      this.loading = false;
      this.marking = false;
      this.error = null;
    },
  },
  });
};

const externalBranches = new Map<string, ReturnType<typeof createTaskSeenStore>>();

export const useTaskSeenStore = createTaskSeenStore('taskSeen', 'tracker');
