// Серверные отметки «задачу просмотрели». Хранятся, как избранное: у окна нет своей
// копии, поэтому открытая на компьютере задача перестаёт быть новой и на планшете.
import { defineStore } from 'pinia';
import { api } from '../shared/api-client.js';

function taskKey(value) {
  return String(value ?? '').trim();
}

function normalizedSnapshot(value) {
  const scope = String(value?.scope || '');
  const revision = Number(value?.revision);
  if (!scope || !Number.isSafeInteger(revision) || revision < 0
    || typeof value?.initialized !== 'boolean' || !Array.isArray(value?.taskIds)) {
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
    // Пока базовой линии нет, «новых» задач не бывает: иначе первая же загрузка доски
    // на новой установке объявила бы новыми все давние задачи разом.
    initialized: false,
    taskIds: [],
    loaded: false,
    loading: false,
    marking: false,
    error: null,
    _epoch: 0,
    _requestSeq: 0,
    _scopeRequestSeq: 0,
    _inflight: null,
  }),
  getters: {
    count: (state) => state.taskIds.length,
    isSeen: (state) => (id) => state.taskIds.includes(taskKey(id)),
    // Отвечать «задача новая» можно только с загруженной базовой линией.
    ready: (state) => state.loaded && state.initialized,
  },
  actions: {
    applySnapshot(value, requestSeq = null) {
      const snapshot = normalizedSnapshot(value);
      const seq = requestSeq ?? ++this._requestSeq;
      if (snapshot.scope !== this.scope && seq < this._scopeRequestSeq) return false;
      if (snapshot.scope === this.scope && snapshot.revision < this.revision) return false;
      this.scope = snapshot.scope;
      this.revision = snapshot.revision;
      this.initialized = snapshot.initialized;
      this.taskIds = snapshot.taskIds;
      this.loaded = true;
      this._scopeRequestSeq = Math.max(this._scopeRequestSeq, seq);
      return true;
    },

    async load(force = false) {
      // Идущий запрос переиспользуем, а не пропускаем: доску и чип сайдбара поднимают
      // разные места одновременно, и «уже гружусь» им обоим означает «дождись того же».
      if (this._inflight) return this._inflight;
      if (this.loaded && !force) return true;
      const epoch = this._epoch;
      const requestSeq = ++this._requestSeq;
      this.loading = true;
      this.error = null;
      this._inflight = (async () => {
        try {
          const snapshot = await api.get('/api/b24/task-seen');
          if (epoch !== this._epoch) return false;
          this.applySnapshot(snapshot, requestSeq);
          return true;
        } catch (error) {
          if (epoch === this._epoch) this.error = error?.message || 'Отметки просмотра недоступны';
          return false;
        } finally {
          if (epoch === this._epoch) this.loading = false;
          this._inflight = null;
        }
      })();
      return this._inflight;
    },

    // baseline: true объявляет присланный список базовым — так доска один раз гасит
    // «новизну» уже существующих задач. Обычный просмотр этот признак не трогает.
    async markSeen(ids, { baseline = false } = {}) {
      const taskIds = [...new Set((Array.isArray(ids) ? ids : [ids]).map(taskKey).filter(Boolean))];
      if (!taskIds.length && !baseline) return true;
      // Уже отмеченное второй раз не шлём: просмотр задачи случается на каждое открытие.
      if (!baseline && this.loaded && taskIds.every((id) => this.taskIds.includes(id))) return true;

      const epoch = this._epoch;
      const requestSeq = ++this._requestSeq;
      this.marking = true;
      this.error = null;
      try {
        const snapshot = await api.post('/api/b24/task-seen', { taskIds, baseline });
        if (epoch !== this._epoch) return false;
        this.applySnapshot(snapshot, requestSeq);
        return true;
      } catch (error) {
        if (epoch === this._epoch) {
          this.error = error?.message || 'Не удалось отметить задачу просмотренной';
        }
        return false;
      } finally {
        if (epoch === this._epoch) this.marking = false;
      }
    },

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
