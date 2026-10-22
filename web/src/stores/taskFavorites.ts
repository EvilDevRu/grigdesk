// Серверное избранное B24-задач. Строка фильтра меняется после подтверждения сервера.
// Ошибка мутации сохраняет прежний список без локального rollback.
import { defineStore } from 'pinia';
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

export const useTaskFavoritesStore = defineStore('taskFavorites', {
  state: () => ({
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
    count: (state) => state.taskIds.length,
    isFavorite: (state) => (id: unknown) => state.taskIds.includes(taskKey(id)),
    isPending: (state) => (id: unknown) => !!state.pending[taskKey(id)],
  },
  actions: {
    /**
     * Принимает только новый scope или неустаревшую ревизию текущего владельца.
     * Поздний ответ старого аккаунта не восстанавливает его список.
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
      this.taskIds = snapshot.taskIds;
      this.loaded = true;
      this._scopeRequestSeq = Math.max(this._scopeRequestSeq, seq);

      return true;
    },

    /**
     * Загрузка сохраняет прежнее правило единственного запроса и кеша снимка.
     * Смена эпохи отменяет применение ответа и его служебных флагов.
     */
    async load(force = false): Promise<boolean> {
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
        const snapshot = await api.get('/api/b24/task-favorites');

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
    async setFavorite(id: unknown, favorite: boolean): Promise<boolean> {
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
        const snapshot = favorite
          ? await api.put(`/api/b24/task-favorites/${encodeURIComponent(key)}`)
          : await api.del(`/api/b24/task-favorites/${encodeURIComponent(key)}`);

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

    toggle(id: unknown): Promise<boolean> {
      return this.setFavorite(id, !this.isFavorite(id));
    },

    /**
     * Выход из аккаунта сбрасывает снимок и повышает эпоху запросов.
     * Летящие ответы больше не могут восстановить избранное.
     */
    clear() {
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
