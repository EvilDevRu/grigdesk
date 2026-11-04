import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

test('плашка связи: отсчёт, ручное подключение, остановленные обновления и терминальный отказ', async (t) => {
  await installUiBrowser(t);

  const { reactive, ref, nextTick } = await import('../../web/node_modules/vue/index.mjs');
  const { mount } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
  const calls = [];

  globalThis.__recoveryShell = reactive({
    present: true,
    profile: { id: 'fixture' },
    status: 'offline',
    detail: { code: 'offline', retryAt: Date.now() + 30000 },
    unavailable: false,
    retryAt: 0,
    connect: async () => calls.push('transport'),
    retryNow: () => calls.push('shell'),
  });
  globalThis.__recoveryAuth = reactive({
    authenticated: true,
    retryAt: 0,
    recovering: false,
    load: async () => calls.push('auth'),
  });
  globalThis.__recoverySse = {
    reconnect: () => calls.push('events'),
    at: ref(0),
    recovering: ref(false),
  };
  const component = await compileVue(webFile('src/shared/layout/ConnectionRecovery.vue'), {
    stubs: {
      '../../stores/shell.ts': 'export const useShellStore = () => globalThis.__recoveryShell;',
      '../../stores/auth.ts': 'export const useAuthStore = () => globalThis.__recoveryAuth;',
      '../../composables/useSse.ts': `export const sseRetryAt = globalThis.__recoverySse.at;
        export const sseRecovering = globalThis.__recoverySse.recovering;
        export const reconnectSse = globalThis.__recoverySse.reconnect;`,
    },
  });
  const wrapper = mount(component, { attachTo: document.body });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__recoveryShell;
    delete globalThis.__recoveryAuth;
    delete globalThis.__recoverySse;
  });
  assert.match(wrapper.text(), /Восстанавливаем связь/);
  assert.match(wrapper.text(), /через (29|30) с/);
  await wrapper.find('button').trigger('click');
  await nextTick();
  assert.deepEqual(calls, ['transport']);
  globalThis.__recoveryShell.status = 'online';
  globalThis.__recoverySse.recovering.value = true;
  globalThis.__recoverySse.at.value = Date.now() + 10000;
  await nextTick();
  assert.match(wrapper.text(), /Обновления приостановлены/);
  await wrapper.find('button').trigger('click');
  await nextTick();
  assert.equal(calls.at(-1), 'events');
  globalThis.__recoveryShell.unavailable = true;
  globalThis.__recoveryShell.retryAt = Date.now() + 5000;
  await nextTick();
  await wrapper.find('button').trigger('click');
  await nextTick();
  assert.equal(calls.at(-1), 'shell');
  globalThis.__recoveryShell.unavailable = false;
  globalThis.__recoveryShell.status = 'revoked';
  await nextTick();
  assert.equal(wrapper.find('[data-connection-recovery]').exists(), false);
  globalThis.__recoveryShell.status = 'online';
  globalThis.__recoverySse.recovering.value = false;
  await nextTick();
  assert.equal(wrapper.find('[data-connection-recovery]').exists(), false);
});
