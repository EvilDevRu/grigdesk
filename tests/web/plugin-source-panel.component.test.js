import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createUiBrowser } from './helpers/ui-components.js';
import { compileVue, singletonUrl } from './helpers/compile-vue.js';
import { pluginInstallUiDouble } from './helpers/pluginInstallUiFixture.js';
import { webInstallInfo } from './helpers/pluginInstallFixtures.js';

process.env.NODE_ENV = 'test';

const browser = await createUiBrowser('https://grigdesk.test/#/settings');
const { reactive, nextTick } = await import(singletonUrl('vue'));
const { mount, flushPromises } = await import(
  '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
);
const harnessFile = fileURLToPath(new URL('./helpers/PluginSourcePanelHarness.vue', import.meta.url));
const Harness = await compileVue(harnessFile, {
  stubs: {
    '../../stores/pluginInstall.ts': 'export const usePluginInstallStore = () => globalThis.__sourceUi;',
  },
});

after(() => browser.close());

/**
 * Панель и общий confirm host компилируются одним графом, без подмены UI границы.
 * Store double сохраняет singleton Vue и позволяет менять health во время подтверждения.
 */
async function mountPanel(t, install = null, initial = {}) {
  const fixture = pluginInstallUiDouble(reactive, initial);
  const plugin = reactive({
    id: 'demo',
    name: 'Демо',
    install,
  });

  globalThis.__sourceUi = fixture.state;

  const wrapper = mount(Harness, {
    props: { plugin },
    attachTo: browser.document.querySelector('#mount'),
    global: { stubs: { teleport: true } },
  });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__sourceUi;
  });
  await flushPromises();

  return {
    ...fixture,
    plugin,
    wrapper,
  };
}

test('P1: ручная установка показывает привязку и отправляет bind', async (t) => {
  const { wrapper } = await mountPanel(t);

  assert.equal(wrapper.get('[data-role="plugin-source"]').attributes('data-managed'), 'false');
  assert.match(wrapper.text(), /Плагин установлен вручную и не связан с источником/u);
  await wrapper.get('[data-role="plugin-source-bind"]').trigger('click');
  assert.equal(wrapper.emitted('bind').length, 1);
});

test('P2: источник/версия/дата проверки, check и его загрузка', async (t) => {
  const install = webInstallInfo({
    checkedAt: '2026-10-12T10:00:00.000Z',
    checkError: { code: 'git_failed', message: 'Источник временно недоступен.' },
  });
  const { wrapper, state, calls } = await mountPanel(t, install);

  assert.equal(wrapper.find('[data-role="plugin-source-url"]').exists(), true);
  assert.equal(wrapper.get('[data-role="plugin-source-url"]').text(), install.source.url);
  assert.match(wrapper.get('[data-role="plugin-source-version"]').text(), /v1.1.0/u);
  assert.equal(wrapper.text().includes(install.sha.slice(0, 7)), true);
  assert.match(wrapper.text(), /Проверено/u);
  assert.match(wrapper.get('[data-role="plugin-source-check-error"]').text(), /временно недоступен/u);
  await wrapper.get('[data-role="plugin-source-check"]').trigger('click');
  assert.equal(calls.filter(([method]) => method === 'checkUpdates').length, 1);
  state.checking = true;
  await nextTick();
  assert.equal(wrapper.get('[data-role="plugin-source-check"]').element.disabled, true);
});

test('P3: доступное обновление отправляет update с текущей карточкой', async (t) => {
  const install = webInstallInfo({
    updateAvailable: true,
    latest: {
      version: '1.2.0',
      tag: 'v1.2.0',
      sha: 'c'.repeat(40),
    },
  });
  const { wrapper } = await mountPanel(t, install);

  assert.equal(wrapper.find('[data-role="plugin-source-update"]').exists(), true);
  assert.equal(wrapper.get('[data-role="plugin-source-update"]').text(), 'Обновить до v1.2.0');
  await wrapper.get('[data-role="plugin-source-update"]').trigger('click');
  assert.equal(wrapper.emitted('update').length, 1);
});

test('P4: ручные правки видны и предлагают переустановку начисто', async (t) => {
  const { wrapper } = await mountPanel(t, webInstallInfo({ localChanges: true }));

  assert.equal(wrapper.find('[data-role="plugin-source-local-changes"]').exists(), true);
  assert.match(wrapper.get('[data-role="plugin-source-local-changes"]').text(), /ручные правки/u);
  assert.equal(wrapper.get('[data-role="plugin-source-update"]').text(), 'Переустановить начисто…');
  await wrapper.get('[data-role="plugin-source-update"]').trigger('click');
  assert.equal(wrapper.emitted('update').length, 1);
});

