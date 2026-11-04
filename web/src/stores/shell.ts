import { defineStore } from 'pinia';

import { API_VERSION } from '../../../shared/client/apiVersion.ts';
import { connectionRetryDelay } from '../../../shared/client/connectionRetry.ts';
import { isAppLockState, type ShellState } from '../../../shared/client/clientShell.ts';
import { delayWithAbort } from '../../../shared/lib/delay.ts';
import { isShellState, readShellState, shellAction } from '../shared/shellClient.ts';

const controllers = new WeakMap<object, AbortController>();
const retryWaits = new WeakMap<object, AbortController>();

export const useShellStore = defineStore('shell', {
  state: () => ({
    present: false,
    initialized: false,
    snapshot: null as ShellState | null,
    everOnline: false,
    showConnections: false,
    unavailable: false,
    retryAt: 0,
    retryAttempt: 0,
  }),
  getters: {
    status: (state) => state.snapshot?.status ?? 'none',
    profile: (state) => state.snapshot?.profile ?? null,
    profiles: (state) => state.snapshot?.profiles ?? [],
    capabilities: (state) => state.snapshot?.capabilities ?? [],
    detail: (state) => state.snapshot?.detail ?? null,
    localAvailable: (state) => state.snapshot?.localAvailable ?? false,
    serverApi: (state) => state.snapshot?.serverApi ?? null,
    appApi: (state) => state.snapshot?.appApi ?? API_VERSION,
    appLock: (state) => {
      const block = state.snapshot?.appLock;

      return isAppLockState(block) ? block : null;
    },
    appLocked: (state) => {
      const block = state.snapshot?.appLock;

      return isAppLockState(block) ? block.locked : false;
    },
  },
  actions: {
    /**
     * Детектор выполняется один раз на документ, HTML и 404 останавливают опрос.
     * При сетевой ошибке начальная попытка повторяется с той же паузой, что long-poll.
     */
    async start(options: { poll?: boolean } = {}) {
      if (controllers.has(this)) {
        return;
      }

      const controller = new AbortController();

      controllers.set(this, controller);

      try {
        this.apply(await readShellState(undefined, controller.signal));
        this.initialized = true;

        if (this.present && options.poll !== false) {
          void this.poll(controller.signal);
        }
      } catch {
        this.initialized = true;

        if (options.poll !== false) {
          void this.poll(controller.signal, true);
        }
      }
    },
    /**
     * Long-poll имеет одну активную цепочку, ошибка добавляет минимум секунду паузы.
     * Отказ уже обнаруженной оболочки сохраняет снимок и повторяется после той же паузы.
     * Abort останавливает также паузу, таймеры не находятся в сериализуемом состоянии Pinia.
     */
    async poll(signal: AbortSignal, failed = false) {
      while (!signal.aborted) {
        try {
          if (failed) {
            this.unavailable = true;

            const wait = new AbortController();
            const delay = connectionRetryDelay(this.retryAttempt++);

            retryWaits.set(this, wait);
            this.retryAt = Date.now() + delay;

            try {
              await delayWithAbort(delay, AbortSignal.any([signal, wait.signal]));
            } catch {
              if (signal.aborted) {
                return;
              }
            } finally {
              if (retryWaits.get(this) === wait) {
                retryWaits.delete(this);
                this.retryAt = 0;
              }
            }
          }

          const state = await readShellState(this.snapshot?.rev, signal);

          if (signal.aborted) {
            return;
          }

          this.apply(state);

          if (!state && !this.present) {
            return;
          }

          failed = state === null;
        } catch {
          failed = true;
        }
      }
    },
    /**
     * Старый ответ не может откатить более свежую ревизию после действия человека.
     * Обнаруженная оболочка принадлежит документу: её временный отказ не отменяет обнаружение.
     * everOnline запоминает факт связи до конца документа и переживает временный offline.
     */
    apply(state: ShellState | null) {
      if (state !== null && !isShellState(state)) {
        throw new Error('Получено некорректное состояние оболочки');
      }

      if (!state && this.present) {
        return;
      }

      if (state && this.snapshot && state.rev < this.snapshot.rev) {
        return;
      }

      this.present = state !== null;
      this.snapshot = state;
      this.everOnline ||= state?.status === 'online';
      this.unavailable = false;
      this.retryAttempt = 0;
    },
    async refresh() {
      this.apply(await readShellState());
    },
    /**
     * Закрытие документа отменяет запрос и ожидание повтора через общий signal.
     * Старая цепочка не может снять таймер уже запущенного нового обнаружения.
     */
    stop() {
      controllers.get(this)?.abort();
      controllers.delete(this);
      retryWaits.delete(this);
      this.retryAt = 0;
    },
    retryNow() {
      retryWaits.get(this)?.abort();
    },
    addMachine(pairing: string) {
      return shellAction('POST', '/profiles', { pairing });
    },
    addLocal() {
      return shellAction('POST', '/profiles', { local: true });
    },
    editProfile(id: string, patch: { name?: string; address?: string }) {
      return shellAction('PATCH', `/profiles/${encodeURIComponent(id)}`, patch);
    },
    removeProfile(id: string) {
      return shellAction('DELETE', `/profiles/${encodeURIComponent(id)}`);
    },
    selectProfile(id: string) {
      return shellAction('POST', '/select', { id });
    },
    connect() {
      return shellAction('POST', '/connect');
    },
    disconnect() {
      return shellAction('POST', '/disconnect');
    },
    /**
     * Успешная разблокировка возвращает свежий снимок, сразу снимающий блокирующий слой.
     * Ревизия защищает его от запоздалого long-poll со старым состоянием locked.
     * Прежний Android отвечает только ok: после него снимок читается отдельным GET.
     */
    async unlock() {
      const state = await shellAction('POST', '/unlock');

      if (isShellState(state)) {
        this.apply(state);
      } else {
        await this.refresh();
      }

      return state;
    },
    scan() {
      return shellAction('POST', '/scan') as Promise<{ pairing: string }>;
    },
  },
});
