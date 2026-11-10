import assert from 'node:assert/strict';
import { compileModule, webFile } from './compile-vue.js';
import { phoneBrowser } from './phoneBrowser.js';
/**
 * Отложенный сетевой ответ управляется тестом, даже если abort уже отправлен.
 * Так проверяется generation, а не только послушное поведение fetch-заглушки.
 */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });

  return {
    promise,
    resolve,
    reject
  };
}
/**
 * Диалог, оба входа и владельцы используют один настоящий Pinia-граф.
 * Подменяется только сеть; storage, журнал и SSE отслеживаются отдельно от UI.
 */
export async function phoneHarness(t, options = {}) {
  phoneBrowser();

  const requests = [];
  const answers = options.answers || {};
  const status = {
    name: 'Сервер А',
    source: 'env',
    direct: {
      state: 'online',
      addresses: ['192.0.2.10:8145'],
      error: null
    },
    networks: [{ name: 'lan', address: '192.0.2.10' }],
    relays: [],
  };
  const issued = {
    text: 'GRIGDESK:PHONE:2:SYNTHETIC_SECRET_A',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" />',
    qr: { size: 1, rows: ['1'] },
    attemptId: 'attempt-a',
    expiresAt: 1,
    expiresInMs: 600000,
  };
  let progress = 'pending';
  /**
     * Ответы фиксируют метод и текущую серверную личность в момент запроса.
     * Неизвестная ручка считается ошибкой фикстуры, а не сетевым отказом продукта.
     */
  async function request(method, url, body) {
    const call = {
      method,
      url,
      body,
      owner: shell.profile?.id,
      scope: auth.clientScope
    };

    requests.push(call);

    if (answers[`${method} ${url}`]) {
      return answers[`${method} ${url}`](call);
    }
    if (url === '/api/devices/access') {
      return structuredClone(status);
    }
    if (url === '/api/devices/phone-pairing' && method === 'POST') {
      return structuredClone(issued);
    }
    if (url.startsWith('/api/devices/phone-pairing/')) {
      return { status: progress, ...(progress === 'connected' ? { device: { id: 'd12345678' } } : {}) };
    }
    if (url === '/api/devices') {
      return {
        devices: [],
        listener: status.direct,
        currentDeviceId: null
      };
    }
    if (url === '/api/mobile/status') {
      return {
        server: { up: true },
        relays: [],
        devices: []
      };
    }
    if (url === '/api/devices/access/direct' && method === 'PUT') {
      return structuredClone(status);
    }

    throw new Error(`Неизвестный API телефонного стенда: ${method} ${url}`);
  }

  globalThis.__phoneApi = Object.fromEntries(['get', 'post', 'put', 'patch', 'del'].map((method) => [
    method, (url, body) => request(method.toUpperCase(), url, body),
  ]));
  globalThis.__phoneApi.eventsUrl = () => '/api/events';

  const module = await compileModule(webFile('../tests/web/helpers/phone-access-host.ts'), {
    stubs: Object.fromEntries([
      '../shared/apiClient.ts', '../../shared/apiClient.ts', '../../../shared/apiClient.ts',
     ].map((specifier) => [specifier, [
      "import { ApiError as PhoneApiError } from './src/shared/apiClient.ts';",
      "export * from './src/shared/apiClient.ts';",
      'export const api = globalThis.__phoneApi;',
      'globalThis.__PhoneApiError = PhoneApiError;',
    ].join('\n')])),
  });
  const { createPinia, setActivePinia } = await import('../../../web/node_modules/pinia/dist/pinia.mjs');
  const { defineComponent, h, nextTick } = await import('../../../web/node_modules/vue/index.mjs');
  const { mount, flushPromises } = await import(
    '../../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
  const pinia = createPinia();

  setActivePinia(pinia);

  const shell = module.useShellStore(pinia);
  const auth = module.useAuthStore(pinia);
  const settings = module.useSettingsStore(pinia);

  auth.ready = true;
  auth.authenticated = true;
  auth.clientScope = 'scope-a';
  shell.apply({
    rev: 1,
    profile: {
      id: 'a',
      name: 'Сервер А',
      kind: options.kind || 'remote',
      address: 'https://a.example:443'
    },
    profiles: [],
    status: 'online',
    capabilities: [],
    localAvailable: options.kind === 'local',
  });
  settings.setAuthenticated(true);
  module.setUiLocale(options.locale || 'ru');

  const host = defineComponent({
    setup: () => () => h('div', [
      h(module.PhoneConnectButton),
      h(module.PhoneConnectDialog),
      h(module.UiDialogHost),
      ...(options.settings ? [h(module.ServerAccessPanel)] : []),
    ]),
  });
  const wrapper = mount(host, { attachTo: document.body, global: { plugins: [pinia] } });

  t.after(() => {
    wrapper.unmount();
    settings.dispose();
    shell.stop();
    module.setUiLocale('ru');
    delete globalThis.__phoneApi;
    delete globalThis.__PhoneApiError;
  });
  await flushPromises();
  /**
     * Действие находится по доступной подписи, без привязки к CSS или внутреннему store API.
     * Несколько входов можно различить индексом, но диалог должен оставаться единственным.
     */
  async function click(pattern, index = 0) {
    const buttons = [...document.querySelectorAll('button')].filter((button) =>
      pattern.test(button.textContent || button.getAttribute('aria-label') || ''));

    assert.ok(buttons[index], `Не найдено действие ${pattern}`);
    buttons[index].click();
    await nextTick();
    await flushPromises();
  }

  /**
   * Действие ищется только внутри открытого диалога телефона, а не во всей странице.
   * Так кнопка панели настроек с той же подписью не подменяет действие диалога.
   */
  async function dialogClick(pattern) {
    const dialog = document.querySelector('.phone-connect');

    assert.ok(dialog, 'Диалог телефона не открыт');

    const button = [...dialog.querySelectorAll('button')].find((item) => pattern.test(item.textContent));

    assert.ok(button, `В диалоге нет действия ${pattern}`);
    button.click();
    await nextTick();
    await flushPromises();
  }

  return {
    wrapper,
    module,
    phone: module.usePhoneAccessStore(pinia),
    shell,
    auth,
    settings,
    requests,
    status,
    issued,
    answers,
    click,
    dialogClick,
    flushPromises,
    // Настоящий ApiError клиента: стор различает коды сервера (например, choose_address).
    apiError(status, data) {
      return new globalThis.__PhoneApiError(data.message ?? data.error, status, data);
    },
    connected() {
      progress = 'connected';
    },
  };
}
