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
    _timer: null,
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
      this._timer = setInterval(() => this.load(true), ms);
      if (this._timer.unref) this._timer.unref?.();
    },
    // Нужен при потере сессии: иначе поллинг молотит в закрытый API и сыпет 401 в консоль.
    stopPolling() {
      if (this._timer) clearInterval(this._timer);
      this._timer = null;
      this._polling = false;
    },
  },
});
