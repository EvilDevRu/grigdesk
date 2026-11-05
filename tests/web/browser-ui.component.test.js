import { measured } from './helpers/performance-surface.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { compileVue, compileModule, webFile } from './helpers/compile-vue.js';
import { createUiBrowser } from './helpers/ui-components.js';
import { createSettingsSession } from '../../web/src/features/settings/session.ts';
import {
  SETTINGS_FIELDS,
  getSettingsFields,
  getSettingsPages,
} from '../../web/src/features/settings/catalog.ts';

const windowFixture = await createUiBrowser();

test.after(() => windowFixture.close());

const [{ reactive, nextTick }, { mount, flushPromises }] = await Promise.all([
  import('../../web/node_modules/vue/index.mjs'),
  import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
]);
const browserStub = 'export const useBrowserStore = () => globalThis.__browserUiHarness.browser;';
const settingsStub = 'export const useSettingsStore = () => globalThis.__browserUiHarness.settings;';
const stubs = {
  '../stores/browser.ts': browserStub,
  '../../stores/browser.ts': browserStub,
  '../../../stores/browser.ts': browserStub,
  '../../stores/settings.ts': settingsStub,
  '../../../stores/settings.ts': settingsStub,
  'vue-router': 'export const useRouter = () => globalThis.__browserUiHarness.router;',
  '../shared/browser/BrowserViewport.vue': `
    import { defineComponent, h, onBeforeUnmount } from 'vue';
    export default defineComponent({
      setup() {
        onBeforeUnmount(() => globalThis.__browserUiHarness.calls.push({ operation: 'hide' }));
        return () => h('div', { 'data-browser-viewport': '' });
      },
    });
  `,
};
const [BrowserView, BrowserPage, StandLink] = await Promise.all([
  compileVue(webFile('src/views/BrowserView.vue'), { stubs }),
  compileVue(webFile('src/views/settings/pages/BrowserPage.vue'), { stubs }),
  compileVue(webFile('src/shared/browser/StandLink.vue'), { stubs }),
]);

function tab(id, url = 'http://fixture.test/' + id) {
  return {
    id,
    url,
    title: 'Fixture ' + id,
    favicon: null,
    agentWorking: false,
    creator: 'human',
    owner: null,
    grantee: null,
    grantOrigin: null,
    grantEpoch: 1,
    pageEpoch: 1,
    paused: false,
    loading: false,
    error: '',
    canBack: true,
    canForward: true,
    zoom: 100,
  };
}

/**
 * Доменный port не выдаёт owner человеческому open и сохраняет URL/epochs snapshot.
 * Настройки используют настоящую независимую staged session вместо имитации Apply.
 */
function harness() {
  const calls = [];
  const routes = [];
  const raw = {
    revision: 1,
    preferences: {
      open: 'internal',
      external: 'system',
      agents: true,
      search: 'yandex'
    },
    tabs: [tab('one'), tab('two')],
    active: 'one',
    grants: [],
  };
  const session = createSettingsSession();

  session.begin();

  const settings = reactive({
    isOpen: true,
    pageId: 'tools.browser',
    snapshot: session.getSnapshot(),
    revealTarget: null,
    registerResource: session.register,
    loadResource: session.load,
    getValue: session.getValue,
    setField: session.setField,
    resolveConflict: session.resolveConflict,
    fieldMetadata: (address) => getSettingsFields('ru')
      .find((field) => field.resourceId === 'browser' && field.key === address.fieldPath[0]),
  });
  const stop = session.subscribe(() => {
    settings.snapshot = session.getSnapshot();
  });
  let failControl = false;
  let failNative = false;
  let nativeHold = null;
  let chosenApp = { id: 'app:manual-fixture', name: 'Fixture browser' };
  const browser = reactive({
    snapshot: structuredClone(raw),
    available: true,
    busy: 0,
    error: '',
    apps: [{ id: 'app:ff', name: 'Fixture installed' }],
    owners: [{ id: 'owner-one', label: 'Чат fixture' }],
    hostStatus: { phase: 'online', error: '' },
    get preferences() {
      return browser.snapshot.preferences;
    },
    get active() {
      return browser.snapshot.tabs.find((item) => item.id === browser.snapshot.active);
    },
    apply: (value) => {
      browser.snapshot = structuredClone(value);
    },
    refresh: async () => {},
    loadApps: async () => {},
    loadOwners: async () => {},
    retryHost: (takeover) => {
      calls.push({ operation: 'retry', takeover });
    },
    disablePreference: async () => {
      calls.push({ operation: 'mode-off' });
    },
    grant: async (input) => {
      calls.push({ operation: 'grant', input });
    },
    revoke: async (tabId) => {
      calls.push({ operation: 'revoke', tabId });
    },
    chooseApp: async () => {
      calls.push({ operation: 'choose-app' });
      browser.apps.push(chosenApp);

      return chosenApp;
    },
    native: async (request) => {
      calls.push(structuredClone(request));

      if (failNative) {
        throw new Error('native failed');
      }
      if (nativeHold) {
        await nativeHold;
      }

      if (request.operation === 'preferences') {
        raw.preferences = structuredClone(request.value);
        raw.revision += 1;

        return { preferences: raw.preferences, revision: raw.revision };
      }

      return structuredClone(raw);
    },
    control: async (request) => {
      calls.push(structuredClone(request));

      if (failControl) {
        browser.error = 'browser_request_failed';

        throw new Error('native failed');
      }

      if (request.operation === 'open' && request.target === 'internal') {
        const next = tab('new-' + calls.length, request.url);

        browser.snapshot.tabs.push(next);
        browser.snapshot.active = next.id;
      } else if (request.operation === 'activate') {
        browser.snapshot.active = request.tabId;
      } else if (request.operation === 'navigate') {
        browser.active.url = request.url;
      } else if (request.operation === 'close') {
        browser.snapshot.tabs = browser.snapshot.tabs.filter((item) => item.id !== request.tabId);

        if (browser.snapshot.active === request.tabId) {
          browser.snapshot.active = browser.snapshot.tabs[0]?.id ?? null;
        }
      } else if (request.operation === 'move') {
        const moving = browser.snapshot.tabs.find((item) => item.id === request.tabId);
        const rest = browser.snapshot.tabs.filter((item) => item.id !== request.tabId);
        const index = request.beforeId === null ? rest.length
          : rest.findIndex((item) => item.id === request.beforeId);

        rest.splice(index, 0, moving);
        browser.snapshot.tabs = rest;
      }
    },
  });
  const value = {
    setFailNative: (value) => {
      failNative = value;
    },
    holdNative: (promise) => {
      nativeHold = promise;
    },
    browser,
    settings,
    calls,
    routes,
    session,
    router: { push: async (path) => {
      routes.push(path);
    } },
    fail: () => {
      failControl = true;
    },
    cleanup: () => {
      stop();
      session.dispose();
    },
  };

  globalThis.__browserUiHarness = value;

  return value;
}

