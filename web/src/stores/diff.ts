// Глобальный модал дифа: открывается с любой страницы (доска, конвейер, модалка задачи).
import { defineStore } from 'pinia';

export const useDiffStore = defineStore('diff', {
  state: (): { open: boolean; taskId: string | null } => ({ open: false, taskId: null }),
  actions: {
    openFor(id: unknown): void {
      this.taskId = String(id);
      this.open = true;
    },
    close(): void {
      this.open = false;
    },
  },
});
