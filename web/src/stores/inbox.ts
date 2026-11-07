// Лёгкое состояние общего Inbox для навигации: оболочке нужен только счётчик
// очереди. Полный список читает сам раздел, а стор хранит снимок — запрос, таймер
// и подписка на события живут в операциях (web/src/actions/inbox/).
//
// Поколение здесь не украшение: ответ, начатый до остановки, не должен вернуть
// счётчик на экран уже выключенного плагина.
import { defineStore } from 'pinia';

export interface InboxStoreState {
  reviewCount: number;
  loaded: boolean;
  loading: boolean;
  started: boolean;
  generation: number;
  refreshQueued: boolean;
}

export const useInboxStore = defineStore('inbox', {
  state: (): InboxStoreState => ({
    reviewCount: 0,
    loaded: false,
    loading: false,
    started: false,
    generation: 0,
    refreshQueued: false,
  }),

  actions: {
    setLoading(loading: boolean) {
      this.loading = loading;
    },

    setRefreshQueued(queued: boolean) {
      this.refreshQueued = queued;
    },

    setReviewCount(count: number) {
      this.reviewCount = Math.max(0, count);
      this.loaded = true;
    },

    /**
     * Начало наблюдения. Поколение растёт только на первом запуске: повторный вызов
     * из другого места оболочки не должен отменять уже идущий ответ.
     */
    start() {
      if (!this.started) {
        this.started = true;
        this.generation += 1;
      }
    },

    /**
     * Остановка. Поколение растёт, если было что останавливать: незавершённый ответ
     * после этого своё значение уже не покажет.
     */
    stop() {
      if (this.started || this.loading) {
        this.generation += 1;
      }

      this.started = false;
      this.refreshQueued = false;
    },

    clear() {
      this.reviewCount = 0;
      this.loaded = false;
    },
  },
});

export default useInboxStore;