async function rendered() {
  await flushPromises();
  await nextTick();
}

/**
 * Каждый сценарий монтирует настоящий SFC с отдельным domain harness.
 * Очистка освобождает Vue wrapper и staged session даже при упавшем assertion.
 */
function mounted(t, Component, props = {}) {
  const fixture = harness();
  const wrapper = mount(Component, { props, attachTo: document.body });

  t.after(() => {
    if (wrapper.exists()) {
      wrapper.unmount();
    }

    fixture.cleanup();
    delete globalThis.__browserUiHarness;
  });

  return { ...fixture, wrapper };
}

test('BR-U01: адрес, switching tabs, unmount сохраняет guest и не отправляет close', async (t) => {
  const f = mounted(t, BrowserView);

  await rendered();
  await f.wrapper.get('input[aria-label="Адрес"]').setValue('https://fixture.test/form');
  await f.wrapper.get('form').trigger('submit');
  await rendered();
  assert.equal(f.calls.some((item) => item.operation === 'navigate'
    && item.tabId === 'one' && item.url === 'https://fixture.test/form'), true);
  await f.wrapper.findAll('[role="tab"]')[1].trigger('click');
  await rendered();
  assert.equal(f.browser.snapshot.active, 'two');
  f.wrapper.unmount();
  assert.equal(f.calls.some((item) => item.operation === 'hide'), true);
  assert.equal(f.calls.some((item) => item.operation === 'close'), false);
  assert.equal(f.browser.snapshot.tabs.length, 2);
});

test('BR-U02: site navigation не стирает focused draft; Ctrl+T/W управляют guest', async (t) => {
  const f = mounted(t, BrowserView);

  await rendered();

  const address = f.wrapper.get('input[aria-label="Адрес"]');

  await address.trigger('focus');
  await address.setValue('https://draft.test/');
  f.browser.active.url = 'https://site-navigation.test/';
  await rendered();
  assert.equal(address.element.value, 'https://draft.test/');

  const create = new window.KeyboardEvent('keydown', {
    key: 't',
    ctrlKey: true,
    cancelable: true
  });

  window.dispatchEvent(create);
  await rendered();
  assert.equal(create.defaultPrevented, true);
  assert.equal(f.calls.some((item) => item.operation === 'open'
    && item.url === '' && item.deduplicate === false && !('owner' in item)), true);

  const close = new window.KeyboardEvent('keydown', {
    key: 'w',
    ctrlKey: true,
    cancelable: true
  });
  const closingId = f.browser.snapshot.active;

  window.dispatchEvent(close);
  await rendered();
  assert.equal(close.defaultPrevented, true);
  assert.equal(f.calls.some((item) => item.operation === 'close'
    && item.tabId === closingId), true);
});

test('BR-U12: guest intent приходит через preload subscription и снимается при unmount', async (t) => {
  const previous = window.grigdeskBrowser;
  let deliver;
  let stopped = 0;

  window.grigdeskBrowser = {
    subscribeIntent: (listener) => {
      deliver = listener;

      return () => {
        stopped += 1;
        deliver = undefined;
      };
    },
  };
  t.after(() => {
    window.grigdeskBrowser = previous;
  });

  const f = mounted(t, BrowserView);

  await rendered();
  assert.equal(typeof deliver, 'function');
  deliver({ intent: 'new' });
  deliver('shutdown');
  await rendered();
  assert.equal(f.calls.some((item) => item.operation === 'open'), false);
  deliver('address');
  assert.equal(document.activeElement === f.wrapper.get('input[aria-label="Адрес"]').element, true);
  deliver('new');
  await rendered();
  assert.equal(f.calls.some((item) => item.operation === 'open' && item.url === ''), true);
  deliver('back');
  await rendered();
  assert.equal(f.calls.some((item) => item.operation === 'back'), true);
  deliver('close');
  await rendered();
  assert.equal(f.calls.some((item) => item.operation === 'close'), true);
  f.wrapper.unmount();
  assert.equal(stopped, 1);
  assert.equal(deliver, undefined);
});

