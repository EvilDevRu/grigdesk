// Кеш деталей задач B24 + действия (таймер/завершить/коммент) через кокпит.
// Цель — управлять задачей НЕ выходя в портал (исключить сторонние ресурсы).
import { defineStore } from 'pinia';
import { api } from '../shared/api-client.js';
import { useBoardStore } from './board.js';

export const useTasksStore = defineStore('tasks', {
  state: () => ({ details: {} }), // id → { data, loadedAt }
  actions: {
    /** Детали задачи (кеш 30с; force — принудительно). */
    async load(id, force = false) {
      const cached = this.details[id];
      if (cached && !force && Date.now() - cached.loadedAt < 30000) return cached.data;
      const data = await api.get(`/api/b24/task/${id}`);
      this.details[id] = { data, loadedAt: Date.now() };
      return data;
    },
    title(id) { return this.details[id]?.data?.title || null; },
    /** Таймер: start|pause|stop. После — обновляем доску (состояние таймера). */
    async timer(id, action) {
      await api.post(`/api/b24/task/${id}/timer/${action}`);
      await useBoardStore().load(true);
    },
    async complete(id) {
      await api.post(`/api/b24/task/${id}/complete`);
      await useBoardStore().load(true);
    },
    async comment(id, text) {
      await api.post(`/api/b24/task/${id}/comment`, { text });
    },
  },
});
