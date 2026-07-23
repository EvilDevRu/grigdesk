// Кеш доски B24. При переходе в раздел данные показываются мгновенно из кеша,
// обновление идёт в фоне + периодический поллинг (не тормозит навигацию).
import { defineStore } from 'pinia';
import { api } from '../shared/api-client.js';

export const useBoardStore = defineStore('board', {
  state: () => ({
    data: null,
    loading: false,
    error: null,
    loadedAt: 0,
    _polling: false,
  }),
  getters: {
    fresh: (s) => Date.now() - s.loadedAt < 20000,
  },
  actions: {
    async load(force = false) {
      if (this.loading) return;
      if (this.data && !force && this.fresh) return; // свежий кеш — не дёргаем портал
      this.loading = true;
      try {
        this.data = await api.get('/api/b24/dashboard');
        this.loadedAt = Date.now();
        this.error = null;
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    },
    // Фоновый поллинг — запускается один раз на всё приложение.
    startPolling(ms = 45000) {
      if (this._polling) return;
      this._polling = true;
      this.load();
      const t = setInterval(() => this.load(true), ms);
      if (t.unref) t.unref?.();
    },
  },
});