test('BR-U13: адрес без схемы и поисковый запрос проходят настоящее поле и выбранный engine', async (t) => {
  const f = mounted(t, BrowserView);

  await rendered();

  const input = f.wrapper.get('input[aria-label="Адрес"]');

  assert.equal(input.attributes('type'), 'text');
  await input.setValue('ya.ru');
  await f.wrapper.get('form').trigger('submit');
  await rendered();
  assert.equal(f.browser.active.url, 'https://ya.ru/');

  for (const search of ['yandex', 'google']) {
    f.browser.snapshot.preferences.search = search;
    await input.setValue('найти кота & собаку');
    await f.wrapper.get('form').trigger('submit');
    await rendered();

    const url = new URL(f.browser.active.url);

    assert.equal(url.hostname, search === 'google' ? 'www.google.com' : 'yandex.ru');
    assert.equal(url.searchParams.get(search === 'google' ? 'q' : 'text'), 'найти кота & собаку');
  }
});

test('BR-U14: контекстное меню фоновой вкладки, дубликат и закрытие справа/остальных', async (t) => {
  const f = mounted(t, BrowserView);

  f.browser.snapshot.tabs.push(tab('three'));
  await rendered();
  await f.wrapper.get('#browser-tab-two').trigger('click');
  await rendered();
  assert.equal(document.querySelector('[role="menu"]'), null);
  await f.wrapper.get('#browser-tab-one').trigger('contextmenu');
  await rendered();
  assert.equal(f.browser.snapshot.active, 'two');
  assert.equal(document.querySelectorAll('[role="menuitem"]').length, 7);
  [...document.querySelectorAll('[role="menuitem"]')]
    .find((item) => item.textContent.includes('Дублировать')).click();
  await rendered();

  const duplicate = f.calls.find((item) => item.operation === 'open');

  assert.equal(duplicate.url, 'http://fixture.test/one');
  assert.equal(duplicate.deduplicate, false);
  assert.equal('owner' in duplicate, false);

  await f.wrapper.get('#browser-tab-two').trigger('contextmenu');
  await rendered();
  [...document.querySelectorAll('[role="menuitem"]')]
    .find((item) => item.textContent.includes('Закрыть вкладки справа')).click();
  await rendered();
  assert.deepEqual(f.browser.snapshot.tabs.map((item) => item.id), ['one', 'two']);
  await f.wrapper.get('#browser-tab-two').trigger('keydown', { key: 'F10', shiftKey: true });
  await rendered();
  [...document.querySelectorAll('[role="menuitem"]')]
    .find((item) => item.textContent.includes('Закрыть другие')).click();
  await rendered();
  assert.deepEqual(f.browser.snapshot.tabs.map((item) => item.id), ['two']);
  assert.equal(f.browser.snapshot.active, 'two');
  await f.wrapper.get('#browser-tab-two').trigger('auxclick', { button: 1 });
  await rendered();
  assert.equal(f.browser.snapshot.tabs.length, 0);
});

test('BR-U16: робот отражает owner/grantee доступ, паузу и подпись исполнителя', async (t) => {
  const f = mounted(t, BrowserView);
  const owner = JSON.stringify(['chat', null, 'fixture-owner', null]);
  const grantee = JSON.stringify(['chat', null, 'fixture-controller', null]);

  f.browser.snapshot.tabs = [
    tab('human'),
    {
      ...tab('owner'),
      creator: 'agent',
      owner,
      grantOrigin: 'http://fixture.test',
    },
    {
      ...tab('agent-grant'),
      creator: 'agent',
      owner,
      grantee,
    },
    {
      ...tab('human-grant'),
      grantee,
      grantOrigin: 'http://fixture.test',
      paused: true,
    },
    {
      ...tab('unused'),
      creator: 'agent',
      owner,
      paused: true,
    },
    {
      ...tab('human-origin'),
      grantOrigin: 'http://fixture.test',
    },
  ];
  f.browser.snapshot.active = 'human';
  await rendered();

  for (const id of ['owner', 'agent-grant', 'human-grant']) {
    const icon = f.wrapper.get(`#browser-tab-${id} .browser-tab-agent`);

    assert.equal(icon.find('[data-browser-tab-robot]').exists(), true);
    assert.equal(f.wrapper.find(`#browser-tab-${id} [data-browser-tab-globe]`).exists(), true);
    assert.equal(icon.attributes('aria-hidden'), 'true');
    assert.equal(icon.attributes('data-agent-state'), id === 'human-grant' ? 'paused' : 'active');
    assert.equal(icon.attributes('data-ui-tooltip'), id === 'human-grant'
      ? 'Управляет: Чат fixture-controller' : 'Владелец: Чат fixture-owner');
  }

  for (const id of ['human', 'unused', 'human-origin']) {
    const icon = f.wrapper.get(`#browser-tab-${id} .browser-tab-icon`);

    assert.equal(icon.find('[data-browser-tab-robot]').exists(), false);
    assert.equal(icon.find('[data-browser-tab-globe] circle').exists(), true);
    assert.equal(icon.attributes('data-agent-state'), undefined);
    assert.equal(icon.attributes('data-ui-tooltip'), undefined);
  }
});

