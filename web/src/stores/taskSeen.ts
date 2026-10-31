// Серверные отметки просмотра синхронизируются между устройствами владельца.
// Пока базовой линии нет, давние задачи не объявляются новыми.
import { defineStore } from 'pinia';
import { api } from '../shared/apiClient.ts';
import { errorMessage } from '../../../shared/lib/errors.ts';
import { isRecord } from '../../../shared/lib/objects.ts';

function taskKey(value: unknown): string {
  return String(value ?? '').trim();
}

/**
 * Проверяет снимок отметок до изменения scope и ревизии стора.
 * Прежняя нормализация сохраняет порядок уникальных идентификаторов.
 */
function normalizedSnapshot(value: unknown) {
  if (!isRecord(value)) {
    throw new Error('Сервер вернул некорректные отметки просмотра');
  }

  const scope = String(value.scope || '');
  const revision = Number(value.revision);

  if (!scope || !Number.isSafeInteger(revision) || revision < 0
    || typeof value.initialized !== 'boolean' || !Array.isArray(value.taskIds)) {
    throw new Error('Сервер вернул некорректные отметки просмотра');
  }

  return {
    scope,
    revision,
    initialized: value.initialized,
    taskIds: [...new Set(value.taskIds.map(taskKey).filter(Boolean))],
  };
}

export const useTaskSeenStore = defineStore('taskSeen', {
  state: () => ({
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
    count: (state) => state.taskIds.length,
    isSeen: (state) => (id: unknown) => state.taskIds.includes(taskKey(id)),
    ready: (state) => state.loaded && state.initialized,
  },
  actions: {
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
    async load(force = false): Promise<boolean> {
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
          const snapshot = await api.get('/api/tracker/task-seen');

          if (epoch !== this._epoch) {
            return false;
          }

          this.applySnapshot(snapshot, requestSeq);

          return true;
        } catch (error) {
          if (epoch === this._epoch) {
            this.error = errorMessage(error, 'Отметки просмотра недоступны');
          }

          return false;
        } finally {
          if (epoch === this._epoch) {
            this.loading = false;
          }

          this._inflight = null;
        }
      })();

      return this._inflight;
    },

    /**
     * Базовый снимок один раз гасит новизну уже существующих задач.
     * Обычный просмотр не повторяет отправку уже подтверждённых отметок.
     */
    async markSeen(ids: unknown, { baseline = false } = {}): Promise<boolean> {
      const taskIds = [...new Set((Array.isArray(ids) ? ids : [ids]).map(taskKey).filter(Boolean))];

      if (!taskIds.length && !baseline) {
        return true;
      }
      if (!baseline && this.loaded && taskIds.every((id) => this.taskIds.includes(id))) {
        return true;
      }

      const epoch = this._epoch;
      const requestSeq = ++this._requestSeq;

      this.marking = true;
      this.error = null;

      try {
        const snapshot = await api.post('/api/tracker/task-seen', { taskIds, baseline });

        if (epoch !== this._epoch) {
          return false;
        }

        this.applySnapshot(snapshot, requestSeq);

        return true;
      } catch (error) {
        if (epoch === this._epoch) {
          this.error = errorMessage(error, 'Не удалось отметить задачу просмотренной');
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
    clear() {
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
