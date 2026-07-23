// Нагрузка «мозга» (CPU/RAM) — частый лёгкий поллинг для индикатора в шапке.
import { defineStore } from 'pinia';
import { api } from '../shared/api-client.js';

export const useSystemStore = defineStore('system', {
  state: () => ({ data: null, _polling: false }),
  actions: {
    async load() {
      try { this.data = await api.get('/api/system'); }
      catch { this.data = null; }
    },
    startPolling(ms = 3000) {
      if (this._polling) return;
      this._polling = true;
      this.load();
      const t = setInterval(() => this.load(), ms);
      if (t.unref) t.unref?.();
    },
  },
});
