// Лёгкое состояние общего Inbox для навигации.
// Полный список загружает InboxView; оболочке нужен только счётчик и refetch по SSE.
import { defineStore } from 'pinia';
import { api } from '../shared/api-client.js';
import { sseSubscribe } from '../composables/useSse.js';

export const useInboxStore = defineStore('inbox', {
  state: () => ({
    reviewCount: 0,
    loaded: false,
    loading: false,
    started: false,
    generation: 0,
    refreshQueued: false,
    timer: null,
    unsubscribe: null,
  }),
  actions: {
    async refresh() {
      if (this.loading) {
        this.refreshQueued = true;
        return;
      }
      const generation = this.generation;
      this.loading = true;
      this.refreshQueued = false;
      try {
        const data = await api.get('/api/inbox/summary');
        if (!this.started || generation !== this.generation) return;
        // Fallback сохраняет прежний зрелый счётчик в коротком окне, когда новый
        // web-бандл уже загружен, а server ещё ждёт перезапуска.
        const legacyCount = (Math.max(0, Number(data.newCount) || 0)
          + Math.max(0, Number(data.mixedCount) || 0));
        this.reviewCount = data.reviewCount == null
          ? legacyCount
          : Math.max(0, Number(data.reviewCount) || 0);
        this.loaded = true;
      } catch (error) {
        if (this.started && generation === this.generation
            && error?.data?.error === 'plugin_disabled') this.stop();
      } finally {
        this.loading = false;
        if (this.started && this.refreshQueued) {
          this.refreshQueued = false;
          queueMicrotask(() => this.refresh());
        }
      }
    },
    start() {
      if (!this.started) {
        this.started = true;
        this.generation += 1;
      }
      if (!this.unsubscribe) {
        this.unsubscribe = sseSubscribe((name) => {
          if (name === 'inbox-changed') this.refresh();
        });
      }
      if (!this.timer) {
        // Telegram bundles созревают по времени без нового сообщения; поэтому summary
        // всё равно перепроверяется раз в минуту, хотя GitHub settleMs равен нулю.
        this.timer = setInterval(() => this.refresh(), 60_000);
        this.timer.unref?.();
      }
      this.refresh();
    },
    stop({ clear = true } = {}) {
      if (this.started || this.loading) this.generation += 1;
      this.started = false;
      this.refreshQueued = false;
      this.unsubscribe?.();
      this.unsubscribe = null;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      if (clear) this.clear();
    },
    clear() {
      this.reviewCount = 0;
      this.loaded = false;
    },
  },
});
