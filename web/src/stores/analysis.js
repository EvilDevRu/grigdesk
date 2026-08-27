// Кеш триажа задач: оценки сложности/риска для бейджей доски + статусы очереди.
// Поллинг адаптивный: пока есть queued/running — часто (5с), иначе редко (60с).
import { defineStore } from 'pinia';
import { api } from '../shared/api-client.js';
import { useTaskShelfStore } from './task-shelf.js';
import { usePluginsStore } from './plugins.js';

export const useAnalysisStore = defineStore('analysis', {
  state: () => ({
    byTask: {},   // id → { task, analysis?, status? }
    loadedAt: 0,
    error: null,
    _timer: null,
  }),
  getters: {
    active: (s) => Object.values(s.byTask).some((r) => ['queued', 'running'].includes(r.status?.state)),
    // Требуют внимания человека: прерваны рестартом или упали. Авто-перезапуска нет намеренно.
    issues: (s) => Object.values(s.byTask)
      .filter((r) => ['interrupted', 'failed'].includes(r.status?.state))
      .sort((a, b) => b.task - a.task),
  },
  actions: {
    async load() {
      try {
        const rows = await api.get('/api/analysis');
        const map = {};
        for (const r of rows) map[r.task] = r;
        this.byTask = map;
        this.loadedAt = Date.now();
        this.error = null;
      } catch (error) {
        // Прошлый снимок сохраняем: временный отказ не превращается в ложное событие.
        this.error = error?.message || 'Триаж недоступен';
      }
      this._schedule();
    },
    _schedule() {
      if (this._timer) clearTimeout(this._timer);
      this._timer = setTimeout(() => this.load(), this.active ? 5000 : 60000);
    },
    startPolling() {
      if (this._timer) return;
      this.load();
    },
    /** Поставить задачу в очередь; оптимистично показываем queued сразу. */
    async analyze(id) {
      const r = await api.post(`/api/tasks/${id}/analyze`);
      const queuedAt = new Date().toISOString();
      this.byTask = {
        ...this.byTask,
        [id]: {
          ...(this.byTask[id] || { task: Number(id) }),
          status: { task: Number(id), state: 'queued', queuedAt },
        },
      };
      const plugins = usePluginsStore();
      if (plugins.enabled('shelf')
        && plugins.byId('shelf')?.values?.autoAddOnAnalysis !== false) {
        try { await useTaskShelfStore().autoAdd(id); } catch { /* запуск оценки уже принят */ }
      }
      this._schedule();
      return r;
    },
    /** Деталь (оценки + разведнота + протухание) — для модалки, без кеша. */
    async detail(id) {
      return api.get(`/api/analysis/${id}`);
    },
    /** Скрыть прерванный/упавший статус (решение «не перезапускать»). */
    async dismiss(id) {
      await api.del(`/api/analysis/${id}/status`);
      const { [id]: _, ...rest } = this.byTask;
      const row = this.byTask[id];
      // Оценка (если есть) остаётся — убираем только статус.
      this.byTask = row?.analysis ? { ...rest, [id]: { task: row.task, analysis: row.analysis } } : rest;
    },
  },
});
