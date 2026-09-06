import assert from 'node:assert/strict';
import test from 'node:test';

import { compileSettingsView } from './helpers/settings-view.js';

process.env.NODE_ENV = 'test';

const RISK_TEXT = 'Агент сможет запускать прямые SSH-клиенты с правами процесса Cockpit. '
  + 'Режим прав Bash не заменяет этот запрет. Подтверждений и журнала SSH-инструмента не будет.';

async function installBrowser(t) {
  globalThis.__COCKPIT_VERSION__ = '0.0.0-test';
  globalThis.__COCKPIT_SHA__ = 'testsha';
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'http://cockpit.test/#/settings' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    localStorage: browser.localStorage,
    Node: browser.Node,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    HTMLButtonElement: browser.HTMLButtonElement,
    HTMLSelectElement: browser.HTMLSelectElement,
    SVGElement: browser.SVGElement,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser),
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  browser.localStorage.setItem('cockpit-settings-tab', 'providers');
  browser.document.body.innerHTML = '<div id="mount"></div>';
  t.after(() => browser.close());
  return browser;
}

function provider(id, name, note = '', value = true) {
  return {
    id,
    name,
    vendor: 'Test',
    kind: 'cli',
    color: '#123456',
    available: true,
    installed: true,
    chatEnabled: true,
    models: [],
    settings: [{
      id: 'blockDirectSsh',
      kind: 'toggle',
      label: 'Запретить прямой SSH',
      hint: 'Закрывает прямой SSH для кооперативного агента.',
      note,
      value,
      confirm: {
        off: {
          text: RISK_TEXT,
          label: 'Разрешить прямой SSH',
          danger: true,
        },
      },
    }],
  };
}

async function mountSettings(t, {
  confirmImpl = async () => true,
  saveImpl,
  initialValue = true,
} = {}) {
  const browser = await installBrowser(t);
  const confirmations = [];
  const saves = [];
  const prov = {
    providers: [
      provider('alpha-next', 'Alpha', '', initialValue),
      provider('beta-next', 'Beta', '', initialValue),
      provider(
        'gamma-next',
        'Gamma',
        'Host-режим не умеет обеспечить запрет и остановит ход.',
        initialValue,
      ),
      provider('delta-next', 'Delta', '', initialValue),
    ],
    usage: {},
    mcp: {},
    loaded: true,
    showAllModels: false,
    updating: '',
    updateResults: {},
    visibleModels: () => [],
    async load() {},
    async loadUsage() {},
    async updateCli() { return { type: 'ok', text: 'Уже последняя версия (1.0.0).', changed: false }; },
    async loadMcp() { return {}; },
    async runUsageAction() { return { ok: true }; },
    async saveSetting(...args) {
      saves.push(args);
      if (saveImpl) return saveImpl(...args);
      return { ok: true };
    },
  };
  globalThis.__providerSettingsApi = { async get() { return {}; }, async post() { return {}; } };
  globalThis.__providerSettingsStores = {
    useProvidersStore: () => prov,
    useUiContextStore: () => ({ set() {}, clear() {} }),
    useAuthStore: () => ({ login: 'me', async logoutAll() {} }),
    usePluginsStore: () => ({
      loaded: true, list: [], enabled: () => true, async load() {}, async setEnabled() {},
    }),
    useChatStore: () => ({ compactWindow: 0 }),
    useCompanionStore: () => ({ deviceEnabled: true, setDeviceEnabled() {} }),
    usePwaStore: () => ({ canInstall: false, wakeLock: false, async install() {} }),
    useCockpitUpdateStore: () => ({ state: null, async load() {} }),
  };
  globalThis.__providerSettingsConfirm = (...args) => {
    confirmations.push(args);
    return confirmImpl(...args);
  };
  const [{ mount, flushPromises }, SettingsView] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileSettingsView({ prefix: '__providerSettings', confirm: true }),
  ]);
  const wrapper = mount(SettingsView, {
    attachTo: browser.document.querySelector('#mount'),
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
  });
  t.after(() => {
    wrapper.unmount();
    delete globalThis.__providerSettingsApi;
    delete globalThis.__providerSettingsStores;
    delete globalThis.__providerSettingsConfirm;
  });
  for (let index = 0; index < 5; index += 1) await flushPromises();
  return { wrapper, confirmations, saves, flushPromises };
}

