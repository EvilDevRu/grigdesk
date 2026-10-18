import assert from 'node:assert/strict';
import test from 'node:test';

import { compileSettingsView } from './helpers/settings-view.js';

process.env.NODE_ENV = 'test';
globalThis.__GRIGDESK_VERSION__ = '0.0.0-test';
globalThis.__GRIGDESK_SHA__ = 'test';

const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
const browser = new Window({ url: 'http://127.0.0.1:8140/#/settings' });

for (const name of ['window', 'document', 'navigator', 'location', 'localStorage', 'Node',
  'Element', 'HTMLElement', 'SVGElement', 'Event', 'CustomEvent', 'ResizeObserver']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: browser[name] });
}

const { createPinia, setActivePinia } = await import('../../web/node_modules/pinia/dist/pinia.mjs');
const { useDeviceStore } = await import('../../web/src/stores/device.js');

const { mount, flushPromises } = await import(
  '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
);

/**
 * Карточка настроек работает с настоящими контролами и управляемой сетью.
 * Launcher отдельно наблюдаем, чтобы намерение окна не открывало второй терминал.
 */
async function fixture(t, tab = 'providers', desktop = true) {
  browser.localStorage.setItem('grigdesk-settings-tab', tab);
  browser.location.hash = '#/settings';

  setActivePinia(createPinia());

  const device = useDeviceStore();
  const calls = [];
  const originalReload = browser.location.reload;

  browser.location.reload = () => calls.push(['legacy-reload']);
  t.after(() => {
    browser.location.reload = originalReload;
  });

  const windowActions = {
    openTerminal: async (insert) => calls.push(['terminal', insert]),
    openChat: async (key) => calls.push(['chat', key]),
  };
  const provider = {
    id: 'test',
    name: 'Тестовый исполнитель',
    available: false,
    installed: false,
    setupCommand: 'npm install fixture && fixture login',
    models: [],
    distribution: {
      ready: false,
      label: 'Локальная сборка',
      problem: { message: 'Сборка недоступна', command: 'fixture repair' },
    },
  };
  const providers = {
    providers: [provider],
    usage: {},
    mcp: {},
    loaded: true,
    showAllModels: false,
    visibleModels: () => [],
    modelOf: () => ({
      id: '',
      model: null,
      provider: null
    }),
    load: async () => { },
    loadUsage: async () => { },
    loadMcp: async () => ({ state: 'ok', servers: [] }),
  };

  globalThis.__settingsApi = {
    /**
     * Снимки входа, настроек и процессов полностью принадлежат фикстуре.
     * Остальные ручки дают пустой успешный ответ без обращения к живому серверу.
     */
    async get(path) {
      if (path === '/api/auth/state') {
        return { authenticated: true };
      }

      if (path === '/api/settings/prefs') {
        return { chatLiveSessions: true, providerSettings: {} };
      }

      if (path === '/api/chat/sessions') {
        return {
          enabled: true, sessions: [{
            chatKey: 'fixture-chat',
            chatTitle: 'Тест',
            running: false
          }]
        };
      }

      return {};
    },
    post: async () => ({}),
  };
  globalThis.__settingsTerminal = (target) => calls.push(['launcher', target]);
  globalThis.__settingsConfirm = async () => true;
  globalThis.__settingsStores = {
    useProvidersStore: () => providers,
    useAuthStore: () => ({ login: 'тест' }),
    usePluginsStore: () => ({
      loaded: true,
      list: [],
      enabled: () => true,
      byId: () => null,
      load: async () => { },
    }),
    useChatStore: () => ({ compactWindow: 0, setActive: (key) => calls.push(['setActive', key]) }),
    useDeviceStore: () => device,
    useGrigDeskUpdateStore: () => ({ state: null, load: async () => { } }),
  };

  const component = await compileSettingsView({ confirm: true, terminal: true });
  let wrapper;

  t.after(() => wrapper?.unmount());
  wrapper = mount(component, {
    props: { windowActions: desktop ? windowActions : null },
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
  });

  t.after(() => {
    wrapper.unmount();

    for (const key of ['Api', 'Terminal', 'Confirm', 'Stores']) {
      delete globalThis['__settings' + key];
    }
  });

  for (let index = 0; index < 6; index += 1) {
    await flushPromises();
  }

  return {
    wrapper,
    calls,
    provider,
    device
  };
}

test('SW-X01 окно настроек без баннера', async (t) => {
  const { wrapper } = await fixture(t);

  assert.equal(wrapper.find('.settings-hero').exists(), false);
  assert.equal(wrapper.findAll('[data-role=settings-nav]').length, 8);
  await wrapper.setProps({ windowActions: null });
  assert.equal(wrapper.find('.settings-hero').exists(), true);
});

test('SW-X02 установка и исправление идут через окно', async (t) => {
  const { wrapper, calls, provider } = await fixture(t);
  const buttons = wrapper.findAll('[data-role=settings-command]');

  assert.equal(buttons.length, 2);
  await buttons[0].trigger('click');
  await buttons[1].trigger('click');
  assert.deepEqual(calls, [['terminal', 'fixture repair'], ['terminal', provider.setupCommand]]);
  await wrapper.setProps({ windowActions: null });
  await buttons[1].trigger('click');
  assert.deepEqual(calls.at(-1), ['launcher', { insert: provider.setupCommand }]);
});

test('SW-X03 Открыть чат идёт через окно', async (t) => {
  const { wrapper, calls } = await fixture(t, 'runs');
  const button = wrapper.findAll('button').find((button) => button.text() === 'Открыть чат');
  const hash = location.hash;

  assert.equal(Boolean(button), true);
  await button.trigger('click');
  assert.deepEqual(calls, [['chat', 'fixture-chat']]);
  assert.equal(location.hash, hash);
});

test('SW-X04 перезапуск сервера сохраняет документ окна', async (t) => {
  const { wrapper, calls } = await fixture(t, 'server');
  const button = wrapper.findAll('button').find((button) => button.text() === 'Перезапустить сервер');

  assert.equal(Boolean(button), true);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await button.trigger('click');
  await flushPromises();
  t.mock.timers.tick(1000);
  await flushPromises();
  assert.deepEqual(calls, []);
});


test('пересборка рабочего web не предлагает обновлять документ приложения', async (t) => {
  const { wrapper, calls } = await fixture(t, 'server');
  const get = globalThis.__settingsApi.get;

  globalThis.__settingsApi.get = async (path) => path === '/api/system/web-rebuild'
    ? { rebuild: { status: 'done', finishedAt: new Date(performance.timeOrigin + 1000).toISOString() } }
    : get(path);

  const button = wrapper.findAll('button').find((item) => item.text() === 'Пересобрать web-бандл');

  t.mock.timers.enable({ apis: ['setTimeout'] });
  await button.trigger('click');
  await flushPromises();
  t.mock.timers.tick(2000);
  await flushPromises();
  t.mock.timers.tick(5000);
  await flushPromises();
  assert.deepEqual(calls, []);
  assert.equal(wrapper.find('[data-role=settings-refresh]').exists(), false);
  assert.match(wrapper.text(), /после установки нового пакета/);
});
