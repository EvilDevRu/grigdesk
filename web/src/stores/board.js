// Кеш доски B24. При переходе в раздел данные показываются мгновенно из кеша,
// обновление идёт в фоне + периодический поллинг (не тормозит навигацию).
import { defineStore } from 'pinia';
import { api } from '../shared/api-client.js';
import { boardActivity, boardTaskIds } from '../shared/board-activity.js';

const SEEN_TASKS_KEY = 'cockpit-board-seen-tasks-v1';

function readSeenSnapshot() {
  if (typeof localStorage === 'undefined') return null;
  try {
    const value = JSON.parse(localStorage.getItem(SEEN_TASKS_KEY) || 'null');
    if (!value || !Array.isArray(value.taskIds)) return null;
    return {
      userId: String(value.userId ?? ''),
      taskIds: value.taskIds.map(String),
    };
  } catch {
    return null;
  }
}

function saveSeenSnapshot(snapshot) {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(SEEN_TASKS_KEY, JSON.stringify(snapshot)); }
  catch { /* localStorage может быть закрыт политикой браузера — сессия всё равно работает */ }
}

export const useBoardStore = defineStore('board', {
  state: () => ({
    data: null,
    loading: false,
    error: null,
    loadedAt: 0,
    _polling: false,
    _timer: null,
    seenSnapshot: readSeenSnapshot(),
  }),
  getters: {
    fresh: (s) => Date.now() - s.loadedAt < 20000,
    activity: (s) => boardActivity(s.data, s.seenSnapshot?.taskIds),
  },
  actions: {
    async load(force = false) {
      if (this.loading) return;
      if (this.data && !force && this.fresh) return; // свежий кеш — не дёргаем портал
      this.loading = true;
      try {
        const dashboard = await api.get('/api/b24/dashboard');
        this.data = dashboard;
        // При первом запуске функции считаем текущий список базовым. Иначе после
        // обновления интерфейса все давние задачи внезапно выглядели бы новыми.
        if (!this.seenSnapshot
          || this.seenSnapshot.userId !== String(dashboard?.userId ?? '')) {
          this.markTasksSeen();
        }
        this.loadedAt = Date.now();
        this.error = null;
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    },
    markTasksSeen() {
      if (!Array.isArray(this.data?.tasks)) return;
      const snapshot = {
        userId: String(this.data?.userId ?? ''),
        taskIds: boardTaskIds(this.data.tasks),
      };
      this.seenSnapshot = snapshot;
      saveSeenSnapshot(snapshot);
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
