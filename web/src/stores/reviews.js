// Канонический снимок раздела «Ревью». SSE здесь — только сигнал перечитать сервер:
// счётчик нельзя инкрементить событием, иначе повторы, потеря события и две вкладки разъедутся.
import { defineStore } from 'pinia';
import { api } from '../shared/api-client.js';
import { sseSubscribe } from '../composables/useSse.js';
import {
  emptyReviewsSummary,
  normalizeReviewSummary,
  normalizeReviewsSnapshot,
  refreshReviewsFromSignal,
  reviewChipModel,
} from '../shared/review-chip.js';

let unsubscribeSse = null;

function pathId(id) {
  return encodeURIComponent(String(id));
}

export const useReviewsStore = defineStore('reviews', {
  state: () => ({
    pulls: [],
    repositories: [],
    summary: emptyReviewsSummary(),
    fullLoaded: false,
    loading: false,
    summaryLoading: false,
    syncing: false,
    error: null,
    loadedAt: 0,
    busy: {},
    _watching: false,
    _epoch: 0,
    _requestSeq: 0,
    _appliedFullSeq: 0,
    _appliedSummarySeq: 0,
    _fullPending: 0,
    _summaryPending: 0,
    _refreshingInitialFull: false,
  }),
  getters: {
    chip: (state) => reviewChipModel(state.summary, state.pulls),
    projects: (state) => {
      const rows = new Map();
      for (const repository of state.repositories) {
        const id = String(repository.projectId || '');
        if (!id || rows.has(id)) continue;
        rows.set(id, { id, label: id });
      }
      for (const pull of state.pulls) {
        const id = String(pull.projectId || '');
        if (!id || rows.has(id)) continue;
        rows.set(id, { id, label: pull.projectTitle || id });
      }
      return [...rows.values()].sort((a, b) => a.label.localeCompare(b.label, 'ru'));
    },
    isBusy: (state) => (key) => !!state.busy[key],
  },
  actions: {
    _beginRequest() {
      this._requestSeq += 1;
      return { seq: this._requestSeq, epoch: this._epoch };
    },
    _canApplyFull(request) {
      return request.epoch === this._epoch && request.seq >= this._appliedFullSeq;
    },
    _canApplySummary(request) {
      return request.epoch === this._epoch && request.seq >= this._appliedSummarySeq;
    },
    _applySummary(summary, pulls, request) {
      if (!this._canApplySummary(request)) return false;
      this.summary = normalizeReviewSummary(summary, pulls);
      this._appliedSummarySeq = request.seq;
      return true;
    },
    async load({ silent = false } = {}) {
      const request = this._beginRequest();
      this._fullPending += 1;
      this.loading = true;
      if (!silent) this.error = null;
      try {
        const payload = await api.get('/api/reviews');
        const snapshot = normalizeReviewsSnapshot(payload);
        if (this._canApplyFull(request)) {
          this.pulls = snapshot.pulls;
          this.repositories = snapshot.repositories;
          this.fullLoaded = true;
          this.loadedAt = Date.now();
          this.error = null;
          this._appliedFullSeq = request.seq;
        }
        this._applySummary(snapshot.summary, snapshot.pulls, request);
        return payload;
      } catch (error) {
        if (this._canApplyFull(request) && !silent) {
          this.error = error?.message || 'Не удалось загрузить ревью';
        }
        throw error;
      } finally {
        if (request.epoch === this._epoch) {
          this._fullPending = Math.max(0, this._fullPending - 1);
          this.loading = this._fullPending > 0;
        }
      }
    },
    async loadSummary({ silent = true } = {}) {
      const request = this._beginRequest();
      this._summaryPending += 1;
      this.summaryLoading = true;
      if (!silent) this.error = null;
      try {
        const summary = await api.get('/api/reviews/summary');
        this._applySummary(summary, this.pulls, request);
        return summary;
      } catch (error) {
        if (this._canApplySummary(request) && !silent) {
          this.error = error?.message || 'Не удалось обновить чип ревью';
        }
        throw error;
      } finally {
        if (request.epoch === this._epoch) {
          this._summaryPending = Math.max(0, this._summaryPending - 1);
          this.summaryLoading = this._summaryPending > 0;
        }
      }
    },
    async onSse(name) {
      const epoch = this._epoch;
      const refreshInitialFull = ['hello', 'reviews-change'].includes(name)
        && !this.fullLoaded
        && this._fullPending > 0
        && !this._refreshingInitialFull;
      if (refreshInitialFull) this._refreshingInitialFull = true;
      try {
        await refreshReviewsFromSignal(name, {
          fullLoaded: this.fullLoaded,
          loadFull: () => this.load({ silent: true }),
          loadSummary: () => this.loadSummary({ silent: true }),
        });
      } catch { /* следующий SSE/reconnect повторит, а прошлый снимок остаётся видимым */ }
      if (refreshInitialFull && epoch === this._epoch) {
        // Сигнал мог прийти между чтением state сервером и ответом первого full GET.
        // Лёгкая сводка уже знает о новой revision, поэтому дочитываем новый полный
        // снимок. Его больший request seq не даст позднему старому GET вернуть карточки назад.
        try {
          await this.load({ silent: true });
        } catch { /* следующий SSE/reconnect повторит */ }
      }
      this._refreshingInitialFull = false;
    },
    start() {
      if (this._watching) return;
      this._watching = true;
      unsubscribeSse = sseSubscribe((name) => { this.onSse(name); });
      this.loadSummary({ silent: true }).catch(() => {});
    },
    // AppShell размонтируется при logout: убираем подписчика и стираем недоверенные тексты
    // из памяти вкладки. Серверная история при этом не удаляется.
    stop() {
      unsubscribeSse?.();
      unsubscribeSse = null;
      this._watching = false;
      this.clear();
    },
    clear() {
      this._epoch += 1;
      this._requestSeq = 0;
      this._appliedFullSeq = 0;
      this._appliedSummarySeq = 0;
      this._fullPending = 0;
      this._summaryPending = 0;
      this._refreshingInitialFull = false;
      this.pulls = [];
      this.repositories = [];
      this.summary = emptyReviewsSummary();
      this.fullLoaded = false;
      this.loading = false;
      this.summaryLoading = false;
      this.syncing = false;
      this.error = null;
      this.loadedAt = 0;
      this.busy = {};
    },
    _setBusy(key, value) {
      if (value) this.busy = { ...this.busy, [key]: true };
      else {
        const { [key]: _, ...rest } = this.busy;
        this.busy = rest;
      }
    },
    async _afterMutation(payload) {
      if (payload?.pulls) {
        const request = this._beginRequest();
        const snapshot = normalizeReviewsSnapshot(payload);
        if (this._canApplyFull(request)) {
          this.pulls = snapshot.pulls;
          this.repositories = snapshot.repositories;
          this.fullLoaded = true;
          this.loadedAt = Date.now();
          this._appliedFullSeq = request.seq;
        }
        this._applySummary(snapshot.summary, snapshot.pulls, request);
        return;
      }
      if (this.fullLoaded) await this.load({ silent: true });
      else await this.loadSummary({ silent: true });
    },
    async _mutate(key, request) {
      if (this.busy[key]) return null;
      const epoch = this._epoch;
      this._setBusy(key, true);
      this.error = null;
      try {
        const result = await request();
        if (epoch !== this._epoch) return result;
        await this._afterMutation(result);
        return result;
      } catch (error) {
        if (epoch === this._epoch) this.error = error?.message || 'Действие не выполнено';
        throw error;
      } finally {
        if (epoch === this._epoch) this._setBusy(key, false);
      }
    },
    async sync() {
      if (this.syncing) return null;
      const epoch = this._epoch;
      this.syncing = true;
      this.error = null;
      try {
        const result = await api.post('/api/reviews/sync');
        if (epoch !== this._epoch) return result;
        await this._afterMutation(result);
        return result;
      } catch (error) {
        if (epoch === this._epoch) this.error = error?.message || 'Не удалось проверить GitHub';
        throw error;
      } finally {
        if (epoch === this._epoch) this.syncing = false;
      }
    },
    markRead(pullId) {
      const id = pathId(pullId);
      return this._mutate(`read:${pullId}`, () => api.post(`/api/reviews/pulls/${id}/read`));
    },
    analyze(pullId, remarkId = null) {
      const id = pathId(pullId);
      return this._mutate(
        `analyze:${pullId}`,
        () => api.post(
          `/api/reviews/pulls/${id}/analyze`,
          remarkId == null ? {} : { remarkId: String(remarkId) },
        ),
      );
    },
    setScope(pullId, items) {
      const id = pathId(pullId);
      return this._mutate(
        `scope:${pullId}`,
        () => api.put(`/api/reviews/pulls/${id}/scope`, { items: Array.isArray(items) ? items : [] }),
      );
    },
    run(pullId) {
      const id = pathId(pullId);
      return this._mutate(`run:${pullId}`, () => api.post(`/api/reviews/pulls/${id}/run`));
    },
    accept(runId) {
      const id = pathId(runId);
      return this._mutate(`accept:${runId}`, () => api.post(`/api/reviews/runs/${id}/accept`));
    },
    abandon(runId) {
      const id = pathId(runId);
      return this._mutate(
        `abandon:${runId}`,
        () => api.post(`/api/reviews/runs/${id}/abandon`, {}),
      );
    },
    publish(runId, { retryUnknown = false } = {}) {
      const id = pathId(runId);
      return this._mutate(
        `publish:${runId}`,
        () => (
          retryUnknown
            ? api.post(`/api/reviews/runs/${id}/publish`, { retryUnknown: true })
            : api.post(`/api/reviews/runs/${id}/publish`)
        ),
      );
    },
    cleanup(runId) {
      const id = pathId(runId);
      return this._mutate(
        `cleanup:${runId}`,
        () => api.del(`/api/reviews/runs/${id}/environment`),
      );
    },
  },
});
