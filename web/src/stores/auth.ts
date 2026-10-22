// Состояние входа хранит только подтверждение сессии и владельца локальных данных.
// HttpOnly-cookie и локальный ключ недоступны этому стору и остальному renderer.
import { defineStore } from 'pinia';
import { api } from '../shared/apiClient.ts';
import { useShellStore } from './shell.ts';
import { isRecord } from '../../../shared/lib/objects.ts';

const RELOAD_KEY = 'grigdesk-auth-reload-at';
const RELOAD_INTERVAL_MS = 60_000;

export const useAuthStore = defineStore('auth', {
  state: () => ({
    ready: false,
    configured: true,
    authenticated: false,
    clientScope: '',
    logConfirmation: 0,
    logEpoch: 0,
    logReason: 'load',
  }),

  actions: {
    /**
     * Проверка подтверждает сессию для журнала и сохраняет владельца локальных данных.
     * Ответ старой эпохи не может восстановить вход после полученного 401.
     */
    async load(reason = 'load') {
      const epoch = this.logEpoch;

      try {
        const s = await api.get('/api/auth/state');

        if (epoch !== this.logEpoch) {
          return;
        }

        if (!isRecord(s) || typeof s.configured !== 'boolean' || typeof s.authenticated !== 'boolean'
          || (s.clientScope != null && typeof s.clientScope !== 'string')
          || (s.login != null && typeof s.login !== 'string')) {
          throw new Error('Сервер вернул некорректное состояние входа');
        }

        this.configured = s.configured;
        this.authenticated = s.authenticated;
        this.clientScope = s.clientScope ?? s.login ?? '';
        this.logReason = reason;

        if (s.authenticated) {
          this.logConfirmation += 1;
        }
      } catch {
        if (epoch !== this.logEpoch) {
          return;
        }

        this.authenticated = false;
        this.logReason = reason;
      } finally {
        if (epoch === this.logEpoch) {
          this.ready = true;
        }
      }
    },

    /**
     * Первый отказ перезагружает документ, чтобы главное окно восстановило cookie.
     * Метка переживает reload; закрытый storage запрещает цикл повторных навигаций.
     */
    handleUnauthorized() {
      const shell = useShellStore();

      this.logEpoch += 1;
      this.logReason = '401';
      this.authenticated = false;

      if (shell.present) {
        void shell.refresh().catch(() => {});

        return;
      }

      try {
        const previous = Number(sessionStorage.getItem(RELOAD_KEY));
        const now = Date.now();

        if (previous > 0 && now - previous < RELOAD_INTERVAL_MS) {
          return;
        }

        sessionStorage.setItem(RELOAD_KEY, String(now));
      } catch {
        return;
      }

      location.reload();
    },

    /**
     * Общий API-клиент сообщает об отказе без повтора исходного запроса.
     * Подписка устанавливается при запуске документа, обмена ключом здесь нет.
     */
    watchUnauthorized() {
      api.onUnauthorized(() => this.handleUnauthorized());
    },
  },
});
