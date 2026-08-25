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
    /** Сохранить частичные поля и заменить кеш свежей карточкой из ответа сервера. */
    async update(id, fields) {
      const data = await api.put(`/api/b24/task/${id}`, fields);
      this.details[id] = { data, loadedAt: Date.now() };
      await useBoardStore().load(true);
      return data;
    },
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
    // Чем заполнять модалку запуска: профиль и маршруты опубликованного каталога.
    // Решает сервер — веб не пытается выводить доступность маршрута из профиля.
    async launchOptions(id, profile = '') {
      const query = profile ? `?profile=${encodeURIComponent(profile)}` : '';
      return api.get(`/api/tasks/${id}/launch-options${query}`);
    },
    /** Направить задачу на маршрут с отдельными полями постановки. */
    async launch(id, payload) {
      return api.post(`/api/tasks/${id}/launch`, payload);
    },
    // Исполнитель этапа: override на небегущий этап; '' — снять override этапа
    // (вернётся переопределение задачи, заданное при запуске, или политика профиля).
    async setStageRunner(id, stage, primary) {
      return api.post(`/api/tasks/${id}/runner/override`, { stage, primary });
    },
    // Продолжить ту же попытку. Только по кнопке: оборвавшийся прогон сначала
    // осматривает человек, автоматического resume у интерфейса нет.
    async resume(id) {
      return api.post(`/api/tasks/${id}/resume`);
    },
  },
});