test('BR-U17: смена доступа сохраняет иконку сайта 14×14 и обрезку названия', async (t) => {
  const f = mounted(t, BrowserView);
  const style = document.createElement('style');
  const source = await readFile(webFile('src/views/BrowserView.vue'), 'utf8');

  style.textContent = [
    await readFile(webFile('src/styles/tokens.css'), 'utf8'),
    await readFile(webFile('src/styles/components/patterns.css'), 'utf8'),
    source.split('<style scoped>')[1].split('</style>')[0],
  ].join('\n');
  document.head.append(style);
  t.after(() => style.remove());
  await rendered();

  const button = f.wrapper.get('#browser-tab-one').element;
  const icon = button.querySelector('.browser-tab-icon');
  const label = button.querySelector('.browser-tab-label');
  const owner = JSON.stringify(['chat', null, 'fixture-owner', null]);
  const states = [
    {
      owner: null,
      grantee: null,
      grantOrigin: null,
      paused: false,
    },
    {
      owner,
      grantee: null,
      grantOrigin: 'http://fixture.test',
      paused: false,
    },
    {
      owner,
      grantee: null,
      grantOrigin: 'http://fixture.test',
      paused: true,
    },
    {
      owner,
      grantee: null,
      grantOrigin: null,
      paused: true,
    },
    {
      owner: null,
      grantee: owner,
      grantOrigin: 'http://fixture.test',
      paused: false,
    },
  ];

  for (const state of states) {
    Object.assign(f.browser.active, state);
    await rendered();

    const iconStyle = getComputedStyle(icon);
    const labelStyle = getComputedStyle(label);

    assert.equal(button.children.length, state.grantee || state.owner && state.grantOrigin ? 3 : 2);
    assert.equal(button.children[0] === icon, true);
    assert.equal(button.children[button.children.length - 1] === label, true);
    assert.equal(iconStyle.flex, '0 0 auto');
    assert.equal(iconStyle.width, '14px');
    assert.equal(iconStyle.height, '14px');
    assert.equal(labelStyle.minWidth, '0');
    assert.equal(labelStyle.textOverflow, 'ellipsis');

    if (state.paused && state.grantOrigin !== null) {
      assert.equal(getComputedStyle(button.querySelector('.browser-tab-agent')).opacity, '0.48');
    }
  }
});

test('BR-U22: favicon рядом с роботом, пульсация только у работающей вкладки', async (t) => {
  const f = mounted(t, BrowserView);
  const owner = JSON.stringify(['chat', null, 'fixture-owner', null]);
  const favicon = 'data:image/png;base64,AQ==';

  Object.assign(f.browser.snapshot.tabs[0], { favicon, grantee: owner });
  Object.assign(f.browser.snapshot.tabs[1], { grantee: owner, agentWorking: true });
  await rendered();
  assert.equal(f.wrapper.get('#browser-tab-one img').attributes('src'), favicon);
  assert.equal(f.wrapper.get('#browser-tab-one .browser-tab-agent').attributes('data-agent-state'), 'active');
  assert.equal(f.wrapper.get('#browser-tab-two .browser-tab-agent')
    .attributes('data-agent-state'), 'working');

  f.browser.snapshot.tabs[1].agentWorking = false;
  f.browser.snapshot.tabs[0].agentWorking = true;
  await rendered();
  assert.equal(f.wrapper.get('#browser-tab-one .browser-tab-agent')
    .attributes('data-agent-state'), 'working');
  assert.equal(f.wrapper.get('#browser-tab-two .browser-tab-agent').attributes('data-agent-state'), 'active');

  f.browser.snapshot.tabs[0].paused = true;
  await rendered();
  assert.equal(f.wrapper.get('#browser-tab-one .browser-tab-agent').attributes('data-agent-state'), 'paused');
  await f.wrapper.get('#browser-tab-one img').trigger('error');
  assert.equal(f.wrapper.find('#browser-tab-one [data-browser-tab-globe]').exists(), true);
  assert.equal(f.wrapper.find('#browser-tab-one .browser-tab-agent').exists(), true);

  f.browser.snapshot.tabs[0].favicon = 'data:image/png;base64,Ag==';
  await rendered();
  assert.equal(f.wrapper.get('#browser-tab-one img').attributes('src'), 'data:image/png;base64,Ag==');
});

for (const menuTab of ['one', 'dead-a']) {
  test(`BR-U18: очистка из меню ${menuTab} закрывает только мёртвые agent-вкладки`, async (t) => {
    const f = mounted(t, BrowserView);
    const owner = JSON.stringify(['chat', null, 'fixture-owner', null]);
    const agent = { creator: 'agent', owner };
    const origin = { grantOrigin: 'http://fixture.test' };

    f.browser.snapshot.tabs = [
      tab('one'),
      {
        ...tab('human-origin'),
        ...origin,
      },
      {
        ...tab('dead-a'),
        ...agent,
      },
      {
        ...tab('owner-live'),
        ...agent,
        ...origin,
      },
      {
        ...tab('owner-paused'),
        ...agent,
        ...origin,
        paused: true,
      },
      {
        ...tab('agent-grant'),
        ...agent,
        grantee: owner,
      },
      {
        ...tab('agent-paused'),
        ...agent,
        grantee: owner,
        paused: true,
      },
      {
        ...tab('human-grant'),
        grantee: owner,
        ...origin,
      },
      {
        ...tab('human-paused'),
        grantee: owner,
        ...origin,
        paused: true,
      },
      {
        ...tab('dead-b'),
        ...agent,
        paused: true,
      },
    ];
    await rendered();
    await f.wrapper.get(`#browser-tab-${menuTab}`).trigger('contextmenu');
    await rendered();

    const item = [...document.querySelectorAll('[role="menuitem"]')]
      .find((item) => item.textContent.trim() === 'Закрыть неиспользуемые');

    assert.equal(item.disabled, false);
    item.click();
    await rendered();
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.deepEqual(f.calls.filter((item) => item.operation === 'close').map((item) => item.tabId),
      ['dead-a', 'dead-b']);
    assert.deepEqual(f.browser.snapshot.tabs.map((item) => item.id), [
      'one', 'human-origin', 'owner-live', 'owner-paused', 'agent-grant', 'agent-paused',
      'human-grant', 'human-paused',
    ]);
    assert.equal(f.browser.snapshot.active, 'one');
    assert.equal(document.activeElement.id, 'browser-tab-one');

    await f.wrapper.get('#browser-tab-one').trigger('contextmenu');
    await rendered();

    const disabled = [...document.querySelectorAll('[role="menuitem"]')]
      .find((item) => item.textContent.trim() === 'Закрыть неиспользуемые');

    assert.equal(disabled.disabled, true);
    disabled.click();
    await rendered();
    assert.equal(f.calls.filter((item) => item.operation === 'close').length, 2);
  });
}

