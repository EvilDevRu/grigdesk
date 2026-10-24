import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { createUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

let browser;

before(async () => {
  browser = await createUiBrowser();
});

after(() => browser.close());

test('машины: повтор, ручное отключение и терминальный отказ не смешивают действия', async (t) => {
  const { reactive, nextTick } = await import('../../web/node_modules/vue/index.mjs');
  const { mount } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
  const calls = [];
  const profile = {
    id: 'work',
    name: 'Рабочая машина',
    kind: 'remote',
    address: 'https://work.example:443',
    status: 'offline',
  };
  const other = {
    ...profile,
    id: 'home',
    name: 'Домашняя машина',
  };

  globalThis.__machineState = reactive({
    profile,
    profiles: [profile, other],
    status: 'offline',
    detail: { code: 'offline', retryAt: Date.now() + 8000 },
    capabilities: ['scan', 'unlock'],
    localAvailable: false,
    appApi: { major: 0, minor: 1 },
    serverApi: { major: 0, minor: 1 },
    connect: async () => calls.push('connect'),
    selectProfile: async (id) => calls.push(['select', id]),
    unlock: async () => calls.push('unlock'),
  });

  const component = await compileVue(webFile('src/views/ConnectionsView.vue'), {
    stubs: {
      '../stores/shell.ts': 'export const useShellStore = () => globalThis.__machineState;',
      '../../stores/shell.ts': 'export const useShellStore = () => globalThis.__machineState;',
    },
  });
  const wrapper = mount(component, { attachTo: document.body });
  const button = (label) => wrapper.findAll('button').find((item) => item.text().trim() === label);

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__machineState;
  });

  assert.match(wrapper.text(), /Повторим подключение через [78] с/);
  await button('Повторить сейчас').trigger('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['connect']);

  globalThis.__machineState.detail = { code: 'disconnected', retryAt: Date.now() + 8000 };
  await nextTick();
  assert.match(wrapper.text(), /Автоматические попытки остановлены/);
  assert.doesNotMatch(wrapper.text(), /Повторим подключение|подключимся автоматически/);
  assert.ok(button('Подключиться'));

  globalThis.__machineState.status = 'connecting';
  globalThis.__machineState.detail = null;
  await nextTick();
  assert.equal(button('Подключение…').attributes('disabled') !== undefined, true);

  for (const status of ['unpaired', 'revoked', 'identityMismatch']) {
    globalThis.__machineState.status = status;
    globalThis.__machineState.detail = { code: status };
    await nextTick();
    assert.ok(button('Привязать заново'));
    assert.equal(Boolean(button('Повторить сейчас')), false);
    assert.doesNotMatch(wrapper.text(), /Привязка сохранена|подключимся автоматически/);
  }

  globalThis.__machineState.status = 'locked';
  await nextTick();
  await button('Разблокировать').trigger('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.at(-1), 'unlock');

  await button('Выбрать другую машину').trigger('click');
  await nextTick();
  await wrapper.find('[data-context="machine-choice"]').trigger('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.at(-1), ['select', 'home']);
});

test('привязка: двойное сканирование и поздний результат не затрагивают новое открытие', async (t) => {
  const { nextTick } = await import('../../web/node_modules/vue/index.mjs');
  const { mount } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
  const scans = [];
  const additions = [];

  globalThis.__machinePairing = {
    capabilities: ['scan'],
    scan: () => new Promise((resolve) => scans.push(resolve)),
    addMachine: async (pairing) => additions.push(pairing),
  };

  const component = await compileVue(webFile('src/shared/layout/AddMachineDialog.vue'), {
    stubs: {
      '../../stores/shell.ts': 'export const useShellStore = () => globalThis.__machinePairing;',
    },
  });
  const wrapper = mount(component, { props: { open: true }, attachTo: document.body });
  const scan = () => [...document.querySelectorAll('button')]
    .find((item) => item.textContent.includes('Сканировать QR-код'));

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__machinePairing;
  });

  await nextTick();
  scan().click();
  scan().click();
  assert.equal(scans.length, 1);
  await wrapper.setProps({ open: false });
  await wrapper.setProps({ open: true });
  scans[0]({ pairing: 'GRIGDESK:PHONE:2:OLD' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.body.textContent.includes('Код считан'), false);
  assert.equal(Boolean(document.querySelector('textarea')), false);

  scan().click();
  scans[1]({ pairing: 'GRIGDESK:PHONE:2:CURRENT' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.body.textContent.includes('Код считан'), true);
  assert.deepEqual(additions, []);

  [...document.querySelectorAll('button')]
    .find((item) => item.textContent.trim() === 'Добавить').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(additions, ['GRIGDESK:PHONE:2:CURRENT']);
  assert.equal(wrapper.emitted('update:open').at(-1)[0], false);
});
