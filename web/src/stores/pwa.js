// Состояние PWA: обновление, установка и локальные возможности текущего устройства.
import { defineStore } from 'pinia';
import { ensureNotifyPermission, notify } from '../shared/notify.js';

const WAKE_LOCK_KEY = 'cockpit-screen-wake-lock';

// WakeLockSentinel — браузерный объект, его нельзя класть в реактивный state Pinia.
// Держим дескриптор и незавершённый запрос рядом со стором: приложение создаёт один Pinia,
// а initWakeLock() защищён от повторной подписки.
let wakeLockSentinel = null;
let wakeLockRequest = null;

function savedWakeLockEnabled() {
  try { return localStorage.getItem(WAKE_LOCK_KEY) === '1'; }
  catch { return false; }
}

function saveWakeLockEnabled(enabled) {
  try { localStorage.setItem(WAKE_LOCK_KEY, enabled ? '1' : '0'); }
  catch { /* приватный режим может запрещать localStorage — до закрытия настройка всё равно действует */ }
}

function wakeLockSupported() {
  return typeof navigator !== 'undefined' && typeof navigator.wakeLock?.request === 'function';
}

function notificationSupported() {
  return typeof window !== 'undefined'
    && window.isSecureContext !== false
    && 'Notification' in window;
}

function notificationPermission() {
  return notificationSupported() ? window.Notification.permission : 'unsupported';
}

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
    // Эта настройка намеренно локальная: планшет не должен заставлять экран компьютера
    // тоже гореть. Действует на всё SPA, потому что инициализируется в main.js, а не во view.
    wakeLockEnabled: savedWakeLockEnabled(),
    wakeLockSupported: wakeLockSupported(),
    wakeLockActive: false,
    wakeLockBusy: false,
    wakeLockError: '',
    wakeLockInitialized: false,
    // Разрешение браузера нельзя спрашивать на старте: мобильные браузеры принимают
    // запрос только из явного действия пользователя. Кнопка живёт в настройках устройства.
    notificationSupported: notificationSupported(),
    notificationPermission: notificationPermission(),
    notificationBusy: false,
    notificationError: '',
    notificationInitialized: false,
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

    // Поднимаем Screen Wake Lock один раз на всё приложение. При уходе в фон браузер
    // освобождает его сам; visibilitychange возвращает блокировку после открытия PWA.
    initWakeLock() {
      if (this.wakeLockInitialized || typeof document === 'undefined') return;
      this.wakeLockInitialized = true;
      this.wakeLockSupported = wakeLockSupported();
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this.wakeLockEnabled) {
          this.acquireWakeLock();
        } else if (document.visibilityState !== 'visible') {
          // Не ждём, когда конкретный браузер пришлёт release: так быстрый возврат
          // не примет старый sentinel за ещё действующую блокировку.
          this.releaseWakeLock();
        }
      });
      if (this.wakeLockEnabled) this.acquireWakeLock();
    },

    async setWakeLockEnabled(enabled) {
      this.wakeLockEnabled = !!enabled;
      this.wakeLockError = '';
      saveWakeLockEnabled(this.wakeLockEnabled);
      if (this.wakeLockEnabled) return this.acquireWakeLock();
      await this.releaseWakeLock();
      return true;
    },

    async acquireWakeLock() {
      if (!this.wakeLockEnabled) return false;
      this.wakeLockSupported = wakeLockSupported();
      if (!this.wakeLockSupported) {
        this.wakeLockActive = false;
        return false;
      }
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return false;
      if (wakeLockSentinel && !wakeLockSentinel.released) {
        this.wakeLockActive = true;
        return true;
      }
      if (wakeLockRequest) return wakeLockRequest;

      this.wakeLockBusy = true;
      this.wakeLockError = '';
      wakeLockRequest = (async () => {
        try {
          const lock = await navigator.wakeLock.request('screen');
          // Пользователь мог выключить настройку или свернуть приложение, пока системный
          // запрос был в полёте. Не оставляем поздно выданную блокировку жить в фоне.
          if (!this.wakeLockEnabled
              || (typeof document !== 'undefined' && document.visibilityState !== 'visible')) {
            await lock.release();
            return false;
          }
          wakeLockSentinel = lock;
          this.wakeLockActive = !lock.released;
          lock.addEventListener('release', () => {
            if (wakeLockSentinel === lock) wakeLockSentinel = null;
            this.wakeLockActive = false;
          }, { once: true });
          return this.wakeLockActive;
        } catch (error) {
          this.wakeLockActive = false;
          if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return false;
          this.wakeLockError = error?.name === 'NotAllowedError'
            ? 'Система не разрешила удерживать экран. Проверь режим энергосбережения.'
            : 'Не удалось удерживать экран включённым.';
          return false;
        } finally {
          this.wakeLockBusy = false;
          wakeLockRequest = null;
        }
      })();
      return wakeLockRequest;
    },

    async releaseWakeLock() {
      const lock = wakeLockSentinel;
      wakeLockSentinel = null;
      this.wakeLockActive = false;
      if (lock && !lock.released) {
        try { await lock.release(); }
        catch { /* браузер мог освободить блокировку одновременно с нами */ }
      }
    },

    // После возврата из системных настроек перечитываем permission: пользователь мог
    // разрешить или запретить уведомления снаружи PWA.
    initNotifications() {
      if (this.notificationInitialized || typeof document === 'undefined') return;
      this.notificationInitialized = true;
      this.syncNotificationPermission();
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.syncNotificationPermission();
      });
    },

    syncNotificationPermission() {
      this.notificationSupported = notificationSupported();
      this.notificationPermission = notificationPermission();
      if (this.notificationPermission === 'granted') this.notificationError = '';
    },

    // Вызывается только кнопкой в настройках — иначе Chrome/Android молча блокирует prompt.
    async requestNotificationPermission() {
      this.notificationBusy = true;
      this.notificationError = '';
      try {
        const granted = await ensureNotifyPermission();
        this.syncNotificationPermission();
        if (!granted) {
          this.notificationError = this.notificationPermission === 'denied'
            ? 'Оповещения заблокированы. Разреши их в системных настройках приложения или браузера.'
            : 'Браузер не выдал разрешение на оповещения.';
        }
        return granted;
      } finally {
        this.notificationBusy = false;
      }
    },

    async testNotification() {
      this.notificationError = '';
      if (this.notificationPermission !== 'granted'
          && !(await this.requestNotificationPermission())) return false;
      this.notificationBusy = true;
      try {
        const shown = await notify(
          'Оповещения работают',
          'Кокпит сообщит, когда агент ответит или работа потребует тебя.',
          'cockpit-notification-test',
        );
        if (!shown) this.notificationError = 'Браузер не смог показать тестовое оповещение.';
        return shown;
      } finally {
        this.notificationBusy = false;
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
