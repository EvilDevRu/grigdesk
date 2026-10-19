import assert from 'node:assert/strict';
import test from 'node:test';
import { installUiBrowser } from './helpers/ui-components.js';
import { compileModule, webFile } from './helpers/compile-vue.js';

test('saveFile передаёт файл оболочке и сохраняет браузерный fallback', async (t) => {
  const browser = await installUiBrowser(t);
  const { saveFile } = await compileModule(webFile('src/shared/saveFile.ts'), {
    stubs: {
      '../stores/shell.ts': 'export const useShellStore = () => globalThis.__fileShell;',
      pinia: 'export const getActivePinia = () => ({});',
    },
  });
  const calls = [];
  const blob = new Blob(['проверка'], { type: 'text/plain;charset=utf-8' });

  globalThis.__fileShell = { capabilities: ['save'] };
  t.mock.method(globalThis, 'fetch', async (...args) => {
    calls.push(args);

    return new Response('{}');
  });

  await saveFile(blob, 'имя файла.txt');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/__shell/save?' + new URLSearchParams({
    name: 'имя файла.txt',
    type: blob.type,
  }));
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].body, blob);
  assert.equal(calls[0][1].credentials, 'same-origin');

  globalThis.__fileShell.capabilities = [];

  let clicked = '';
  let revoked = '';

  t.mock.method(URL, 'createObjectURL', () => 'blob:test-file');
  t.mock.method(URL, 'revokeObjectURL', (url) => {
    revoked = url;
  });
  t.mock.method(browser.HTMLAnchorElement.prototype, 'click', function () {
    clicked = this.download;
  });

  await saveFile(blob, 'fallback.txt');
  assert.equal(clicked, 'fallback.txt');
  assert.equal(revoked, 'blob:test-file');
  assert.equal(calls.length, 1);
  assert.equal(document.querySelectorAll('a').length, 0);
  delete globalThis.__fileShell;
});

test('UiActionLink получает нативное сохранение через публичный UI adapter', async (t) => {
  await installUiBrowser(t);

  const ui = await compileModule(webFile('src/ui.ts'));
  const { createApp, h, nextTick } = await import('../../web/node_modules/vue/index.mjs');
  const calls = [];

  ui.setUiDownloadAdapter({
    available: () => true,
    save: async (...args) => {
      calls.push(args);
    },
  });

  const app = createApp({
    render: () => h(ui.UiActionLink, { href: '/api/file', download: 'sample.txt' }, () => 'Скачать'),
  });

  app.mount(document.querySelector('#mount'));

  const link = document.querySelector('a');
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });

  link.dispatchEvent(event);
  await nextTick();
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(calls, [['/api/file', 'sample.txt']]);
  app.unmount();
  ui.setUiDownloadAdapter(null);
});