test('BR-U19: очистка ждёт ACK и фиксирует кандидатов до первого запроса', async (t) => {
  const f = mounted(t, BrowserView);
  const agent = { creator: 'agent', owner: JSON.stringify(['chat', null, 'fixture-owner', null]) };
  const control = f.browser.control;
  const started = [];
  let release;
  const ack = new Promise((resolve) => {
    release = resolve;
  });

  f.browser.snapshot.tabs.push({ ...tab('dead-a'), ...agent }, { ...tab('dead-b'), ...agent });
  f.browser.control = async (request) => {
    started.push(request.tabId);

    if (request.tabId === 'dead-a') {
      await ack;
    }

    await control(request);
  };
  await rendered();
  await f.wrapper.get('#browser-tab-two').trigger('contextmenu');
  await rendered();
  [...document.querySelectorAll('[role="menuitem"]')]
    .find((item) => item.textContent.trim() === 'Закрыть неиспользуемые').click();
  await rendered();
  assert.equal(document.querySelector('[role="menu"]'), null);
  assert.deepEqual(started, ['dead-a']);
  f.browser.snapshot.tabs.push({ ...tab('dead-late'), ...agent });
  release();
  await rendered();
  assert.deepEqual(started, ['dead-a', 'dead-b']);
  assert.deepEqual(f.browser.snapshot.tabs.map((item) => item.id), ['one', 'two', 'dead-late']);
  assert.equal(document.activeElement.id, 'browser-tab-one');
});

test('BR-U20: очистка прекращается при первом отказе native и возвращает фокус', async (t) => {
  const f = mounted(t, BrowserView);
  const agent = { creator: 'agent', owner: JSON.stringify(['chat', null, 'fixture-owner', null]) };
  const control = f.browser.control;

  f.browser.snapshot.tabs.push(...['dead-a', 'dead-b', 'dead-c']
    .map((id) => ({ ...tab(id), ...agent })));
  f.browser.control = async (request) => {
    await control(request);

    if (request.tabId === 'dead-a') {
      f.fail();
    }
  };
  await rendered();
  await f.wrapper.get('#browser-tab-dead-a').trigger('contextmenu');
  await rendered();
  [...document.querySelectorAll('[role="menuitem"]')]
    .find((item) => item.textContent.trim() === 'Закрыть неиспользуемые').click();
  await rendered();
  assert.deepEqual(f.calls.filter((item) => item.operation === 'close').map((item) => item.tabId),
    ['dead-a', 'dead-b']);
  assert.deepEqual(f.browser.snapshot.tabs.map((item) => item.id), ['one', 'two', 'dead-b', 'dead-c']);
  assert.equal(f.wrapper.find('[role="alert"]').exists(), true);
  assert.equal(document.activeElement.id, 'browser-tab-one');
});

test('BR-U21: очистка последней вкладки переводит фокус в адресную строку', async (t) => {
  const f = mounted(t, BrowserView);

  f.browser.snapshot.tabs = [{
    ...tab('one'),
    creator: 'agent',
    owner: JSON.stringify(['chat', null, 'fixture-owner', null]),
  }];
  await rendered();
  await f.wrapper.get('#browser-tab-one').trigger('contextmenu');
  await rendered();
  [...document.querySelectorAll('[role="menuitem"]')]
    .find((item) => item.textContent.trim() === 'Закрыть неиспользуемые').click();
  await rendered();
  assert.equal(f.browser.snapshot.tabs.length, 0);
  assert.equal(document.activeElement === f.wrapper.get('input[aria-label="Адрес"]').element, true);
});

test('BR-U15: перенос меняет native порядок, а стрелки следуют новому DOM порядку', async (t) => {
  const f = mounted(t, BrowserView);

  f.browser.snapshot.tabs.push(tab('three'));
  await rendered();

  const rows = f.wrapper.findAll('[data-ui-browser-tab]');
  const dataTransfer = {
    effectAllowed: '',
    dropEffect: '',
    setData() {},
  };

  await rows[2].trigger('dragstart', { dataTransfer });
  await rows[0].trigger('dragover', { dataTransfer, clientX: -1 });
  await rows[0].trigger('drop', { dataTransfer });
  await rendered();
  assert.deepEqual(f.calls.find((item) => item.operation === 'move'), {
    operation: 'move',
    tabId: 'three',
    beforeId: 'one',
  });
  assert.deepEqual(f.wrapper.findAll('[role="tab"]').map((item) => item.attributes('id')),
    ['browser-tab-three', 'browser-tab-one', 'browser-tab-two']);

  const moved = f.wrapper.get('#browser-tab-three');

  moved.element.focus();
  await moved.trigger('keydown', { key: 'ArrowRight' });
  await rendered();
  assert.equal(f.browser.snapshot.active, 'one');
  assert.equal(document.activeElement.id, 'browser-tab-one');
});

