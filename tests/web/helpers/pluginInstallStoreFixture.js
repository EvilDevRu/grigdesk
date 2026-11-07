import { createPinia } from '../../../web/node_modules/pinia/dist/pinia.mjs';
import { failureText } from '../../../web/src/shared/apiClient.ts';

import { compileModule, webFile } from './compile-vue.js';

const module = await compileModule(webFile('src/stores/pluginInstall.ts'), {
  stubs: {
    '../shared/apiClient.ts': `
      export const failureText = (...args) => globalThis.__pluginInstallFixture.failureText(...args);
      export const api = {
        get: (...args) => globalThis.__pluginInstallFixture.invoke('GET', ...args),
        post: (...args) => globalThis.__pluginInstallFixture.invoke('POST', ...args),
      };
    `,
    './plugins.ts': 'export const usePluginsStore = () => globalThis.__pluginInstallFixture.catalog;',
  },
});

/**
 * Promise barrier явно управляет поздним сетевым ответом без реального sleep.
 * Каждый тест завершает свои pending requests перед удалением fixture.
 */
export function deferredInstallResponse(t) {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });

  if (t) {
    t.after(() => resolve({ job: null, recoveryError: null }));
  }

  return {
    promise,
    resolve,
    reject,
  };
}

/**
 * Транспорт и sessionStorage принадлежат тесту, stores используют настоящую Pinia.
 * Все timer/controller снимаются через dispose до возврата глобальных объектов.
 */
export function pluginInstallStoreFixture(t) {
  const previousGlobal = globalThis.__pluginInstallFixture;
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const storage = new Map();
  const stores = [];
  const fixture = {
    failureText,
    calls: [],
    handlers: new Map(),
    storage,
    loads: 0,
    catalog: {
      async load() {
        fixture.loads += 1;
      },
    },
    /**
     * Request записан до ответа, чтобы проверить отсутствие повторов мутации.
     * Неизвестный endpoint не получает фиктивный успех из общего default.
     */
    async invoke(method, url, bodyOrOptions, options) {
      const call = {
        method,
        url,
        body: method === 'POST' ? structuredClone(bodyOrOptions) : undefined,
        options: method === 'GET' ? bodyOrOptions : options,
      };

      fixture.calls.push(call);

      const handler = fixture.handlers.get(method + ' ' + url);

      if (handler) {
        return handler(call);
      }

      if (method === 'GET' && url.endsWith('/jobs/current')) {
        return { job: null, recoveryError: null };
      }

      throw new Error('Нет ответа фикстуры: ' + method + ' ' + url);
    },
    newStore() {
      const store = module.usePluginInstallStore(createPinia());

      stores.push(store);

      return store;
    },
  };

  globalThis.__pluginInstallFixture = fixture;
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
  });
  t.after(() => {
    for (const store of stores) {
      store.$dispose();
    }

    globalThis.__pluginInstallFixture = previousGlobal;

    if (storageDescriptor) {
      Object.defineProperty(globalThis, 'sessionStorage', storageDescriptor);
    } else {
      delete globalThis.sessionStorage;
    }
  });

  return fixture;
}

/**
 * Сеть и Pinia action проходят несколько microtasks после разрешения barrier.
 * Тест не двигает fake clock до окончания текущего poll запроса.
 */
export async function flushInstallRequests() {
  for (let step = 0; step < 12; step += 1) {
    await Promise.resolve();
  }
}
