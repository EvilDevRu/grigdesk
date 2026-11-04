import assert from 'node:assert/strict';

import { after, test } from 'node:test';

import { fileURLToPath } from 'node:url';

import { createUiBrowser } from './helpers/ui-components.js';

import { compileVue, singletonUrl, webFile } from './helpers/compile-vue.js';

import { pluginInstallUiDouble } from './helpers/pluginInstallUiFixture.js';

import { webInstallJob, webInstallInfo } from './helpers/pluginInstallFixtures.js';

process.env.NODE_ENV = 'test';

const browser = await createUiBrowser('https://grigdesk.test/#/db');

const { reactive, nextTick } = await import(singletonUrl('vue'));

const { mount, flushPromises } = await import(
  '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
);

const stubs = {
  '../../stores/pluginInstall.ts': 'export const usePluginInstallStore = () => globalThis.__driverPluginUi;',
  '../../stores/dbEngineInstall.ts':
    'export const useDbEngineInstallStore = () => globalThis.__driverInstallUi;',
  '../../stores/pluginCatalog.ts': 'export const usePluginCatalogStore = () => globalThis.__driverCatalogUi;',
};

const Dialog = await compileVue(webFile('src/views/settings/PluginInstallDialog.vue'), { stubs });

const Harness = await compileVue(fileURLToPath(new URL(
  './helpers/DbEngineSourcePanelHarness.vue', import.meta.url,
)), { stubs });

after(() => browser.close());

/**
 * Driver и plugin doubles раздельны: ошибочный выбор preset виден по вызовам.
 * Controls, Teleport и подтверждение остаются настоящими компонентами проекта.
 */
async function mountDriver(t, initial = {}, sourcePanel = false, props = {}) {
  const driver = pluginInstallUiDouble(reactive, initial);

  const plugin = pluginInstallUiDouble(reactive);

  const catalogCalls = [];

  globalThis.__driverInstallUi = driver.state;

  globalThis.__driverPluginUi = plugin.state;

  globalThis.__driverCatalogUi = reactive({
    items: [],
    loading: false,
    error: null,
    load: async () => {
      catalogCalls.push('load');
    },
    ensureLoaded: async () => {
      catalogCalls.push('ensureLoaded');
    },
  });

  const subject = reactive({
    id: 'demo',
    name: 'Драйвер',
    install: webInstallInfo()
  });

  const wrapper = mount(sourcePanel ? Harness : Dialog, {
    attachTo: browser.document.querySelector('#mount'),
    props: sourcePanel ? { plugin: subject, dialog: sourcePanel === 'dialog-harness' } : {
      open: true,
      mode: 'install',
      plugin: null,
      packageKind: 'db-engine',
      ...props,
    },
    global: { stubs: { teleport: true } },
  });

  t.after(() => {
    wrapper.unmount();

    delete globalThis.__driverInstallUi;

    delete globalThis.__driverPluginUi;

    delete globalThis.__driverCatalogUi;
  });

  await flushPromises();

  return {
    ...driver,
    plugin,
    catalogCalls,
    wrapper,
    subject
  };
}

test('DWIZ-01: адрес/версия используют driver preset без чтения plugin catalog', async (t) => {
  const { wrapper, calls, plugin, catalogCalls } = await mountDriver(t);

  assert.equal(calls.filter(([method]) => method === 'loadJob').length, 1);

  assert.equal(plugin.calls.length, 0);

  assert.deepEqual(catalogCalls, []);

  assert.match(wrapper.text(), /драйвер/iu);

  await wrapper.get('[data-role="install-url"]').setValue('https://example.invalid/driver.git');

  await wrapper.get('[data-role="install-find"]').trigger('click');

  assert.ok(calls.some(([method]) => method === 'listVersions'));
});

test('DWIZ-01: ready/reopen сохраняет предупреждение действующего job и отдельный apply/token', async (t) => {
  const job = webInstallJob();

  job.preview.name = 'Драйвер';

  job.preview.warnings = ['Неизвестный источник: драйвер получает пароли, SSH-каналы и сеть.'];

  const { wrapper, calls } = await mountDriver(t, { job });

  assert.equal(wrapper.find('[data-role="install-preview"]').exists(), true);

  assert.match(wrapper.text(), /Неизвестный источник/u);

  assert.match(wrapper.text(), /пароли, SSH-каналы и сеть/u);

  assert.equal(calls.filter(([method]) => method === 'apply').length, 0);

  await wrapper.setProps({ open: false });

  await wrapper.setProps({ open: true });

  await flushPromises();

  assert.match(wrapper.text(), /Неизвестный источник/u);

  await wrapper.get('[data-role="install-apply"]').trigger('click');

  assert.equal(calls.filter(([method]) => method === 'apply').length, 1);
});

