// Состояние PWA: доступна ли новая версия + установка приложения на устройство.
import { defineStore } from 'pinia';

export const usePwaStore = defineStore('pwa', {
  state: () => ({
    needRefresh: false,
    updater: null,
    updating: false,
    // Событие beforeinstallprompt: браузер согласен установить приложение. Ловим и держим,
    // чтобы показать установку по нашей кнопке. Собственная мини-плашка Chrome на Android
    // показывается по своим эвристикам (может не появиться вовсе) — на неё не рассчитываем.
    // Событие приходит ТОЛЬКО когда выполнены все критерии: https + иконки 192/512 + живой SW.
    installPrompt: null,
    installed: false,
  }),
  getters: {
    // Можно ли предложить установку прямо сейчас.
    canInstall: (s) => !!s.installPrompt && !s.installed,
  },
  actions: {
    // Вызывается из registerSW при появлении новой версии.
    onNeedRefresh(fn) { this.updater = fn; this.needRefresh = true; },

    // Подписка на события установки (звать один раз при старте приложения).
    initInstall() {
      if (typeof window === 'undefined') return;
      // Уже запущено как установленное приложение — предлагать установку незачем.
      if (window.matchMedia?.('(display-mode: standalone)')?.matches) this.installed = true;
      window.addEventListener('beforeinstallprompt', (e) => {
        // preventDefault — чтобы браузер не показал свою плашку вместо нашей кнопки.
        e.preventDefault();
        this.installPrompt = e;
      });
      window.addEventListener('appinstalled', () => {
        this.installed = true;
        this.installPrompt = null;
      });
    },

    // Показать системный диалог установки. Событие одноразовое: после показа его надо выбросить.
    async install() {
      if (!this.installPrompt) return false;
      const e = this.installPrompt;
      this.installPrompt = null;
      try {
        await e.prompt();
        const { outcome } = await e.userChoice;
        return outcome === 'accepted';
      } catch {
        return false;
      }
    },

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
