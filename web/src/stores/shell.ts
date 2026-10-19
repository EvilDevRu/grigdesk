import { defineStore } from 'pinia';

import { API_VERSION } from '../../../shared/client/apiVersion.ts';
import type { ShellState } from '../../../shared/client/clientShell.ts';
import { delayWithAbort } from '../../../shared/lib/delay.ts';
import { readShellState, shellAction } from '../shared/shellClient.ts';

const controllers = new WeakMap<object, AbortController>();

export const useShellStore = defineStore('shell', {
  state: () => ({
    present: false,
    initialized: false,
    snapshot: null as ShellState | null,
    everOnline: false,
    showConnections: false,
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
     * Abort останавливает также паузу, таймеры не находятся в сериализуемом состоянии Pinia.
     */
    async poll(signal: AbortSignal, failed = false) {
      while (!signal.aborted) {
        try {
          if (failed) {
            await delayWithAbort(1000, signal);
          }

          const state = await readShellState(this.snapshot?.rev, signal);

          if (signal.aborted) {
            return;
          }

          this.apply(state);

          if (!state) {
            return;
          }

          failed = false;
        } catch {
          failed = true;
        }
      }
    },
    /**
     * Старый ответ не может откатить более свежую ревизию после действия человека.
     * everOnline запоминает факт связи до конца документа и переживает временный offline.
     */
    apply(state: ShellState | null) {
      if (state && this.snapshot && state.rev < this.snapshot.rev) {
        return;
      }

      this.present = state !== null;
      this.snapshot = state;
      this.everOnline ||= state?.status === 'online';
    },
    async refresh() {
      this.apply(await readShellState());
    },
    stop() {
      controllers.get(this)?.abort();
      controllers.delete(this);
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
    unlock() {
      return shellAction('POST', '/unlock');
    },
    scan() {
      return shellAction('POST', '/scan') as Promise<{ pairing: string }>;
    },
  },
});
