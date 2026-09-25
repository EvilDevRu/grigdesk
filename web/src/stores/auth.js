// Состояние входа в кокпит.
//
// Секретов здесь не хранится: сервер отдаёт сессионную httpOnly-cookie, JS её не видит и
// видеть не должен. Стор знает только «пущен или нет».
import { defineStore } from 'pinia';
import { api } from '../shared/apiClient.ts';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    // null = ещё не спрашивали. До ответа приложение не рисуем, иначе на миг мелькнёт
    // либо экран входа у вошедшего, либо интерфейс у невошедшего.
    ready: false,
    configured: true,
    authenticated: false,
    login: '',
    // Браузер говорит с сервером по защищённой схеме (локальный TLS либо https на шлюзе).
    secure: false,
    error: null,
    busy: false,
    // Отдельное подтверждение каждой удачной проверки сессии нужно транспорту журнала.
    logConfirmation: 0,
    logEpoch: 0,
    logReason: 'load',
  }),
  getters: {
    // Открыто с самой машины: там http безопасен по определению, предупреждать не о чем.
    isLocal: () => typeof location !== 'undefined'
      && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname),
  },
  actions: {
    async load(reason = 'load') {
      const epoch = this.logEpoch;
      try {
        const s = await api.get('/api/auth/state');
        if (epoch !== this.logEpoch) return;
        this.configured = s.configured;
        this.authenticated = s.authenticated;
        this.login = s.login || '';
        this.secure = !!s.secure;
        this.logReason = reason;
        if (s.authenticated) this.logConfirmation += 1;
      } catch {
        if (epoch !== this.logEpoch) return;
        // Сервер недоступен — считаем невошедшим, экран входа покажет ошибку при попытке.
        this.authenticated = false;
        this.logReason = reason;
      } finally {
        if (epoch === this.logEpoch) this.ready = true;
      }
    },

    // Любой 401 из обычного запроса = сессия истекла или отозвана → назад на вход.
    // Подписку ставим один раз при старте приложения.
    watchUnauthorized() {
      api.onUnauthorized((data) => {
        this.authenticated = false;
        this.logReason = '401';
        if (data && typeof data.needsSetup === 'boolean') this.configured = !data.needsSetup;
      });
    },

    async doLogin({ login, password }) {
      this.busy = true;
      this.error = null;
      try {
        await api.post('/api/auth/login', { login, password });
        await this.load('login');
        return this.authenticated;
      } catch (e) {
        this.error = e.data?.message || e.message;
        return false;
      } finally {
        this.busy = false;
      }
    },

    // Первичная настройка: доступна, пока пароль не задан. Сервер сразу впускает.
    async doSetup({ login, password }) {
      this.busy = true;
      this.error = null;
      try {
        await api.post('/api/auth/setup', { login, password });
        await this.load('setup');
        return this.authenticated;
      } catch (e) {
        this.error = e.data?.message || e.message;
        return false;
      } finally {
        this.busy = false;
      }
    },

    async doLogout() {
      this.logEpoch += 1;
      this.logReason = 'logout';
      this.authenticated = false;
      try { await api.post('/api/auth/logout'); } catch { /* всё равно уходим на вход */ }
    },
  },
});