test('каждая карточка исполнителя содержит свой тумблер запрета, общего тумблера нет', async (t) => {
  const { wrapper } = await mountSettings(t);
  const cards = wrapper.findAll('.pvcard');
  const perCard = cards.map((card) => card.findAll('.ui-switch__label')
    .filter((label) => label.text() === 'Запретить прямой SSH').length);
  const outsideCards = wrapper.findAll('.ui-switch__label')
    .filter((label) => label.text() === 'Запретить прямой SSH'
      && !label.element.closest('.pvcard')).length;

  assert.deepEqual({ cards: cards.length, perCard, outsideCards }, {
    cards: 4,
    perCard: [1, 1, 1, 1],
    outsideCards: 0,
  });
});

test('отмена точного предупреждения оставляет запрет включённым и ничего не сохраняет', async (t) => {
  const { wrapper, confirmations, saves, flushPromises } = await mountSettings(t, {
    confirmImpl: async () => false,
  });
  const toggle = wrapper.findAll('.pvcard')[0].get('[role="switch"]');
  await toggle.trigger('click');
  await flushPromises();

  assert.deepEqual({
    confirmation: confirmations[0],
    saves,
    checked: toggle.attributes('aria-checked'),
  }, {
    confirmation: [RISK_TEXT, { okText: 'Разрешить прямой SSH', danger: true }],
    saves: [],
    checked: 'true',
  });
});

test('принятое предупреждение сохраняет false как подтверждённое изменение', async (t) => {
  const { wrapper, confirmations, saves, flushPromises } = await mountSettings(t);
  await wrapper.findAll('.pvcard')[1].get('[role="switch"]').trigger('click');
  await flushPromises();

  assert.deepEqual({ confirmation: confirmations[0], save: saves[0] }, {
    confirmation: [RISK_TEXT, { okText: 'Разрешить прямой SSH', danger: true }],
    save: ['beta-next', 'blockDirectSsh', false, true],
  });
});

test('включение запрета не требует подтверждения', async (t) => {
  const { wrapper, confirmations, saves, flushPromises } = await mountSettings(t, {
    initialValue: false,
  });
  await wrapper.findAll('.pvcard')[0].get('[role="switch"]').trigger('click');
  await flushPromises();

  assert.deepEqual({ confirmations, save: saves[0] }, {
    confirmations: [],
    save: ['alpha-next', 'blockDirectSsh', true],
  });
});

test('mode-dependent пояснение неспособного исполнителя видно в его карточке', async (t) => {
  const { wrapper } = await mountSettings(t);
  const gamma = wrapper.findAll('.pvcard')[2];

  assert.match(gamma.text(), /Host-режим не умеет обеспечить запрет и остановит ход/);
});

test('пока подтверждение открыто, повторный клик не создаёт второй диалог', async (t) => {
  let finish;
  const waiting = new Promise((resolve) => { finish = resolve; });
  const { wrapper, confirmations, saves, flushPromises } = await mountSettings(t, {
    confirmImpl: () => waiting,
  });
  const toggle = wrapper.findAll('.pvcard')[0].get('[role="switch"]');
  await toggle.trigger('click');
  await toggle.trigger('click');
  await flushPromises();
  const during = {
    confirmations: confirmations.length,
    saves: saves.length,
    disabled: toggle.attributes('disabled') !== undefined,
  };
  finish(false);
  await flushPromises();

  assert.deepEqual(during, { confirmations: 1, saves: 0, disabled: true });
});
