// Состояние обновления PWA: доступна ли новая версия + функция применения.
import { defineStore } from 'pinia';

export const usePwaStore = defineStore('pwa', {
  state: () => ({ needRefresh: false, updater: null }),
  actions: {
    // Вызывается из registerSW при появлении новой версии.
    onNeedRefresh(fn) { this.updater = fn; this.needRefresh = true; },
    // Применить обновление (перезагружает страницу на новую версию).
    doUpdate() { if (this.updater) this.updater(true); },
  },
});
