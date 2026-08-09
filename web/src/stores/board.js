// Кеш доски B24. При переходе в раздел данные показываются мгновенно из кеша,
// обновление идёт в фоне + периодический поллинг (не тормозит навигацию).
import { defineStore } from 'pinia';
import { api } from '../shared/api-client.js';
import { boardActivity, boardTaskIds } from '../shared/board-activity.js';
import { useTaskSeenStore } from './task-seen.js';

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
    // Отметки просмотра лежат на сервере (как избранное), поэтому у окна своей копии нет:
    // открытая на компьютере задача перестаёт быть новой и на планшете.
    activity: (s) => {
      const seen = useTaskSeenStore();
      return boardActivity(s.data, seen.taskIds, { ready: seen.ready });
    },
  },
  actions: {
    async load(force = false) {
      if (this.loading) return;
      if (this.data && !force && this.fresh) return; // свежий кеш — не дёргаем портал
      this.loading = true;
      try {
        const dashboard = await api.get('/api/b24/dashboard');
        this.data = dashboard;
        await this.markBaselineSeen();
        this.loadedAt = Date.now();
        this.error = null;
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    },
    // При первом знакомстве с B24-аккаунтом считаем текущий список базовым. Иначе после
    // обновления интерфейса все давние задачи внезапно выглядели бы новыми.
    async markBaselineSeen() {
      const seen = useTaskSeenStore();
      await seen.load();
      if (!seen.loaded || seen.initialized) return;
      if (!Array.isArray(this.data?.tasks)) return;
      await seen.markSeen(boardTaskIds(this.data.tasks), { baseline: true });
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
