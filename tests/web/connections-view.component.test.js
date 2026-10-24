import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

test('машины: список и несовместимые версии доступны без сервера', async (t) => {
  await installUiBrowser(t);

  const { reactive } = await import('../../web/node_modules/vue/index.mjs');
  const { mount } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
  const { nextTick } = await import('../../web/node_modules/vue/index.mjs');
  const actions = [];
  const confirmations = [false, true];

  globalThis.__confirmMachine = async () => confirmations.shift();

  globalThis.__testShell = reactive({
    present: true,
    status: 'incompatible',
    profiles: [{
      id: 'machine',
      name: 'Домашний ПК',
      address: 'machine:443',
      kind: 'remote',
      status: 'incompatible',
    }],
    profile: null,
    localAvailable: true,
    appApi: { major: 0, minor: 1 },
    serverApi: { major: 1, minor: 0 },
    detail: 'Обновите приложение',
    capabilities: [],
    addMachine: async (pairing) => actions.push(['add', pairing]),
    removeProfile: async (id) => actions.push(['remove', id]),
  });

  const component = await compileVue(webFile('src/views/ConnectionsView.vue'), {
    stubs: {
      '../stores/shell.ts': 'export const useShellStore = () => globalThis.__testShell;',
      '../../stores/shell.ts': 'export const useShellStore = () => globalThis.__testShell;',
      '../ui.ts': `
        export * from './src/ui.ts';
        export const confirmDialog = () => globalThis.__confirmMachine();
      `,
    },
  });
  const wrapper = mount(component, { attachTo: document.body });

  t.after(() => wrapper.unmount());
  assert.match(wrapper.text(), /Домашний ПК/);
  assert.match(wrapper.text(), /0\.1/);
  assert.match(wrapper.text(), /1\.0/);
  assert.match(wrapper.text(), /Этот компьютер/);

  const menu = wrapper.findAll('button').find((button) =>
    button.attributes('aria-label') === 'Параметры машины «Домашний ПК»');

  await menu.trigger('click');
  await nextTick();

  const remove = () => [...document.querySelectorAll('button')]
    .find((button) => button.textContent.trim() === 'Удалить');

  remove().click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(actions, []);
  await menu.trigger('click');
  await nextTick();
  remove().click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(actions, [['remove', 'machine']]);
  await wrapper.findAll('button').find((button) => button.text() === 'Добавить машину').trigger('click');
  await nextTick();

  const textarea = document.querySelector('textarea');

  assert.ok(textarea);
  textarea.value = 'GRIGDESK:PAIR:1:TEST';
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  document.querySelectorAll('button').forEach((button) => {
    if (button.textContent.trim() === 'Добавить') {
      button.click();
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(actions.at(-1), ['add', 'GRIGDESK:PAIR:1:TEST']);
});


test('PHONE-R1: причины нового транспорта дают следующий шаг на RU/EN', async (t) => {
  await installUiBrowser(t);

  const { reactive, nextTick } = await import('../../web/node_modules/vue/index.mjs');
  const { mount } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
  const { connectionDetailText } = await import('../../shared/client/clientShell.ts');
  const profile = {
    id: 'relay-only',
    name: 'Сервер через relay',
    kind: 'remote',
    address: '',
    status: 'offline',
  };

  globalThis.__relayDiagnosticShell = reactive({
    present: true,
    profile,
    profiles: [profile],
    status: 'offline',
    detail: { code: 'offline' },
    localAvailable: false,
    appApi: { major: 0, minor: 1 },
    serverApi: { major: 0, minor: 1 },
    capabilities: [],
  });

  // Публичная граница использует нормализованные native-коды: сеть, несовместимость, pin.
  // Эти же коды проверяет JVM owner; новые приватные исключения не должны доходить до WebView.
  const module = await import('./helpers/compile-vue.js');
  const component = await module.compileModule(webFile('../tests/web/helpers/phone-diagnostics.ts'), {
    stubs: {
      '../stores/shell.ts': 'export const useShellStore = () => globalThis.__relayDiagnosticShell;',
      '../../stores/shell.ts': 'export const useShellStore = () => globalThis.__relayDiagnosticShell;',
    },
  });
  const wrapper = mount(component.ConnectionsView, { attachTo: document.body });

  t.after(() => {
    wrapper.unmount();
    component.setUiLocale('ru');
    delete globalThis.__relayDiagnosticShell;
  });

  await wrapper.find('[data-context="machine-connection-details"]').trigger('click');
  await nextTick();

  for (const locale of ['ru', 'en']) {
    component.setUiLocale(locale);

    for (const code of ['offline', 'client_upgrade_required', 'identityMismatch', 'relay_upgrade_required']) {
      globalThis.__relayDiagnosticShell.detail = { code };
      await nextTick();

      const detail = connectionDetailText({ code }, locale);

      assert.ok(detail.trim(), `${locale}/${code}: причина не должна исчезать в mapper`);
      assert.ok(code === 'offline'
        ? wrapper.find('.machine-recovery').exists() : wrapper.text().includes(detail));
      assert.doesNotMatch(detail, /GRIGDESK_|VPN|Exception|[a-f0-9]{64}/);
      assert.ok(wrapper.find('.machine-address').text().trim(), 'relay-only должен иметь подпись адреса');
    }
  }
});
