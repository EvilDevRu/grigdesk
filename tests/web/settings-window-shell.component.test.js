import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';

process.env.NODE_ENV = 'test';

const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
const browser = new Window({ url: 'http://127.0.0.1:8140/?window=settings#/settings' });

for (const name of ['window', 'document', 'navigator', 'location', 'localStorage',
  'Node', 'Element', 'HTMLElement', 'SVGElement', 'Event', 'KeyboardEvent', 'ResizeObserver']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: browser[name] });
}

const { reactive, ref, nextTick } = await import('../../web/node_modules/vue/index.mjs');
const { mount, flushPromises } = await import(
  '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
);

/**
 * Оболочка использует настоящий UI-kit и один стек диалогов внутри своего bundle.
 * Сеть, stores и закрытие документа управляются тестом без канала Node.
 */
async function fixture(t, authenticated = true, pending = 0) {
  const h = {
    auth: reactive({ ready: true, authenticated }),
    connected: ref(false),
    calls: [],
    sent: [],
    closed: 0,
    portClosed: 0,
    pending,
    props: null,
    mutation: null,
    sse: null,
  };
  const spy = (name) => (...args) => h.calls.push([name, ...args]);

  h.providers = {
    load: spy('load'),
    invalidateCredentials: spy('credentials'),
    applyUsage: spy('usage'),
    noteUsageConnection: spy('connection'),
  };
  h.chat = { setSpeechSnapshot: spy('speech') };
  h.update = { load: spy('update') };
  h.channel = {
    post: (message) => h.sent.push(message),
    subscribe: () => () => { },
    close: () => {
      h.portClosed += 1;
    },
  };
  globalThis.__settingsShell = h;

  const component = await compileVue(webFile('src/shared/layout/SettingsWindowShell.vue'), {
    stubs: {
      '../../views/SettingsView.vue': `
        import { h } from 'vue';
        export const __esModule = true;
        export default { props: ['windowActions'], setup(props) {
          globalThis.__settingsShell.props = props;
          return () => h('input', { 'data-form': '' });
        }};`,
      '../../stores/auth.js': 'export const useAuthStore = () => globalThis.__settingsShell.auth;',
      '../../stores/providers.js': `
        export const useProvidersStore = () => globalThis.__settingsShell.providers;`,
      '../../stores/chat.js': 'export const useChatStore = () => globalThis.__settingsShell.chat;',
      '../../stores/grigdesk-update.js': `
        export const useGrigDeskUpdateStore = () => globalThis.__settingsShell.update;`,
      '../../composables/useSse.ts': `export const useSse = (fn) => {
        globalThis.__settingsShell.sse = fn;
        return { connected: globalThis.__settingsShell.connected };
      };`,
      '../apiClient.ts': `
        export const onMutationSuccess = (fn) => {
          globalThis.__settingsShell.mutation = fn;
          return () => { globalThis.__settingsShell.mutation = null; };
        };
        export const pendingMutations = () => globalThis.__settingsShell.pending;`,
      '../settingsWindowChannel.ts': `
        export const createSettingsWindowChannel = () => globalThis.__settingsShell.channel;
        export const newRequestId = () => 'test';
        export const requestIntent = async () => true;`,
      '../windowControl.ts': `
        export const closeCurrentWindow = () => { globalThis.__settingsShell.closed += 1; };
        export const reloadCurrentWindow = () => {};`,
      '../../views/DocumentModal.vue': `
        import { h } from 'vue';
        export default { render: () => h('div', { 'data-document': '' }) };`,
      '../../ui.ts': `
        export * from './src/ui.ts';
        import { confirmDialog, showToast } from './src/ui.ts';
        globalThis.__settingsShell.confirm = confirmDialog;
        globalThis.__settingsShell.toast = showToast;`,
    },
  });
  const root = document.createElement('div');

  document.body.append(root);

  const wrapper = mount(component, { attachTo: root });

  t.after(() => {
    wrapper.unmount();
    root.remove();
    delete globalThis.__settingsShell;
  });
  await flushPromises();
  await flushPromises();

  return { h, wrapper };
}

function escape(target = document) {
  target.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

test('SW-U01 оболочка без основного интерфейса', async (t) => {
  const { h, wrapper } = await fixture(t);

  assert.equal(wrapper.find('[data-settings-window]').exists(), true);
  assert.equal(wrapper.find('[data-form]').exists(), true);

  for (const name of ['openTerminal', 'openChat']) {
    assert.equal(typeof h.props.windowActions?.[name], 'function');
  }

  assert.equal(wrapper.find('[data-document]').exists(), true);
  assert.equal(wrapper.find('.shell, .sidebar, .topbar').exists(), false);
  assert.equal(typeof h.confirm, 'function');
  h.toast({ title: 'проверка хоста', id: 'test' });
  await nextTick();
  assert.equal(Boolean(document.querySelector('.ui-toast-host')), true);
});

test('SW-U02 серверные события доходят до настроек', async (t) => {
  const { h } = await fixture(t);

  assert.equal(typeof h.sse, 'function');
  h.sse('providers-update', { credentials: 'claude' });
  h.sse('providers-update', {});
  h.sse('providers-usage', { usage: { claude: 1 } });
  h.sse('grigdesk-update', {});
  h.sse('speech-settings', { enabled: true });
  h.connected.value = true;
  assert.deepEqual(h.calls.map((call) => call[0]),
    ['connection', 'credentials', 'load', 'usage', 'update', 'speech', 'connection']);
});

test('SW-U03 успешное сохранение объявляется', async (t) => {
  const { h, wrapper } = await fixture(t);

  assert.equal(typeof h.mutation, 'function');
  h.mutation();
  assert.deepEqual(h.sent, [{ version: 1, type: 'settings-changed' }]);
  wrapper.unmount();
  assert.equal(h.mutation, null);
  assert.equal(h.portClosed, 1);
});

test('SW-U04 Escape: поле, свободно, диалог', async (t) => {
  const { h, wrapper } = await fixture(t);
  const input = wrapper.find('input').element;

  input.focus();
  escape(input);
  assert.equal(document.activeElement === input, false);
  assert.equal(h.closed, 0);
  escape();
  assert.equal(h.closed, 1);

  const result = h.confirm('Подтвердить?');

  await nextTick();
  await flushPromises();
  escape(document.activeElement);
  assert.equal(await result, false);
  assert.equal(h.closed, 1);
});

test('SW-U05 без входа окно закрывается после изменений', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });

  const { h } = await fixture(t, false, 1);

  t.mock.timers.tick(100);
  assert.equal(h.closed, 0);
  h.pending = 0;
  t.mock.timers.tick(100);
  assert.equal(h.closed, 1);
});

test('SW-U05/предел ожидания 5000 мс', async (t) => {
  const { h } = await fixture(t);

  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  h.pending = 1;
  h.auth.authenticated = false;
  await nextTick();

  for (let index = 0; index < 100; index += 1) {
    t.mock.timers.tick(50);
  }

  assert.equal(h.closed, 1);
});

test('SW-U06 выход закрывает окно', async (t) => {
  const { h } = await fixture(t);

  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  h.pending = 1;
  h.auth.authenticated = false;
  await nextTick();
  assert.equal(h.closed, 0);
  h.pending = 0;
  t.mock.timers.tick(50);
  assert.equal(h.closed, 1);
});
