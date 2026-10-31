import { watch } from 'vue';
import type { Pinia } from 'pinia';
import { delayWithAbort } from '../../../../shared/lib/delay.ts';
import { isPlainRecord } from '../../../../shared/lib/objects.ts';
import { currentDesktopMode } from '../desktopSettings.ts';
import { useAuthStore } from '../../stores/auth.ts';
import { useShellStore } from '../../stores/shell.ts';
import { useBrowserStore } from '../../stores/browser.ts';
import { createBrowserHost } from './browserHost.ts';
import type { BrowserCommand, BrowserHostIdentity } from './browserHost.ts';
import type { BrowserOwnerChoice } from './browserUi.ts';

/**
 * Host token передаётся только заголовком выбранному same-origin backend.
 * Все ожидания ограничены; ошибка POST не порождает повтор побочного действия.
 */
export function createBrowserHostHttp(port: {
  fetch: typeof fetch;
  unauthorized(): void;
}) {
  return async (method: string, suffix: string, body: unknown,
    host: BrowserHostIdentity | null, signal?: AbortSignal, timeoutMs = 15000): Promise<unknown> => {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;

    try {
      const response = await port.fetch('/api/browser' + suffix, {
        method,
        credentials: 'same-origin',
        mode: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        signal: combined,
        headers: {
          'Content-Type': 'application/json',
          ...(host ? { 'X-GrigDesk-Browser-Host': host.token } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();

      if (text.length > 256 * 1024) {
        throw new Error('browser_response_invalid');
      }

      if (response.status === 401) {
        port.unauthorized();
      }

      if (!response.ok) {
        const error = new Error(response.status === 409
          ? 'browser_host_conflict' : 'browser_unavailable') as Error & { status: number };

        error.status = response.status;

        throw error;
      }

      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Корневой watcher запускает один host только у авторизованного main документа.
 * Scope включает выбранную машину и auth owner; смена маршрута его не меняет.
 */
export function installBrowserHostRuntime(pinia: Pinia): () => void {
  const auth = useAuthStore(pinia);
  const shell = useShellStore(pinia);
  const browser = useBrowserStore(pinia);
  const request = createBrowserHostHttp({
    fetch: (...args) => window.fetch(...args),
    unauthorized: () => auth.handleUnauthorized(),
  });
  const pathFor = (host: BrowserHostIdentity) => '/hosts/' + encodeURIComponent(host.id);
  const ownerScope = () => auth.ready && auth.authenticated && shell.profile
    ? JSON.stringify([shell.profile.id, auth.clientScope]) : null;
  const usableScope = () => currentDesktopMode() === 'main' && window.grigdeskBrowser
    && shell.initialized && shell.present && shell.status === 'online'
    && shell.capabilities.includes('browser') ? ownerScope() : null;
  let lastHost: { scope: string; identity: BrowserHostIdentity } | null = null;
  const native = async (value: unknown) => {
    if (!window.grigdeskBrowser) {
      throw new Error('browser_unavailable');
    }

    return window.grigdeskBrowser.invoke(value);
  };
  const host = createBrowserHost({
    now: Date.now,
    wait: delayWithAbort,
    native,
    register: async (takeover, signal) => {
      const scope = ownerScope();
      const identity = await request('POST', '/hosts',
        { takeover }, null, signal) as BrowserHostIdentity;

      if (scope !== null && scope === ownerScope()) {
        lastHost = { scope, identity };
      }

      return identity;
    },
    heartbeat: async (identity, body, signal) => await request('POST',
      pathFor(identity) + '/heartbeat', body, identity, signal) as { leaseMs: number },
    poll: async (identity, signal) => await request('POST', pathFor(identity) + '/poll',
      {}, identity, signal, 25000) as BrowserCommand | null,
    result: async (identity, requestId, result, signal) => {
      await request('POST', pathFor(identity) + '/result', { requestId, result }, identity, signal);
    },
    unregister: async (identity) => {
      await request('DELETE', pathFor(identity), undefined, identity, undefined, 3000);
    },
    owners: async (identity, signal) => {
      const value = await request('GET', '/owners', undefined, identity, signal);

      if (!isPlainRecord(value) || !Array.isArray(value.owners) || value.owners.length > 200
        || !value.owners.every((item) => isPlainRecord(item) && typeof item.id === 'string'
          && item.id.length <= 4096 && typeof item.label === 'string' && item.label.length <= 300)) {
        throw new Error('browser_owners_invalid');
      }

      return value.owners as BrowserOwnerChoice[];
    },
    grant: (identity, input, signal) => request('POST', '/grants', input, identity, signal),
    revoke: async (identity, tabId, signal) => {
      await request('DELETE', '/grants/' + encodeURIComponent(tabId), undefined, identity, signal);
    },
    changed: (status) => {
      browser.hostStatus = status;
    },
  });
  /**
   * Только явный Apply выключателя меняет защищённый серверный routing mode.
   * Startup с agents=false не выключает браузер другого компьютера на этом сервере.
   */
  async function disablePreference(): Promise<void> {
    const scope = ownerScope();
    const captured = lastHost !== null && lastHost.scope === scope ? lastHost.identity : null;

    try {
      const ack = await request('POST', '/mode', { enabled: false }, captured);

      if (!isPlainRecord(ack) || ack.enabled !== false) {
        throw new Error('browser_mode_ack_invalid');
      }
    } finally {
      host.update(null);
    }
  }

  const stopSnapshots = browser.startSnapshots();
  const unbind = browser.bindHost({ ...host, disablePreference });
  const stop = watch(() => [usableScope(), browser.preferences.agents, ownerScope()] as const,
    ([scope, enabled, owner], previous) => {
      if (owner !== previous?.[2]) {
        lastHost = null;
      }

      if (scope === null) {
        host.update(null);
      } else if (enabled) {
        host.update(scope);
      } else if (!(previous?.[0] === scope && previous?.[1] === true)) {
        host.update(null);
      }
    }, { immediate: true, flush: 'sync' });
  let disposed = false;
  /**
   * Очистка снимает root watcher, host и native snapshot subscription.
   * Повторный pagehide/HMR dispose не затрагивает уже освобождённые порты.
   */
  const dispose = () => {
    if (disposed) {
      return;
    }

    disposed = true;
    stop();
    host.dispose();
    stopSnapshots();
    unbind();
    window.removeEventListener('pagehide', dispose);
  };

  window.addEventListener('pagehide', dispose, { once: true });

  return dispose;
}
