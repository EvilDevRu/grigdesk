// Кеш доски B24. При переходе в раздел данные показываются мгновенно из кеша,
// обновление идёт в фоне + периодический поллинг (не тормозит навигацию).
import { defineStore } from 'pinia';
import { api } from '../shared/apiClient.ts';
import { boardActivity, boardTaskIds } from '../shared/board-activity.js';
import { useTaskSeenStore } from './task-seen.js';

const mirrors = new WeakMap();

export const useBoardStore = defineStore('board', {
  state: () => ({
    data: null,
    loading: false,
    error: null,
    loadedAt: 0,
    readAt: 0,
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
    /**
     * Окно карточки не опрашивает дашборд: обычная загрузка просит снимок у главного окна.
     * Принудительная загрузка после своего действия читает доску как прежде.
     * Время начала GET определяет свежесть: поздний ответ не отменяет более новый снимок.
     * Возвращается метка только принятого ответа, чтобы relay не повторял чужие данные.
     */
    async load(force = false) {
      const mirror = mirrors.get(this);

      if (mirror && !force) {
        mirror();

        return;
      }
      if (this.loading || (this.data && !force && this.fresh)) {
        return;
      }

      const readAt = Math.max(Date.now(), this.readAt + 1);

      this.loading = true;

      try {
        const dashboard = await api.get('/api/b24/dashboard');

        if (readAt <= this.readAt) {
          return;
        }

        this.data = dashboard;
        this.loadedAt = Date.now();
        this.readAt = readAt;
        this.error = null;
        await this.markBaselineSeen();

        return readAt;
      } catch (e) {
        if (readAt >= this.readAt) {
          this.error = e.message;
        }
      } finally {
        this.loading = false;
      }
    },
    /**
     * Окно карточки регистрирует запрос снимка у главного окна; null возвращает обычное чтение.
     * Функция хранится в WeakMap, а не в сериализуемом состоянии Pinia.
     */
    setMirror(request) {
      if (request) {
        mirrors.set(this, request);
      }
      else {
        mirrors.delete(this);
      }
    },
    /**
     * Снимок другого окна заменяет данные доски, только если он прочитан позже показанного.
     * Не объект или не более свежий снимок прежние данные не трогает.
     */
    applySnapshot(data, readAt) {
      if (!data || typeof data !== 'object' || Array.isArray(data)
        || !Number.isFinite(readAt) || readAt <= this.readAt) {
        return;
      }

      this.data = data;
      this.readAt = readAt;
      this.loadedAt = Date.now();
      this.error = null;
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