test('BR-U03: pause/revoke доступны при busy, grant несёт captured epochs', async (t) => {
  const f = mounted(t, BrowserView);

  f.browser.busy = 1;
  f.browser.active.pageEpoch = 17;
  f.browser.active.grantEpoch = 9;
  await rendered();

  const pause = f.wrapper.findAll('button').find((button) => button.text() === 'Приостановить');

  assert.equal(pause.attributes('disabled'), undefined);
  await pause.trigger('click');
  await f.wrapper.get('select[aria-label="Передать управление"]').setValue('owner-one');
  await f.wrapper.findAll('button').find((button) => button.text() === 'Передать').trigger('click');
  await rendered();
  assert.deepEqual(f.calls.find((item) => item.operation === 'grant').input, {
    tabId: 'one',
    ownerId: 'owner-one',
    pageEpoch: 17,
    grantEpoch: 9,
  });
  assert.equal(f.calls.some((item) => item.operation === 'pause'), true);
});

test('BR-U04: settings edits/file picker остаются draft, только Apply пишет полный record', async (t) => {
  const f = mounted(t, BrowserPage, { active: true });

  await rendered();
  await f.wrapper.get('select[aria-label="Открывать стенды"]').setValue('external');
  await f.wrapper.get('select[aria-label="Поиск по умолчанию"]').setValue('google');
  await f.wrapper.get('input[role="switch"]').setValue(false);
  await f.wrapper.findAll('button')
    .find((button) => button.text() === 'Выбрать приложение…').trigger('click');
  await rendered();
  assert.equal(f.calls.filter((item) => item.operation === 'preferences').length, 0);
  assert.equal(f.session.getValue('browser', 'external'), 'app:manual-fixture');

  const result = await f.session.apply();

  assert.equal(result.status, 'success');
  assert.deepEqual(f.calls.find((item) => item.operation === 'preferences').value, {
    open: 'external',
    external: 'app:manual-fixture',
    agents: false,
    search: 'google',
  });
  assert.equal(f.settings.snapshot.dirtyCount, 0);
});

test('BR-U05: browser page without native остаётся видимой и не пишет server prefs', async (t) => {
  const f = mounted(t, BrowserPage, { active: false });

  f.browser.available = false;
  await f.wrapper.setProps({ active: true });
  await rendered();
  assert.equal(f.wrapper.text().includes('Доступно в приложении на компьютере'), true);
  assert.equal(f.wrapper.findAll('select')
    .every((control) => control.attributes('disabled') !== undefined), true);
  assert.equal(f.calls.length, 0);
});

test('BR-U06: обычный href fallback, native override, middle click и отсутствие второго запуска',
  async (t) => {
  const f = mounted(t, StandLink, { href: 'http://fixture.test/stand' });

  await rendered();

  const anchor = f.wrapper.get('a').element;
  const internal = new window.MouseEvent('click', {
    button: 0,
    ctrlKey: true,
    cancelable: true
  });

  anchor.dispatchEvent(internal);
  await rendered();
  assert.equal(internal.defaultPrevented, true);
  assert.deepEqual(f.routes, ['/browser']);

  const middle = new window.MouseEvent('auxclick', { button: 1, cancelable: true });

  anchor.dispatchEvent(middle);
  await rendered();
  assert.equal(f.calls.filter((item) => item.operation === 'open').at(-1).deduplicate, false);
  f.browser.available = false;
  await rendered();

  const external = new window.MouseEvent('click', { button: 0, cancelable: true });
  const count = f.calls.length;

  anchor.dispatchEvent(external);
  await rendered();
  assert.equal(external.defaultPrevented, false);
  assert.equal(anchor.getAttribute('href'), 'http://fixture.test/stand');
  assert.equal(f.calls.length, count);
  f.browser.available = true;
  f.fail();
  await rendered();
  anchor.dispatchEvent(new window.MouseEvent('click', { button: 0, cancelable: true }));
  await rendered();
  assert.equal(f.calls.length, count + 1);
  assert.equal(f.wrapper.find('[role="alert"]').exists(), true);
});

test('BR-U07: catalog/page metadata RU/EN содержит четыре точных browser поля', () => {
  const ru = getSettingsFields('ru').filter((field) => field.resourceId === 'browser');
  const en = getSettingsFields('en').filter((field) => field.resourceId === 'browser');
  const pages = getSettingsPages('en').map((page) => page.id);

  assert.deepEqual(ru.map((field) => field.key), ['open', 'external', 'search', 'agents']);
  assert.equal(ru.every((field) => field.address.pageId === 'tools.browser'), true);
  assert.equal(en.every((field) => field.label !== ru.find((old) => old.key === field.key).label), true);
  assert.equal(pages.indexOf('tools.browser'), pages.indexOf('tools.showcase') + 1);
  assert.equal(SETTINGS_FIELDS.filter((field) => field.resourceId === 'browser').length, 4);
});

