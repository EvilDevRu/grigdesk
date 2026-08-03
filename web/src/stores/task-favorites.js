// Серверное избранное B24-задач. Мутации server-confirmed: строка под фильтром
// не исчезает до успешного DELETE, а ошибка не требует сложного rollback.
import { defineStore } from 'pinia';
import { api } from '../shared/api-client.js';

function taskKey(value) {
  return String(value ?? '').trim();
}

function normalizedSnapshot(value) {
  const scope = String(value?.scope || '');
  const revision = Number(value?.revision);
  if (!scope || !Number.isSafeInteger(revision) || revision < 0 || !Array.isArray(value?.taskIds)) {
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
    taskIds: [],
    loaded: false,
    loading: false,
    error: null,
    pending: {},
    _epoch: 0,
    _requestSeq: 0,
    _scopeRequestSeq: 0,
  }),
  getters: {
    count: (state) => state.taskIds.length,
    isFavorite: (state) => (id) => state.taskIds.includes(taskKey(id)),
    isPending: (state) => (id) => !!state.pending[taskKey(id)],
  },
  actions: {
    applySnapshot(value, requestSeq = null) {
      const snapshot = normalizedSnapshot(value);
      const seq = requestSeq ?? ++this._requestSeq;
      if (snapshot.scope !== this.scope && seq < this._scopeRequestSeq) return false;
      if (snapshot.scope === this.scope && snapshot.revision < this.revision) return false;
      this.scope = snapshot.scope;
      this.revision = snapshot.revision;
      this.taskIds = snapshot.taskIds;
      this.loaded = true;
      this._scopeRequestSeq = Math.max(this._scopeRequestSeq, seq);
      return true;
    },

    async load(force = false) {
      if (this.loading) return false;
      if (this.loaded && !force) return true;
      const epoch = this._epoch;
      const requestSeq = ++this._requestSeq;
      this.loading = true;
      this.error = null;
      try {
        const snapshot = await api.get('/api/b24/task-favorites');
        if (epoch !== this._epoch) return false;
        this.applySnapshot(snapshot, requestSeq);
        return true;
      } catch (error) {
        if (epoch === this._epoch) this.error = error?.message || 'Избранное недоступно';
        return false;
      } finally {
        if (epoch === this._epoch) this.loading = false;
      }
    },

    async setFavorite(id, favorite) {
      const key = taskKey(id);
      if (!key || this.pending[key]) return false;
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
        if (epoch !== this._epoch) return false;
        this.applySnapshot(snapshot, requestSeq);
        return true;
      } catch (error) {
        if (epoch === this._epoch) this.error = error?.message || 'Не удалось изменить избранное';
        return false;
      } finally {
        if (epoch === this._epoch) {
          const { [key]: _, ...rest } = this.pending;
          this.pending = rest;
        }
      }
    },

    toggle(id) {
      return this.setFavorite(id, !this.isFavorite(id));
    },

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
