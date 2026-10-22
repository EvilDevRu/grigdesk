import { uiLocalePort as uiLocale } from '../shared/uiLocalePort.ts';
import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
// Локальные возможности текущего устройства: уведомления и удержание экрана.
import { defineStore } from 'pinia';
import { ensureNotifyPermission, notify } from '../shared/notify.ts';

interface DeviceState {
  wakeLockEnabled: boolean;
  wakeLockSupported: boolean;
  wakeLockActive: boolean;
  wakeLockBusy: boolean;
  wakeLockIssue: string;
  wakeLockInitialized: boolean;
  notificationSupported: boolean;
  notificationPermission: NotificationPermission | 'unsupported';
  notificationBusy: boolean;
  notificationIssue: string;
  notificationInitialized: boolean;
}

const t = localeTranslator(uiLocale);

export const WAKE_LOCK_KEY = 'grigdesk-screen-wake-lock';

// WakeLockSentinel — браузерный объект, его нельзя класть в реактивный state Pinia.
// Держим дескриптор и незавершённый запрос рядом со стором: приложение создаёт один Pinia,
// а initWakeLock() защищён от повторной подписки.
let wakeLockSentinel: WakeLockSentinel | null = null;
let wakeLockRequest: Promise<boolean> | null = null;

/**
 * Настройка удержания экрана принадлежит текущему устройству.
 * Недоступный storage сохраняет прежнее выключенное состояние по умолчанию.
 */
function savedWakeLockEnabled(): boolean {
  try {
    return localStorage.getItem(WAKE_LOCK_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Запоминает локальный выбор человека без синхронизации между устройствами.
 * Запрет storage не мешает действию настройки до закрытия окна.
 */
function saveWakeLockEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(WAKE_LOCK_KEY, enabled ? '1' : '0');
  } catch {
    // Приватный режим может запрещать storage: настройка действует до закрытия окна.
  }
}

function wakeLockSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.wakeLock?.request === 'function';
}

function notificationSupported(): boolean {
  return typeof window !== 'undefined'
    && window.isSecureContext !== false
    && 'Notification' in window;
}

function notificationPermission(): NotificationPermission | 'unsupported' {
  return notificationSupported() ? window.Notification.permission : 'unsupported';
}