test('P5: настоящий confirm отменяется без rollback; согласие передаёт revision/digest', async (t) => {
  const { wrapper, calls, plugin } = await mountPanel(t, webInstallInfo());

  assert.equal(wrapper.find('[data-role="plugin-source-rollback"]').exists(), true);
  await wrapper.get('[data-role="plugin-source-rollback"]').trigger('click');
  await flushPromises();
  assert.match(wrapper.get('.ui-dialog-host__message').text(), /Вернуть v1.0.0/u);
  await wrapper.get('.ui-dialog-host__actions button').trigger('click');
  await flushPromises();
  assert.equal(calls.filter(([method]) => method === 'rollback').length, 0);
  await wrapper.get('[data-role="plugin-source-rollback"]').trigger('click');
  await flushPromises();
  await wrapper.findAll('.ui-dialog-host__actions button')[1].trigger('click');
  await flushPromises();

  const rollback = calls.filter(([method]) => method === 'rollback');

  assert.equal(rollback.length, 1);
  assert.equal(rollback[0][1][0].id, plugin.id);
  assert.equal(rollback[0][1][0].install.revision, plugin.install.revision);
  assert.equal(rollback[0][1][0].install.previous.payloadDigest, plugin.install.previous.payloadDigest);
});

test('P6: версия ожидающая рестарта подписана явно', async (t) => {
  const { wrapper } = await mountPanel(t, webInstallInfo({ restartRequired: true }));

  assert.equal(wrapper.find('[data-role="plugin-source-restart"]').exists(), true);
  assert.equal(wrapper.get('[data-role="plugin-source-restart"]').text(),
    'Новая версия ждёт перезапуска GrigDesk.');
});

test('P7: повреждённая previous остаётся видимой с отказом отката', async (t) => {
  const { wrapper, calls } = await mountPanel(t, webInstallInfo({
    rollbackAvailable: false,
    rollbackError: { code: 'local_changes', message: 'Резервная копия изменилась.' },
  }));

  assert.equal(wrapper.find('[data-role="plugin-source-rollback"]').exists(), true);
  assert.equal(wrapper.get('[data-role="plugin-source-rollback"]').element.disabled, true);
  assert.equal(wrapper.find('[data-role="plugin-source-rollback-error"]').exists(), true);
  assert.match(wrapper.get('[data-role="plugin-source-rollback-error"]').text(), /копия изменилась/u);
  wrapper.get('[data-role="plugin-source-rollback"]').element.click();
  await flushPromises();
  assert.equal(calls.filter(([method]) => method === 'rollback').length, 0);
  assert.equal(wrapper.find('.ui-dialog-host__message').exists(), false);
});

test('P8: неизвестный исход блокирует действия, два confirm создают один intent', async (t) => {
  const { wrapper, state, calls } = await mountPanel(t, webInstallInfo(), {
    reconciling: true,
    error: 'Исход отката пока неизвестен.',
  });

  assert.equal(wrapper.get('[data-role="plugin-source-rollback"]').element.disabled, true);
  assert.match(wrapper.text(), /Уточняю исход/u);
  assert.match(wrapper.text(), /Исход отката пока неизвестен/u);
  state.recoveryError = { code: 'recovery_required', message: 'Нужно разобрать сохранённые копии.' };
  await nextTick();
  assert.match(wrapper.text(), /разобрать сохранённые копии/u);
  state.reconciling = false;
  state.recoveryError = null;
  await nextTick();
  wrapper.get('[data-role="plugin-source-rollback"]').element.click();
  wrapper.get('[data-role="plugin-source-rollback"]').element.click();
  await flushPromises();
  await wrapper.findAll('.ui-dialog-host__actions button')[1].trigger('click');
  await flushPromises();
  assert.equal(calls.filter(([method]) => method === 'rollback').length, 1);
  assert.equal(wrapper.find('.ui-dialog-host__message').exists(), false);
});

test('P8: health появившийся во время confirm запрещает эффект после согласия', async (t) => {
  const { wrapper, state, calls } = await mountPanel(t, webInstallInfo());

  await wrapper.get('[data-role="plugin-source-rollback"]').trigger('click');
  await flushPromises();
  state.recoveryError = { code: 'recovery_required', message: 'Изменилась целостность состояния.' };
  await nextTick();
  await wrapper.findAll('.ui-dialog-host__actions button')[1].trigger('click');
  await flushPromises();
  assert.equal(calls.filter(([method]) => method === 'rollback').length, 0);
});

test('P8: явное уточнение вызывает reconcile вместо нового подтверждения отката', async (t) => {
  const { wrapper, calls } = await mountPanel(t, webInstallInfo(), { reconciling: true });

  assert.equal(wrapper.find('[data-role="plugin-source-reconcile"]').exists(), true);
  await wrapper.get('[data-role="plugin-source-reconcile"]').trigger('click');
  assert.equal(calls.filter(([method]) => method === 'reconcile').length, 1);
  assert.equal(calls.filter(([method]) => method === 'rollback').length, 0);
});
