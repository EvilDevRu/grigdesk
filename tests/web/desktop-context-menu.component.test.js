import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { createUiBrowser } from './helpers/ui-components.js';
import { requestDesktopContextMenu } from '../../shared/desktop/contextMenu.ts';

let browser;
let mount;
let nextTick;
let Menu;

before(async () => {
  browser = await createUiBrowser();

  const vue = await import('../../web/node_modules/vue/index.mjs');
  const utils = await import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');

  nextTick = vue.nextTick;
  mount = utils.mount;
  Menu = await compileVue(webFile('src/components/primitives/UiDesktopContextMenu.vue'));
});

after(async () => {
  await browser?.close();
});

const request = {
  x: 800,
  y: 600,
  items: [
    {
      label: 'Вставить',
      action: 'paste',
      shortcut: 'Ctrl+V',
    },
    null,
    {
      label: 'Копировать адрес ссылки',
      action: 'link',
      shortcut: '',
    },
  ],
};

test('выбор возвращает индекс, сохраняет фокус редактора и не раскрывает адрес ссылки', async () => {
  document.body.innerHTML = '<textarea>Текст</textarea>';

  const editor = document.querySelector('textarea');

  editor.focus();
  editor.setSelectionRange(1, 3);

  const wrapper = mount(Menu, { attachTo: document.body });
  const result = requestDesktopContextMenu(request);

  await nextTick();
  assert.equal(document.querySelectorAll('[role="menuitem"]').length, 2);
  assert.equal(document.querySelector('[role="separator"]').textContent, '');
  document.querySelector('[role="menuitem"]').click();
  assert.equal(await result, 0);
  assert.equal(document.activeElement, editor);
  assert.equal(editor.selectionStart, 1);
  await nextTick();
  assert.equal(document.querySelector('[role="menu"]'), null);
  wrapper.unmount();
});

test('повторное открытие и щелчок снаружи завершают ожидающие запросы', async () => {
  const wrapper = mount(Menu, { attachTo: document.body });
  const first = requestDesktopContextMenu(request);
  const second = requestDesktopContextMenu(request);

  assert.equal(await first, null);
  await nextTick();
  document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  assert.equal(await second, null);
  wrapper.unmount();
  assert.equal(await requestDesktopContextMenu(request), 'native');
});


test('стрелки пропускают разделители, Enter выбирает и Escape закрывает меню', async () => {
  document.body.innerHTML = '<textarea>Текст</textarea>';

  const editor = document.querySelector('textarea');

  editor.focus();

  const wrapper = mount(Menu, { attachTo: document.body });
  const selected = requestDesktopContextMenu(request);

  await nextTick();

  for (const key of ['ArrowDown', 'ArrowDown', 'Enter']) {
    document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }));
  }

  assert.equal(await selected, 2);
  assert.equal(document.activeElement, editor);

  const cancelled = requestDesktopContextMenu(request);

  await nextTick();
  editor.setAttribute('data-escape-owner', 'editor');
  editor.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(await cancelled, null);
  wrapper.unmount();
});