export const useDeviceStore = defineStore('device', {
  state: (): DeviceState => ({
    // Эта настройка намеренно локальная: планшет не должен заставлять экран компьютера
    // тоже гореть. Действует на всё SPA, потому что инициализируется в main.js, а не во view.
    wakeLockEnabled: savedWakeLockEnabled(),
    wakeLockSupported: wakeLockSupported(),
    wakeLockActive: false,
    wakeLockBusy: false,
    wakeLockIssue: '',
    wakeLockInitialized: false,
    // Разрешение браузера нельзя спрашивать на старте: мобильные браузеры принимают
    // запрос только из явного действия пользователя. Кнопка живёт в настройках устройства.
    notificationSupported: notificationSupported(),
    notificationPermission: notificationPermission(),
    notificationBusy: false,
    notificationIssue: '',
    notificationInitialized: false,
  }),
  getters: {
    wakeLockError: (state) => state.wakeLockIssue ? t(state.wakeLockIssue) : '',
    notificationError: (state) => state.notificationIssue ? t(state.notificationIssue) : '',
  },
  actions: {
    /**
     * Применяет сохранённое другим окном значение без записи в localStorage.
     * Совпавшее значение не запускает новый системный запрос блокировки экрана.
     */
    async reloadWakeLock(): Promise<void> {
      const enabled = savedWakeLockEnabled();

      if (enabled === this.wakeLockEnabled) {
        return;
      }

      this.wakeLockEnabled = enabled;
      this.wakeLockIssue = '';

      if (enabled) {
        await this.acquireWakeLock();
      } else {
        await this.releaseWakeLock();
      }
    },
    // Поднимаем Screen Wake Lock один раз на всё приложение. При уходе в фон браузер
    // освобождает его сам; visibilitychange возвращает блокировку после открытия окна.
    initWakeLock(): void {
      if (this.wakeLockInitialized || typeof document === 'undefined') {
        return;
      }

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

      if (this.wakeLockEnabled) {
        this.acquireWakeLock();
      }
    },

    /**
     * Сохраняем выбор устройства до обращения к системной блокировке экрана.
     * Отказ системного API не отменяет принятое человеком предпочтение.
     */
    async setWakeLockEnabled(enabled: unknown): Promise<boolean> {
      this.wakeLockEnabled = !!enabled;
      this.wakeLockIssue = '';
      saveWakeLockEnabled(this.wakeLockEnabled);

      if (this.wakeLockEnabled) {
        return this.acquireWakeLock();
      }

      await this.releaseWakeLock();

      return true;
    },

    /**
     * Объединяет параллельные запросы и не держит блокировку у скрытого окна.
     * Поздно выданный sentinel сразу освобождается, если настройка уже выключена.
     */
    async acquireWakeLock(): Promise<boolean> {
      if (!this.wakeLockEnabled) {
        return false;
      }

      this.wakeLockSupported = wakeLockSupported();

      if (!this.wakeLockSupported) {
        this.wakeLockActive = false;

        return false;
      }
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return false;
      }
      if (wakeLockSentinel && !wakeLockSentinel.released) {
        this.wakeLockActive = true;

        return true;
      }
      if (wakeLockRequest) {
  
      return wakeLockRequest;
      }

      this.wakeLockBusy = true;
      this.wakeLockIssue = '';
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
            if (wakeLockSentinel === lock) {
        
      wakeLockSentinel = null;
            }

            this.wakeLockActive = false;
          }, { once: true });

          return this.wakeLockActive;
        } catch (error) {
          this.wakeLockActive = false;

          if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
            return false;
          }

          this.wakeLockIssue = (error as { name?: string } | null)?.name === 'NotAllowedError'
            ? 'settings.wakeLockDenied'
            : 'settings.wakeLockFailed';

          return false;
        } finally {
          this.wakeLockBusy = false;
          wakeLockRequest = null;
        }
      })();

      return wakeLockRequest;
    },

    /**
     * Сначала снимает локальное владение, затем освобождает системный sentinel.
     * Одновременное освобождение самим браузером не превращается в ошибку настройки.
     */
    async releaseWakeLock(): Promise<void> {
      const lock = wakeLockSentinel;

      wakeLockSentinel = null;
      this.wakeLockActive = false;

      if (lock && !lock.released) {
        try {
          await lock.release();
        } catch {
          // Браузер мог освободить блокировку одновременно с нами.
        }
      }
    },

    // После возврата из системных настроек перечитываем permission: пользователь мог
    // разрешить или запретить уведомления снаружи окна.
    initNotifications(): void {
      if (this.notificationInitialized || typeof document === 'undefined') {
        return;
      }

      this.notificationInitialized = true;

      this.syncNotificationPermission();

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          this.syncNotificationPermission();
        }
      });
    },

    syncNotificationPermission(): void {
      this.notificationSupported = notificationSupported();
      this.notificationPermission = notificationPermission();

      if (this.notificationPermission === 'granted') {
        this.notificationIssue = '';
      }
    },

    /**
     * Системный запрос запускает кнопка настроек, чтобы браузер принял жест человека.
     * Сохраняем причину отказа отдельно от перевода, который меняется вместе с интерфейсом.
     */
    async requestNotificationPermission(): Promise<boolean> {
      this.notificationBusy = true;
      this.notificationIssue = '';

      try {
        const granted = await ensureNotifyPermission();

        this.syncNotificationPermission();

        if (!granted) {
          this.notificationIssue = this.notificationPermission === 'denied'
            ? 'settings.notificationDenied'
            : 'settings.notificationNotGranted';
        }

        return granted;
      } finally {
        this.notificationBusy = false;
      }
    },

    /**
     * Проверка получает системное разрешение в том же действии человека.
     * Уже отправленное уведомление сохраняется, а причина отказа переводится при показе.
     */
    async testNotification(): Promise<boolean> {
      this.notificationIssue = '';

      if (this.notificationPermission !== 'granted'
          && !(await this.requestNotificationPermission())) {
        return false;
      }

      this.notificationBusy = true;

      try {
        const shown = await notify(
          t('settings.notificationTestTitle'),
          t('settings.notificationTestBody'),
          'grigdesk-notification-test',
        );

        if (!shown) {
          this.notificationIssue = 'settings.notificationTestFailed';
        }

        return shown;
      } finally {
        this.notificationBusy = false;
      }
    },

  },
});