test('BR-U08: настоящий store отвергает старый snapshot и отзывает native до сетевого сбоя', async (t) => {
  const [{ createPinia, setActivePinia }, module] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    compileModule(webFile('src/stores/browser.ts'), {
      stubs: { './shell.ts': 'export const useShellStore = () => ({ snapshot: null });' },
    }),
  ]);
  const previous = window.grigdeskBrowser;
  const order = [];
  const state = {
    revision: 3,
    preferences: {
      open: 'internal',
      external: 'system',
      agents: true,
      search: 'yandex'
    },
    active: 'one',
    tabs: [tab('one')],
    grants: [],
  };

  window.grigdeskBrowser = {
    invoke: async (request) => {
      order.push(request.operation);

      return state;
    },
  };
  t.after(() => {
    window.grigdeskBrowser = previous;
  });
  setActivePinia(createPinia());

  const store = module.useBrowserStore();

  store.apply(state);
  store.apply({
    ...state,
    revision: 1,
    active: null,
    tabs: []
  });
  assert.equal(store.snapshot.tabs.length, 1);
  store.bindHost({
    retry: () => {},
    sync: async () => {},
    owners: async () => [],
    grant: async () => state,
    revoke: async () => {
      order.push('server-revoke');

      throw new Error('offline');
    },
    disablePreference: async () => {},
  });
  await store.revoke('one');
  assert.deepEqual(order, ['revoke', 'server-revoke']);
  assert.equal(store.error, 'browser_sync_failed');
});

test('BR-U09: push новее initial GET, unsubscribe освобождается один раз', async (t) => {
  const [{ createPinia, setActivePinia }, module] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    compileModule(webFile('src/stores/browser.ts'), {
      stubs: { './shell.ts': 'export const useShellStore = () => ({ snapshot: null });' },
    }),
  ]);
  const previous = window.grigdeskBrowser;
  let deliver;
  let resolveRead;
  let stopped = 0;
  const read = new Promise((resolve) => {
    resolveRead = resolve;
  });
  const state = {
    revision: 7,
    preferences: {
      open: 'internal',
      external: 'system',
      agents: false,
      search: 'yandex'
    },
    active: 'one',
    tabs: [tab('one')],
    grants: [],
  };

  window.grigdeskBrowser = {
    invoke: async () => read,
    subscribe: (listener) => {
      deliver = listener;

      return () => {
        stopped += 1;
      };
    },
  };
  t.after(() => {
    window.grigdeskBrowser = previous;
  });
  setActivePinia(createPinia());

  const store = module.useBrowserStore();
  const stop = store.startSnapshots();

  deliver(state);
  resolveRead({
    ...state,
    revision: 2,
    active: null,
    tabs: []
  });
  await rendered();
  assert.equal(store.snapshot.revision, 7);
  assert.equal(store.snapshot.tabs.length, 1);
  stop();
  stop();
  assert.equal(stopped, 1);
});

test('BR-U11: canonical owner/grantee и native history/zoom переживают decoder', async () => {
  const { browserOwnerScope, decodeBrowserSnapshot } = await compileModule(
    webFile('src/shared/browser/browserUi.ts'),
  );
  const owner = JSON.stringify(['chat', null, 'free-chat-7', null]);
  const grantee = JSON.stringify(['task', 'sample', '77', 'a_' + 'a'.repeat(32)]);
  const raw = {
    revision: 1,
    preferences: {
      open: 'internal',
      external: 'system',
      agents: true,
      search: 'yandex'
    },
    active: 'one',
    tabs: [{
      ...tab('one'),
      owner,
      grantee,
      canBack: true,
      canForward: false,
      zoom: 150
    }],
    grants: [],
  };
  const state = decodeBrowserSnapshot(raw);

  assert.equal(state.tabs[0].owner, owner);
  assert.equal(state.tabs[0].grantee, grantee);
  assert.deepEqual(browserOwnerScope(owner), { kind: 'chat', key: 'free-chat-7' });
  assert.deepEqual(browserOwnerScope(grantee), { kind: 'task', key: '77' });
  assert.equal(state.tabs[0].canBack, true);
  assert.equal(state.tabs[0].canForward, false);
  assert.equal(state.tabs[0].zoom, 150);
  assert.equal(state.tabs[0].favicon, null);
  assert.equal(state.tabs[0].agentWorking, false);

  const iconState = decodeBrowserSnapshot({
    ...raw,
    tabs: [{
      ...raw.tabs[0],
      favicon: 'data:image/png;base64,AQ==',
      agentWorking: true
    }],
  });

  assert.equal(iconState.tabs[0].favicon, 'data:image/png;base64,AQ==');
  assert.equal(iconState.tabs[0].agentWorking, true);

  const invalidIcons = [
    'https://fixture.test/icon.png',
    'javascript:alert(1)',
    'data:text/html;base64,AQ=='
  ];

  for (const favicon of invalidIcons) {
    const invalid = decodeBrowserSnapshot({ ...raw, tabs: [{ ...raw.tabs[0], favicon }] });

    assert.equal(invalid.tabs[0].favicon, null);
  }

  assert.equal(browserOwnerScope(null), null);
  assert.equal(browserOwnerScope('["chat",null,"forged",null,{}]'), null);

  const many = decodeBrowserSnapshot({
    ...raw,
    active: 'tab-24',
    tabs: Array.from({ length: 25 }, (_, index) => tab(`tab-${index}`)),
  });

  assert.equal(many.tabs.length, 25);
  assert.equal(many.active, 'tab-24');
  assert.throws(() => decodeBrowserSnapshot({ ...raw, tabs: [{ ...tab('one'), owner: 'chat:forged' }] }),
    /browser_snapshot_invalid/u);
});

