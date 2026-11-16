import assert from 'node:assert/strict';
import { after } from 'node:test';

import { compileModule, webFile } from './compile-vue.js';
import { createUiBrowser } from './ui-components.js';

let browserPromise;

after(async () => {
  const browser = await browserPromise;

  await browser?.close();
});

/**
 * Настоящие компоненты используют reactive owner и общий UI, сеть заменена на безопасные DTO.
 * Фикстура не использует старый phoneHarness с невалидным снимком оболочки на исходной базе.
 */
export async function relayUi(t, options = {}) {
  // Vue запоминает document при первом импорте: окно общее на файл, stores отдельные на сценарий.
  // Закрываем окно после всех тестов, а каждый mount снимаем своим after-hook.
  browserPromise ??= createUiBrowser();
  await browserPromise;
  window.localStorage.clear();
  window.sessionStorage.clear();

  const { reactive, defineComponent, h, nextTick } = await import('../../../web/node_modules/vue/index.mjs');
  const { createPinia, setActivePinia } = await import('../../../web/node_modules/pinia/dist/pinia.mjs');
  const { mount, flushPromises } = await import(
    '../../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
  const pinia = createPinia();
  const requests = [];
  const confirmations = [];
  const events = [];
  const fp = 'a'.repeat(64);
  const profile = {
    id: 'a',
    name: 'Сервер А',
    kind: 'remote',
    address: 'https://a.example:443',
    status: 'offline'
  };
  const shell = reactive({
    present: true,
    profile,
    profiles: [profile],
    status: options.connections ? 'offline' : 'online',
    detail: { code: 'offline' },
    localAvailable: false,
    appApi: { major: 0, minor: 1 },
    serverApi: { major: 0, minor: 1 },
    capabilities: options.capabilities ?? [],
    editProfile: async (id, patch) => requests.push({
      method: 'PATCH',
      url: id,
      body: patch
    }),
    scan: async () => ({ pairing: 'GRIGDESK:PHONE:2:SCANNER_SECRET' }),
  });
  const auth = reactive({
    clientScope: 'scope-a',
    authenticated: true,
    ready: true
  });
  const settings = reactive({ entityId: null });
  const phone = reactive({
    open: false,
    available: true,
    issue: async (relayId) => requests.push({ method: 'QR', relayId })
  });
  const relay = {
    id: 'r12345678',
    name: 'Прежний доступ',
    host: 'relay.example.invalid',
    port: 443,
    fp,
    enabled: true,
    link: { state: 'offline', compatibility: 'supported' }
  };
  const job = {
    id: 'deployment-0001',
    revision: 1,
    state: 'draft',
    mode: 'setup',
    expectedServerFp: fp,
    relayId: relay.id,
    steps: [],
    service: { state: 'pending' },
    channel: { state: 'unverified' },
  };
  const status = {
    name: 'Сервер А',
    server: { up: true, fp },
    direct: { state: 'disabled', addresses: [] },
    relays: [relay],
    devices: [],
    networks: [],
    jobs: options.jobs ?? [],
    listener: { state: 'disabled', addresses: [] },
  };
  let confirmed = false;

  /**
   * Каждая запись фиксирует owner в момент вызова, включая отложенные ответы A после B.
   * Неизвестный запрос падает как ошибка фикстуры, а не маскируется пустым успешным объектом.
   */
  async function request(method, url, body, requestOptions) {
    const call = {
      method,
      url,
      body,
      options: requestOptions,
      owner: shell.profile?.id
    };

    requests.push(call);

    if (options.answer) {
      const answer = options.answer(call);

      if (answer !== undefined) {
        return answer;
      }
    }

    if (url === '/api/client/hello') {
      return {
        fp,
        name: 'Сервер А',
        api: { major: 0, minor: 1 },
        device: null
      };
    }

    if (['/api/devices/access', '/api/mobile/status', '/api/devices'].includes(url)) {
      return structuredClone(status);
    }

    if (method === 'DEL' && url === `/api/mobile/relays/${relay.id}`) {
      status.relays = [];

      return { ok: true };
    }

    if (url === '/api/mobile/deployments' && method === 'GET') {
      return { jobs: structuredClone(status.jobs) };
    }

    if (url === '/api/mobile/deployments' && method === 'POST') {
      Object.assign(job, body);
      status.jobs = [job];

      return { job: structuredClone(job) };
    }

    if (url.startsWith(`/api/mobile/deployments/${job.id}`)) {
      if (url.endsWith('/probe')) {
        Object.assign(job, {
          state: 'awaiting_host_key',
          revision: job.revision + 1,
          hostKey: {
            challengeId: 'host-challenge',
            fingerprint: 'SHA256:fixture',
            decision: 'trust_required',
            revision: 2
          }
        });
      } else if (url.endsWith('/host-key')) {
        Object.assign(job, { state: 'awaiting_credentials', revision: job.revision + 1 });
      } else if (url.endsWith('/credentials')) {
        Object.assign(job, {
          state: 'awaiting_confirmation',
          revision: job.revision + 1,
          preview: {
            digest: 'b'.repeat(64),
            changes: ['Системная служба и отдельный пользователь'],
            artifact: { version: '0.3.0', digest: 'c'.repeat(64) }
          }
        });
      } else if (url.endsWith('/start')) {
        Object.assign(job, {
          state: 'ready',
          revision: job.revision + 1,
          service: { state: 'running' },
          channel: { state: 'verified' }
        });
      }

      return { job: structuredClone(job) };
    }

    throw new Error(`Неизвестный запрос UI fixture: ${method} ${url}`);
  }

  setActivePinia(pinia);
  globalThis.__relayUi = {
    shell,
    auth,
    settings,
    phone,
    api: Object.fromEntries(['get', 'post', 'put', 'patch', 'del', 'postBytes'].map((method) => [
      method, (url, body, requestOptions) => request(method === 'postBytes' ? 'POST_BYTES'
        : method.toUpperCase(), url, body, requestOptions),
    ])),
    subscribe: (listener) => events.push(listener),
    confirm: async (value) => {
      confirmations.push(module.resolveUiText(value));

      return confirmed;
    },
    prompt: async () => options.prompt ?? null,
  };

  const stubs = {};

  for (const prefix of ['../', '../../', '../../../']) {
    for (const [name, global] of Object.entries({
      shell: 'shell',
      auth: 'auth',
      settings: 'settings'
    })) {
      const symbol = `use${name[0].toUpperCase() + name.slice(1)}Store`;

      stubs[`${prefix}stores/${name}.ts`] =
        `export const ${symbol} = () => globalThis.__relayUi.${global};`;
    }

    stubs[`${prefix}stores/phoneAccess.ts`] = `
export const usePhoneAccessStore = () => globalThis.__relayUi.phone;
export const phoneRelayReady = (relay) => relay.link?.state === 'online';`;
    stubs[`${prefix}shared/apiClient.ts`] = `
export * from './src/shared/apiClient.ts';
export const api = globalThis.__relayUi.api;`;
    stubs[`${prefix}composables/useSse.ts`] = `
export const useSse = (listener) => { globalThis.__relayUi.subscribe(listener); return {}; };`;
    stubs[`${prefix}ui.ts`] = `
export * from './src/ui.ts';
export const confirmDialog = (...args) => globalThis.__relayUi.confirm(...args);
export const promptDialog = (...args) => globalThis.__relayUi.prompt(...args);`;
  }

  const module = await compileModule(webFile('../tests/web/helpers/relay-deployment-host.ts'), { stubs });

  module.setUiLocale(options.locale ?? 'ru');

  const host = defineComponent({
    setup: () => () => h('div', [
      h(options.connections ? module.ConnectionsView : module.ServerAccessPanel),
      h(module.UiDialogHost),
    ]),
  });
  const wrapper = mount(host, { attachTo: document.body, global: { plugins: [pinia] } });

  t.after(() => {
    wrapper.unmount();
    document.body.replaceChildren();
    module.setUiLocale('ru');
    delete globalThis.__relayUi;
  });
  await flushPromises();

  /**
   * Открытый мастер ограничивает поиск действий своей модалкой, скрывая фоновые совпадения.
   * После закрытия мастера действия снова выбираются на всей странице.
   */
  function button(pattern) {
    const root = document.querySelector('[data-role="remote-access-wizard"]') ?? document;

    return [...root.querySelectorAll('button')]
      .find((element) => pattern.test(
        `${element.textContent} ${element.getAttribute('aria-label') ?? ''}`));
  }

  return {
    wrapper,
    shell,
    auth,
    phone,
    requests,
    confirmations,
    events,
    job,
    status,
    pinia,
    flushPromises,
    nextTick,
    confirm: (value) => confirmed = value,
    text: () => document.body.textContent ?? '',
    button,
    /**
     * Действие ищется по видимой подписи и проверяется скаляром до обращения к DOM.
     * Упавший assert не получает happy-dom узел и не раздувает память форматтером.
     */
    async click(pattern) {
      const action = button(pattern);

      assert.equal(Boolean(action), true, `Нет действия ${pattern}`);
      action.click();
      await flushPromises();
    },
  };
}

/**
 * Поле выбирается по настоящему label, поэтому доступность формы проверяется вместе с вводом.
 * Значения отправляются обычным событием input, внутренние ref компонента не раскрываются.
 */
export async function fillLabel(h, pattern, value) {
  const label = [...document.querySelectorAll('label')].find((element) => pattern.test(element.textContent));
  const input = label?.htmlFor ? document.getElementById(label.htmlFor) : label?.querySelector('input');

  assert.equal(Boolean(input), true, `Нет подписанного поля ${pattern}`);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await h.flushPromises();
}
