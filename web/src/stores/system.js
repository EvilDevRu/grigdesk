// Нагрузка «мозга» (CPU/RAM) — частый лёгкий поллинг для индикатора в шапке.
import { defineStore } from 'pinia';
import { api } from '../shared/api-client.js';

export const useSystemStore = defineStore('system', {
  state: () => ({ data: null, _polling: false, _timer: null }),
  actions: {
    async load() {
      try { this.data = await api.get('/api/system'); }
      catch { this.data = null; }
    },
    startPolling(ms = 3000) {
      if (this._polling) return;
      this._polling = true;
      this.load();
      this._timer = setInterval(() => this.load(), ms);
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