test('BR-U10: startup off не меняет mode; explicit off ACK предшествует host-stop', async (t) => {
  const runtimeAuth = reactive({
    ready: true,
    authenticated: true,
    clientScope: 'fixture'
  });
  const runtimeShell = reactive({
    initialized: true,
    present: true,
    status: 'online',
    profile: { id: 'machine-one' },
    capabilities: ['browser'],
  });
  let controls;
  const runtimeBrowser = reactive({
    preferences: {
      open: 'external',
      external: 'system',
      agents: false,
      search: 'yandex'
    },
    hostStatus: { phase: 'off', error: '' },
    startSnapshots: () => () => {},
    bindHost: (value) => {
      controls = value;

      return () => {};
    },
  });

  globalThis.__browserRuntimeFixture = {
    runtimeAuth,
    runtimeShell,
    runtimeBrowser
  };

  const module = await compileModule(webFile('src/shared/browser/browserHostRuntime.ts'), {
    stubs: {
      '../desktopSettings.ts': 'export const currentDesktopMode = () => "main";',
      '../../stores/auth.ts': `
        export const useAuthStore = () => globalThis.__browserRuntimeFixture.runtimeAuth;
      `,
      '../../stores/shell.ts': `
        export const useShellStore = () => globalThis.__browserRuntimeFixture.runtimeShell;
      `,
      '../../stores/browser.ts': `
        export const useBrowserStore = () => globalThis.__browserRuntimeFixture.runtimeBrowser;
      `,
    },
  });
  const previousBridge = window.grigdeskBrowser;
  const previousFetch = window.fetch;
  const order = [];
  const requests = [];
  const response = (body) => new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });

  window.grigdeskBrowser = {
    invoke: async (value) => {
      order.push(value.operation);

      return { grants: [] };
    },
  };
  window.fetch = async (url, options) => {
    requests.push({ url, options });

    if (String(url).endsWith('/poll')) {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }

    if (String(url) === '/api/browser/hosts') {
      return response({
        id: 'fixture-host',
        token: 'fixture-private',
        hostEpoch: 1,
        leaseMs: 15000
      });
    }

    if (String(url) === '/api/browser/mode') {
      order.push('mode-off');

      return response({ enabled: false });
    }

    return response({ leaseMs: 15000 });
  };

  const dispose = module.installBrowserHostRuntime({});

  t.after(() => {
    dispose();
    window.grigdeskBrowser = previousBridge;
    window.fetch = previousFetch;
    delete globalThis.__browserRuntimeFixture;
  });
  await rendered();
  assert.equal(requests.length, 0);
  runtimeBrowser.preferences.agents = true;
  await rendered();
  assert.equal(requests.filter((item) => item.url === '/api/browser/hosts').length, 1);
  runtimeBrowser.preferences.agents = false;
  await rendered();
  assert.equal(order.includes('host-stop'), false);
  await controls.disablePreference();
  await rendered();
  assert.equal(order.indexOf('mode-off') < order.indexOf('host-stop'), true);

  const off = requests.find((item) => item.url === '/api/browser/mode');

  assert.equal(off.options.headers['X-GrigDesk-Browser-Host'], 'fixture-private');
  assert.equal(off.options.body.includes('fixture-private'), false);
  assert.equal(JSON.stringify(runtimeBrowser.hostStatus).includes('fixture-private'), false);
  assert.equal(requests.some((item) => item.url.includes('fixture-private')), false);
});

test('PERF: страница браузера ждёт state и apps, отказ даёт error, повтор — ready', async (t) => {
  const fixture = harness();

  fixture.setFailNative(true);

  const wrapper = mount(BrowserPage, { props: { active: true }, attachTo: document.body });

  t.after(() => {
    wrapper.unmount();
    fixture.cleanup();
    delete globalThis.__browserUiHarness;
  });

  const f = measured(t, wrapper, 'tools.browser');

  await f.paint();

  const failure = f.log.snapshot().entries.at(-1).data;

  assert.equal(failure.phase, 'error');
  fixture.setFailNative(false);

  const hold = Promise.withResolvers();

  fixture.holdNative(hold.promise);
  await wrapper.setProps({ active: false });
  await rendered();
  await wrapper.setProps({ active: true });
  await flushPromises();
  await f.paint();
  assert.equal(f.log.snapshot().entries.at(-1).data.phase, 'start');
  hold.resolve();
  await rendered();
  await f.paint();

  const last = f.log.snapshot().entries.at(-1).data;

  assert.equal(last.phase, 'ready');
  assert.notEqual(last.surface, failure.surface);
});

test('PERF: готовый state браузера продолжает ждать отдельный список приложений', async (t) => {
  const fixture = harness();
  const applications = Promise.withResolvers();

  fixture.browser.loadApps = () => applications.promise;

  const wrapper = mount(BrowserPage, { props: { active: true }, attachTo: document.body });
  const f = measured(t, wrapper, 'tools.browser');

  t.after(() => {
    applications.resolve();
    wrapper.unmount();
    fixture.cleanup();
    delete globalThis.__browserUiHarness;
  });
  await rendered();
  await f.paint();
  assert.equal(f.log.snapshot().entries.some((row) => row.data.phase === 'ready'), false);
  assert.equal(Object.hasOwn(wrapper.attributes(), 'data-perf-pending'), true);
  applications.resolve();
  await rendered();
  await f.paint();
  assert.equal(f.log.snapshot().entries.at(-1).data.phase, 'ready');
});
