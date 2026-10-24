import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { compileModule, webFile } from './compile-vue.js';
import { createUiBrowser } from './ui-components.js';

let browser;

export const card = {
  id: 'claude',
  name: 'Claude фикстуры',
  type: 'universal',
  kind: 'cli',
  installed: true,
  available: false,
  version: '1.0.0',
  canUpdate: true,
  install: 'старый installer && claude login',
  setupCommand: 'claude login',
  models: [],
  settings: [],
  credentials: [],
  installation: {
    installCommand: 'серверный installer',
    updateCommand: 'серверный update',
    fallbackInstallCommand: 'старый installer && claude login',
    fallbackUpdateCommand: 'старый update',
    loginCommand: 'claude login',
    canInstall: true,
    canUpdate: true,
  },
};

/**
 * DTO фикстуры соответствует публичному снимку плана без env, PID и секретов.
 * Версии, вывод и команды являются данными сервера, не ключами переводчика.
 */
export function job(overrides = {}) {
  return {
    id: 'fixture-job-1',
    providerId: 'claude',
    operation: 'update',
    status: 'running',
    stage: 'download-install',
    before: '1.0.0',
    after: '',
    outcome: null,
    error: null,
    warnings: [],
    outputTail: 'строка из stdout',
    command: card.installation.updateCommand,
    fallbackCommand: card.installation.fallbackUpdateCommand,
    loginCommand: card.installation.loginCommand,
    startedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_100,
    finishedAt: null,
    ...overrides,
  };
}

/**
 * Ревизия относится ко всему атомарному снимку установки.
 * Последние исходы индексируются исполнителем, активная работа одна.
 */
export function snapshot(active = null, revision = 0, recent = {}, blockedReason = null) {
  return {
    revision,
    active,
    recent,
    blockedReason
  };
}

/**
 * Свежая Pinia сохраняет настоящий граф обоих stores и общей проекции providers.
 * Транспорт, confirm и launcher являются единственными внешними границами теста.
 */
export async function clientFixture(t, options = {}) {
  browser ||= await createUiBrowser('https://provider-install.test/');
  browser.document.body.innerHTML = '<div id="mount"></div>';
  assert.ok(existsSync(webFile('src/stores/providerInstall.ts')), 'Нет общего store серверной установки');

  if (options.dialog) {
    assert.ok(existsSync(webFile('src/shared/ProviderInstallDialog.vue')), 'Нет окна серверной установки');
  }

  const calls = {
    gets: [],
    posts: [],
    confirmations: [],
    terminals: [],
    subscriptions: []
  };
  let remote = snapshot();
  const api = {
    /**
     * Чтение различает registry и серверный снимок операции.
     * Пользовательский ответ позволяет удержать GET до следующего SSE.
     */
    async get(url) {
      calls.gets.push(url);

      if (options.get) {
        return options.get(url);
      }
      if (url.startsWith('/api/providers?') || url === '/api/providers') {
        return { providers: [structuredClone(card)] };
      }

      return structuredClone(remote);
    },
    /**
     * Только явный POST создаёт работу, ответ ещё не означает её завершение.
     * Тест потери ответа может бросить после синтетического допуска.
     */
    async post(url, body) {
      calls.posts.push({
        url,
        body
      });

      if (options.post) {
        return options.post(url, body);
      }

      remote = snapshot(job(), 1);

      return structuredClone(remote);
    },
  };

  globalThis.__providerInstallFixture = {
    api,
    confirm: async (text, details) => {
      calls.confirmations.push({
        text,
        details
      });

      return options.confirm ?? true;
    },
    terminal: async (target) => {
      calls.terminals.push(target);

      return options.terminal ?? true;
    },
    subscribe: (listener) => {
      calls.subscriptions.push(listener);

      return () => calls.subscriptions.splice(calls.subscriptions.indexOf(listener), 1);
    },
  };

  const transport = `
    export const api = globalThis.__providerInstallFixture.api;
    export { failureText, ApiError } from ${JSON.stringify(webFile('src/shared/apiClient.ts'))};
  `;
  const settingsStub = options.settings ? {
    '../stores/settings.ts': 'export const useSettingsStore = () => globalThis.__providerInstallSettings;',
  } : {};

  globalThis.__providerInstallSettings = options.settings;

  const entry = options.dialog
    ? '../tests/web/helpers/providerInstallDialogEntry.ts'
    : '../tests/web/helpers/providerInstallEntry.ts';
  const module = await compileModule(webFile(entry), {
    stubs: {
      ...settingsStub,
      '../shared/apiClient.ts': transport,
      './apiClient.ts': transport,
      '../ui.ts': `
        export * from ${JSON.stringify(webFile('src/ui.ts'))};
        export const confirmDialog = globalThis.__providerInstallFixture.confirm;
      `,
      '../shared/tools/launcher.ts': `
        export const useToolLauncher = () => ({ openTerminal: globalThis.__providerInstallFixture.terminal });
      `,
      './tools/launcher.ts': `
        export const useToolLauncher = () => ({ openTerminal: globalThis.__providerInstallFixture.terminal });
      `,
      '../composables/useSse.ts': `
        export const sseSubscribe = globalThis.__providerInstallFixture.subscribe;
        export const useSse = globalThis.__providerInstallFixture.subscribe;
      `,
    },
  });
  const piniaApi = await import('../../../web/node_modules/pinia/dist/pinia.mjs');
  const pinia = piniaApi.createPinia();

  piniaApi.setActivePinia(pinia);

  const auth = module.useAuthStore(pinia);

  auth.ready = true;
  auth.authenticated = true;
  auth.clientScope = 'fixture-scope';

  const store = module.useProviderInstallStore(pinia);
  const providers = module.useProvidersStore(pinia);

  providers.providers = [structuredClone(card)];
  providers.loaded = true;
  module.connectUiLocalePort(module.uiLocale);
  module.setUiLocale('ru');
  t.after(() => {
    for (const item of pinia._s.values()) {
      item.$dispose();
    }
  });

  return {
    browser,
    module,
    pinia,
    auth,
    store,
    providers,
    calls,
    settings: module.useSettingsStore(pinia),
    setRemote: (value) => {
      remote = value;
    },
  };
}

/**
 * Единственный DOM освобождается после всех монтирований файла.
 * Vue не получает документ от другого экземпляра happy-dom.
 */
export async function closeClientBrowser() {
  await browser?.close();
}