for (const status of ['running', 'applying', 'done', 'failed', 'recovery_required']) {
  test(`DWIZ-01: ${status} показывает driver job, done требует ручной restart`, async (t) => {
    const { wrapper, state, calls } = await mountDriver(t);

    state.job = webInstallJob(status);

    await nextTick();

    assert.equal(calls.filter(([method]) => method === 'loadJob').length, 1);

    if (status === 'done') {
      assert.match(wrapper.text(), /перезапус/iu);
    }

    if (status === 'recovery_required') {
      assert.equal(wrapper.find('[data-role="install-apply"]').exists(), false);
    }

    if (status === 'applying') {
      assert.equal(wrapper.find('[data-role="install-cancel"]').exists(), false);
    }
  });
}

test('DWIZ-02: отмена confirm не откатывает, согласие передаёт snapshot один раз', async (t) => {
  const { wrapper, calls, subject, plugin } = await mountDriver(t, {}, true);

  await wrapper.get('[data-role="plugin-source-rollback"]').trigger('click');

  await flushPromises();

  await wrapper.get('.ui-dialog-host__actions button').trigger('click');

  await flushPromises();

  assert.equal(calls.filter(([method]) => method === 'rollback').length, 0);

  assert.equal(plugin.calls.filter(([method]) => method === 'rollback').length, 0);

  await wrapper.get('[data-role="plugin-source-rollback"]').trigger('click');

  await flushPromises();

  await wrapper.findAll('.ui-dialog-host__actions button')[1].trigger('click');

  await flushPromises();

  const rollback = calls.filter(([method]) => method === 'rollback');

  assert.equal(rollback.length, 1);

  assert.equal(rollback[0][1][0].install.revision, subject.install.revision);

  assert.equal(rollback[0][1][0].install.previous.payloadDigest, subject.install.previous.payloadDigest);

  assert.equal(plugin.calls.filter(([method]) => method === 'rollback').length, 0);
});

test('DWIZ-02: double click и recovery во время confirm запрещают повторный эффект', async (t) => {
  const { wrapper, calls, state, plugin } = await mountDriver(t, {}, true);

  wrapper.get('[data-role="plugin-source-rollback"]').element.click();

  wrapper.get('[data-role="plugin-source-rollback"]').element.click();

  await flushPromises();

  state.recoveryError = { code: 'recovery_required', message: 'Нужно восстановление' };

  await nextTick();

  await wrapper.findAll('.ui-dialog-host__actions button')[1].trigger('click');

  await flushPromises();

  assert.equal(calls.filter(([method]) => method === 'rollback').length, 0);

  assert.equal(plugin.calls.filter(([method]) => method === 'rollback').length, 0);
});

test('DWIZ-02: update остаётся preview до отдельного Применить', async (t) => {
  const job = webInstallJob('ready', 'update');

  const subject = {
    id: 'demo',
    name: 'Драйвер',
    install: webInstallInfo()
  };

  const { wrapper, calls, plugin } = await mountDriver(t, { job }, false, {
    mode: 'update', plugin: subject,
  });

  assert.equal(wrapper.find('[data-role="install-preview"]').exists(), true);

  assert.equal(calls.filter(([method]) => method === 'apply').length, 0);

  assert.equal(subject.install.version, '1.1.0');

  await wrapper.get('[data-role="install-apply"]').trigger('click');

  assert.equal(calls.filter(([method]) => method === 'apply').length, 1);

  assert.equal(plugin.calls.filter(([method]) => method === 'apply').length, 0);
});

test('DWIZ-01: результат драйвера просит ручной restart на русском и английском', async (t) => {
  const { wrapper, state } = await mountDriver(t, {}, 'dialog-harness');

  state.job = webInstallJob('done');

  await nextTick();

  const setLocale = wrapper.vm.setUiLocale;

  t.after(() => setLocale('ru'));

  assert.match(wrapper.text(), /перезапус/iu);

  setLocale('en');

  await nextTick();

  assert.match(wrapper.text(), /restart/iu);

  assert.doesNotMatch(wrapper.text(), /перезапус/iu);
});


test('Новая установка драйвера БД не восстанавливает прошлый итог', async (t) => {
  const { wrapper, state, plugin } = await mountDriver(t, { job: webInstallJob('done') });

  assert.equal(wrapper.get('[data-role="plugin-install-dialog"]').attributes('data-view'), 'source');
  assert.equal(wrapper.get('[data-role="install-url"]').element.value, '');
  assert.equal(state.job, null);
  assert.equal(plugin.calls.length, 0);
});
