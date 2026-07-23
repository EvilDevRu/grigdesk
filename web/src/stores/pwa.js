// Состояние обновления PWA: доступна ли новая версия + функция применения.
import { defineStore } from 'pinia';

export const usePwaStore = defineStore('pwa', {
  state: () => ({ needRefresh: false, updater: null, updating: false }),
  actions: {
    // Вызывается из registerSW при появлении новой версии.
    onNeedRefresh(fn) { this.updater = fn; this.needRefresh = true; },
    // Применить обновление. Перезагрузка — строго по событию controllerchange
    // (обработчик в main.js), НЕ по таймеру: преждевременный reload прерывает
    // установку нового воркера и таб зацикливается на загрузке.
    async doUpdate() {
      if (this.updating) return;
      this.updating = true;
      let reg = null;
      try { reg = await navigator.serviceWorker?.getRegistration(); } catch { /* нет SW */ }
      if (reg?.waiting) {
        // Есть ждущий воркер → активируем его; controllerchange перезагрузит страницу.
        this.updater?.(true);
      } else {
        // Ждущего воркера нет (уже активен / SW недоступен) — просто обновляем страницу.
        window.location.reload();
      }
    },
  },
});
