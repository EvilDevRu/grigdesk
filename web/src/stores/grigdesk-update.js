import { defineStore } from 'pinia';
import { api } from '../shared/apiClient.ts';
import { ACTIVE_UPDATE_STATES, grigDeskUpdateTone } from '../shared/grigdesk-update.js';

export * from '../shared/grigdesk-update.js';

let pollTimer = null;
let statusTimer = null;

export const useGrigDeskUpdateStore = defineStore('grigdesk-update', {
  state: () => ({
    status: null,
    loading: false,
    checking: false,
    actionBusy: false,
    error: '',
    initialized: false,
  }),
  getters: {
    tone: (state) => grigDeskUpdateTone(state.status),
    active: (state) => ACTIVE_UPDATE_STATES.has(state.status?.job?.status),
  },
  actions: {
    start() {
      this.load();
      if (statusTimer) return;
      // Редкая локальная страховка: git checkout может измениться без серверного SSE.
      // Это отдельно от трёхсекундного CPU/RAM polling и не делает remote-проверок.
      statusTimer = setInterval(() => { this.load({ quiet: true }); }, 60_000);
    },

    async load({ quiet = false } = {}) {
      if (!quiet) this.loading = true;
      try {
        this.status = await api.get('/api/system/version');
        this.error = '';
        this.initialized = true;
        if (this.active) this.startJobPolling();
        return this.status;
      } catch (error) {
        if (!quiet) this.error = error.data?.message || error.message;
        return null;
      } finally {
        if (!quiet) this.loading = false;
      }
    },

    async check() {
      if (this.checking) return this.status;
      this.checking = true;
      this.error = '';
      try {
        this.status = await api.post('/api/system/version/check', {});
        return this.status;
      } catch (error) {
        this.error = error.data?.message || error.message;
        return null;
      } finally { this.checking = false; }
    },

    async applyCheckout() {
      const sha = this.status?.checkout?.sha;
      if (!sha || this.actionBusy) return null;
      return this._start('/api/system/apply', { expectedCheckoutSha: sha, allowDirty: false });
    },

    async installRelease() {
      const tag = this.status?.latest?.tag;
      const sha = this.status?.checkout?.sha;
      if (!tag || !sha || this.actionBusy) return null;
      return this._start('/api/system/update', { targetTag: tag, expectedCheckoutSha: sha });
    },

    async _start(endpoint, body) {
      this.actionBusy = true;
      this.error = '';
      try {
        const result = await api.post(endpoint, body);
        this.status = { ...this.status, job: result.job };
        this.startJobPolling();
        return result.job;
      } catch (error) {
        this.error = error.data?.message || error.message;
        await this.load({ quiet: true });
        return null;
      } finally { this.actionBusy = false; }
    },

    startJobPolling() {
      if (pollTimer) return;
      pollTimer = setInterval(() => { this.pollJob(); }, 1000);
    },

    async pollJob() {
      try {
        const result = await api.get('/api/system/update-job');
        if (this.status) this.status = { ...this.status, job: result.job };
        else await this.load({ quiet: true });
        if (!ACTIVE_UPDATE_STATES.has(result.job?.status)) {
          this.stopJobPolling();
          await this.load({ quiet: true });
        }
        return result.job;
      } catch {
        // Рестарт сервера — ожидаемая краткая сетевая ошибка. Polling остаётся жить и
        // восстановит progress/result после возвращения API.
        return null;
      }
    },

    stopJobPolling() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    },

    stop() {
      this.stopJobPolling();
      if (statusTimer) clearInterval(statusTimer);
      statusTimer = null;
    },
  },
});
