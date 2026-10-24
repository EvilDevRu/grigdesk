import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { createUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

let browser;

before(async () => {
  browser = await createUiBrowser();
});
after(() => browser.close());

test('W2: блокировка выше документа и удерживает Escape, нижний портал inert', async (t) => {
  const { nextTick } = await import('../../web/node_modules/vue/index.mjs');
  const { mount } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
  const fixture = await compileVue(new URL('./fixtures/locked-document.vue', import.meta.url).pathname, {
    stubs: { '../../stores/shell.ts': 'export const useShellStore = () => ({ unlock: async () => {} });' },
  });

  globalThis.__reviewClosed = 0;

  const wrapper = mount(fixture, { attachTo: document.body });

  t.after(() => wrapper.unmount());
  await nextTick();
  await nextTick();

  const overlays = [...document.querySelectorAll('.ui-dialog-overlay')];
  const documentOverlay = overlays.find((item) => item.textContent.includes('Документ'));
  const lockOverlay = overlays.find((item) => item.textContent.includes('Приложение заблокировано'));

  assert.ok(Number(lockOverlay.style.getPropertyValue('--ui-layer-z'))
    > Number(documentOverlay.style.getPropertyValue('--ui-layer-z')));
  assert.equal(documentOverlay.inert, true);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await nextTick();
  assert.equal(globalThis.__reviewClosed, 0);
});

test('блокировка: одно нажатие, ожидание Android, отмена и повтор без прежней ошибки', async (t) => {
  const { nextTick } = await import('../../web/node_modules/vue/index.mjs');
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
  let resolve;
  let reject;
  let calls = 0;

  globalThis.__lockShell = {
    profile: { name: 'Рабочий компьютер' },
    unlock: () => {
      calls += 1;

      return new Promise((accept, fail) => {
        resolve = accept;
        reject = fail;
      });
    },
  };
  t.after(() => delete globalThis.__lockShell);

  const LockOverlay = await compileVue(webFile('src/shared/layout/LockOverlay.vue'), {
    stubs: { '../../stores/shell.ts': 'export const useShellStore = () => globalThis.__lockShell;' },
  });
  const wrapper = mount(LockOverlay, { attachTo: document.body });

  t.after(() => wrapper.unmount());
  await nextTick();
  await nextTick();

  const dialog = document.querySelector('[role="dialog"]');
  const button = dialog.querySelector('button');

  assert.match(dialog.textContent, /Рабочий компьютер/);
  button.click();
  button.click();
  await nextTick();
  assert.equal(calls, 1);
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.match(dialog.querySelector('[role="status"]').textContent, /системном окне/);
  reject(new Error('Проверка отменена'));
  await flushPromises();
  assert.equal(button.disabled, false);
  assert.match(dialog.querySelector('[role="alert"]').textContent, /Проверка отменена/);
  assert.match(button.textContent, /Повторить разблокировку/);

  button.click();
  await nextTick();
  assert.equal(calls, 2);
  assert.equal(dialog.querySelector('[role="alert"]'), null);
  resolve();
  await flushPromises();
  assert.equal(button.disabled, false);
  assert.equal(dialog.querySelector('[role="alert"]'), null);
});
