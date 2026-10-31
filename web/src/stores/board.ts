// Кеш доски B24. При переходе в раздел данные показываются мгновенно из кеша,
// обновление идёт в фоне + периодический поллинг (не тормозит навигацию).
import { defineStore } from 'pinia';
import { api } from '../shared/apiClient.ts';
import { measureChatPerformance } from '../shared/chatPerformance.ts';
import { boardActivity, boardTaskIds } from '../shared/boardActivity.ts';
import { useTaskSeenStore } from './taskSeen.ts';
import { errorMessage } from '../../../shared/lib/errors.ts';
import { isRecord } from '../../../shared/lib/objects.ts';
import { decodeBoardDashboard, isBoardDashboard } from '../shared/boardContracts.ts';
import type { BoardDashboard } from '../shared/boardContracts.ts';

const mirrors = new WeakMap<object, () => void>();
const reads = new WeakMap<object, AbortController>();

export const useBoardStore = defineStore('board', {
  state: () => ({
    data: null as BoardDashboard | null,
    loading: false,
    error: null as string | null,
    loadedAt: 0,
    readAt: 0,
    _polling: false,
    _timer: null as ReturnType<typeof setInterval> | null,
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
     * Смена трекера отменяет старое чтение и удаляет его снимок.
     * Метка не позволяет прежнему зеркалу вернуть данные другого подключения.
     */
    invalidate() {
      reads.get(this)?.abort();
      this.data = null;
      this.error = null;
      this.loading = false;
      this.loadedAt = 0;
      this.readAt = Math.max(Date.now(), this.readAt + 1);
    },
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
      const controller = new AbortController();

      reads.set(this, controller);
      this.loading = true;

      try {
        const raw = await api.get('/api/b24/dashboard', {
          signal: controller.signal,
          retry: false,
        });
        const accepted = measureChatPerformance('board.apply', () => {
          const dashboard = decodeBoardDashboard(raw);

          if (controller.signal.aborted || readAt <= this.readAt) {
            return false;
          }

          this.data = dashboard;
          this.loadedAt = Date.now();
          this.readAt = readAt;
          this.error = null;

          return true;
        });

        if (!accepted) {
          return;
        }

        await this.markBaselineSeen();

        return readAt;
      } catch (e) {
        if (!controller.signal.aborted && readAt >= this.readAt) {
          this.error = errorMessage(e, 'Доска недоступна');
        }
      } finally {
        if (reads.get(this) === controller) {
          reads.delete(this);
          this.loading = false;
        }
      }
    },
    /**
     * Окно карточки регистрирует запрос снимка у главного окна; null возвращает обычное чтение.
     * Функция хранится в WeakMap, а не в сериализуемом состоянии Pinia.
     */
    setMirror(request: (() => void) | null) {
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
    applySnapshot(data: unknown, readAt: number) {
      if (!isBoardDashboard(data)
        || !Number.isFinite(readAt) || readAt <= this.readAt) {
        return;
      }

      this.data = data;
      this.readAt = readAt;
      this.loadedAt = Date.now();
      this.error = null;
    },
    /**
     * Первая загрузка объявляет прежние задачи базовым списком владельца.
     * Пока базовая линия неизвестна, давние задачи не объявляются новыми.
     */
    async markBaselineSeen() {
      const seen = useTaskSeenStore();

      await seen.load();

      if (!seen.loaded || seen.initialized) {
        return;
      }
      if (!Array.isArray(this.data?.tasks)) {
        return;
      }

      await seen.markSeen(boardTaskIds(this.data.tasks), { baseline: true });
    },
    /**
     * Фоновый опрос по-прежнему запускается один раз для экземпляра доски.
     * Таймер остаётся в прежнем state, чтобы не менять контракт его очистки.
     */
    startPolling(ms = 45000) {
      if (this._polling) {
        return;
      }

      this._polling = true;
      this.load();
      this._timer = setInterval(() => this.load(true), ms);

      const timer: unknown = this._timer;

      if (isRecord(timer) && typeof timer.unref === 'function') {
        timer.unref();
      }
    },
    /**
     * Потеря сессии снимает и таймер, и ожидание текущего чтения в общей очереди.
     * Отменённый запрос не обновляет доску и не оставляет повтор после остановки.
     */
    stopPolling() {
      reads.get(this)?.abort();

      if (this._timer) {
        clearInterval(this._timer);
      }

      this._timer = null;
      this._polling = false;
    },
  },
});
