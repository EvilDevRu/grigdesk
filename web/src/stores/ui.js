// Глобальное состояние UI: какая задача открыта в модалке (одна на всё приложение).
import { defineStore } from 'pinia';

export const useUiStore = defineStore('ui', {
  state: () => ({ taskId: null }),
  actions: {
    openTask(id) { this.taskId = String(id); },
    close() { this.taskId = null; },
  },
});
