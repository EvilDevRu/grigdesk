// Глобальный модал дифа: открывается с любой страницы (доска, конвейер, модалка задачи).
import { defineStore } from 'pinia';

export const useDiffStore = defineStore('diff', {
  state: () => ({ open: false, taskId: null }),
  actions: {
    openFor(id) { this.taskId = String(id); this.open = true; },
    close() { this.open = false; },
  },
});
