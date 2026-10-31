import { defineStore } from 'pinia';
import { normalizeBrowserPreferences } from '../../../shared/browser/browserContract.ts';
import { useShellStore } from './shell.ts';
import { decodeBrowserSnapshot } from '../shared/browser/browserUi.ts';
import type {
  BrowserApp,
  BrowserGrantInput,
  BrowserHostControls,
  BrowserHostStatus,
  BrowserOwnerChoice,
  BrowserSnapshot,
} from '../shared/browser/browserUi.ts';

const hostPorts = new WeakMap<object, BrowserHostControls>();
const snapshotPorts = new WeakMap<object, () => void>();

export const useBrowserStore = defineStore('browser', {
  state: () => ({
    snapshot: {
      revision: 0,
      preferences: normalizeBrowserPreferences(null),
      active: null,
      tabs: [],
      grants: [],
    } as BrowserSnapshot,
    apps: [] as BrowserApp[],
    owners: [] as BrowserOwnerChoice[],
    hostStatus: { phase: 'off', error: '' } as BrowserHostStatus,
    busy: 0,
    error: '',
  }),
  getters: {
    available: () => typeof window !== 'undefined'
      && typeof window.grigdeskBrowser?.invoke === 'function',
    active: (state) => state.snapshot.tabs.find((tab) => tab.id === state.snapshot.active) ?? null,
    preferences(state) {
      const shell = useShellStore();

      return normalizeBrowserPreferences(shell.snapshot?.browser?.preferences
        ?? state.snapshot.preferences);
    },
  },
  actions: {
    /**
     * Native push обновляет loading/navigation/grants даже при открытом другом разделе.
     * Один initial read и одна подписка принадлежат документу, не каждому SFC.
     */
    startSnapshots(): () => void {
      snapshotPorts.get(this)?.();

      const stop = window.grigdeskBrowser?.subscribe?.((value) => {
        try {
          this.apply(value);
        } catch {
          this.error = 'browser_request_failed';
        }
      }) ?? (() => {});
      let stopped = false;
      /**
       * Подписка снимается идемпотентно только для собственного document lifecycle.
       * Поздняя очистка не удаляет snapshot port нового владельца.
       */
      const cleanup = () => {
        if (stopped) {
          return;
        }

        stopped = true;
        stop();

        if (snapshotPorts.get(this) === cleanup) {
          snapshotPorts.delete(this);
        }
      };

      snapshotPorts.set(this, cleanup);

      if (this.available) {
        void this.refresh().catch(() => {
          this.error = 'browser_request_failed';
        });
      }

      return cleanup;
    },
    /**
     * Host closure остаётся вне Pinia, snapshot содержит только публичную метаинформацию.
     * Закрытие main документа снимает ровно тот порт, который зарегистрировал bootstrap.
     */
    bindHost(port: BrowserHostControls) {
      hostPorts.set(this, port);

      return () => {
        if (hostPorts.get(this) === port) {
          hostPorts.delete(this);
        }
      };
    },
    apply(raw: unknown) {
      const next = decodeBrowserSnapshot(raw);

      if (next.revision >= this.snapshot.revision) {
        this.snapshot = next;
      }
    },
    async native(request: unknown): Promise<unknown> {
      if (!window.grigdeskBrowser) {
        throw new Error('browser_unavailable');
      }

      return window.grigdeskBrowser.invoke(request);
    },
    async refresh(): Promise<void> {
      this.apply(await this.native({ operation: 'state' }));
    },
    /**
     * Человеческие действия не несут owner; native сам отличает их от broker execute.
     * IPC ACK подтверждает действие, а сбой синхронизации grants не отменяет этот ACK.
     */
    async control(request: unknown): Promise<unknown> {
      this.busy += 1;
      this.error = '';

      try {
        const result = await this.native(request);

        this.apply(result);
        void hostPorts.get(this)?.sync().catch(() => {
          this.error = 'browser_sync_failed';
        });

        return result;
      } catch (error) {
        this.error = (error as Error).message === 'browser_app_missing'
          ? 'browser_app_missing' : 'browser_request_failed';

        throw error;
      } finally {
        this.busy -= 1;
      }
    },
    /**
     * Регистрация executable — отдельная native операция, выбор остаётся staged draft.
     * Каталог наружу не передаёт ни локальный path, ни команду запуска.
     */
    async loadApps(): Promise<void> {
      const apps = await this.native({ operation: 'apps' });

      if (!Array.isArray(apps) || apps.length > 5032 || !apps.every((item) => item
        && typeof item.id === 'string' && typeof item.name === 'string')) {
        throw new Error('browser_apps_invalid');
      }

      this.apps = apps.map((item) => ({ id: item.id, name: item.name }));
    },
    /**
     * Native picker возвращает проверенный ID приложения либо отмену выбора.
     * Каталог обновляется после регистрации без изменения staged preferences.
     */
    async chooseApp(): Promise<BrowserApp | null> {
      const chosen = await this.native({ operation: 'choose-app' }) as BrowserApp | null;

      if (chosen === null) {
        return null;
      }

      if (!chosen || typeof chosen.id !== 'string' || typeof chosen.name !== 'string') {
        throw new Error('browser_apps_invalid');
      }

      await this.loadApps();

      return { id: chosen.id, name: chosen.name };
    },
    async loadOwners(): Promise<void> {
      const host = hostPorts.get(this);

      this.owners = host ? await host.owners() : [];
    },
    async grant(input: BrowserGrantInput): Promise<void> {
      const host = hostPorts.get(this);

      if (!host) {
        throw new Error('browser_unavailable');
      }

      this.apply(await host.grant(input));
    },
    /**
     * Локальный revoke подтверждается до сетевого удаления server grant.
     * Offline не восстанавливает отозванную capability в native state.
     */
    async revoke(tabId: string): Promise<void> {
      await this.control({ operation: 'revoke', tabId });

      try {
        await hostPorts.get(this)?.revoke(tabId);
      } catch {
        this.error = 'browser_sync_failed';
      }
    },
    retryHost(takeover = false): void {
      hostPorts.get(this)?.retry(takeover);
    },
    async disablePreference(): Promise<void> {
      const port = hostPorts.get(this);

      if (!port) {
        throw new Error('browser_unavailable');
      }

      await port.disablePreference();
    },
  },
});
