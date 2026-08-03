// Глобальное состояние UI: какая задача открыта в модалке (одна на всё приложение).
import { defineStore } from 'pinia';

export const useUiStore = defineStore('ui', {
  state: () => ({ taskId: null, launchRequested: false }),
  actions: {
    openTask(id) { this.launchRequested = false; this.taskId = String(id); },
    openTaskLaunch(id) { this.launchRequested = true; this.taskId = String(id); },
    consumeTaskLaunch() { this.launchRequested = false; },
    close() { this.taskId = null; this.launchRequested = false; },
  },
});
