process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { createUiBrowser } from './helpers/ui-components.js';

let browser;
let mount;
let h;
let UiInput;
let UiNumberInput;
let UiPaneHeader;
let UiButton;
let UiDialog;

before(async () => {
  browser = await createUiBrowser();

  const [vue, utils, input, number, header, button, dialog] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/components/primitives/UiInput.vue')),
    compileVue(webFile('src/components/primitives/UiNumberInput.vue')),
    compileVue(webFile('src/components/composites/UiPaneHeader.vue')),
    compileVue(webFile('src/components/primitives/UiButton.vue')),
    compileVue(webFile('src/components/overlays/UiDialog.vue')),
  ]);

  ({ h } = vue);
  ({ mount } = utils);
  [UiInput, UiNumberInput, UiPaneHeader, UiButton] = [input, number, header, button];
  UiDialog = dialog;
});

after(async () => browser.close());

/**
 * Загружаем настоящие слои в том же порядке, что production index.css.
 * Happy DOM проверяет каскад и media, но не заменяет проверку геометрии браузером.
 */
async function styleFixture(t, width) {
  browser.happyDOM.setWindowSize({ width, height: 844 });
  browser.document.body.innerHTML = '<div id="mount"></div>';

  const style = browser.document.createElement('style');
  const files = ['tokens', 'base', 'components/foundation', 'components/actions',
    'components/fields', 'components/selection', 'components/patterns',
    'components/feedback', 'components/overlays'];

  const cssText = (await Promise.all(files.map((name) =>
    readFile(webFile(`src/styles/${name}.css`), 'utf8')))).join('\n');

  style.textContent = cssText;
  browser.document.head.append(style);
  t.after(() => style.remove());

  return () => {
    style.textContent = cssText;
  };
}

test('PH-READ: phone исправляет workspace override и number, desktop сохранён', async (t) => {
  const refreshStyles = await styleFixture(t, 390);

  const wrapper = mount({
    render: () => h('section', { class: 'ui-workspace', 'data-ui-workspace': '' }, [
      h(UiInput, { modelValue: 'Имя', 'data-context': 'workspace-path' }),
      h(UiNumberInput, { modelValue: 2 }),
      h('p', { class: 'ui-workspace-copy' }, 'Описание проекта'),
    ]),
  }, { attachTo: browser.document.querySelector('#mount') });

  t.after(() => wrapper.unmount());

  const font = (selector) => browser.getComputedStyle(wrapper.get(selector).element).fontSize;

  assert.equal(font('input[type="text"]'), '16px');
  assert.equal(font('input[type="number"]'), '16px');
  assert.equal(font('.ui-workspace-copy'), '15px');

  browser.happyDOM.setWindowSize({ width: 1280, height: 900 });
  refreshStyles();
  assert.equal(font('input[type="text"]'), '12px');
  assert.equal(font('.ui-workspace-copy'), '13px');
});

test('PH-READ: шапка защищает заголовок и допускает перенос действий', async (t) => {
  const refreshStyles = await styleFixture(t, 320);

  let clicks = 0;
  const wrapper = mount(UiPaneHeader, {
    attachTo: browser.document.querySelector('#mount'),
    slots: {
      title: () => h('h2', 'Базы'),
      meta: () => h('span', 'Подключения'),
      actions: () => h(UiButton, {
        onClick: () => {
          clicks += 1;
        },
      }, () => 'Добавить подключение'),
    },
  });

  t.after(() => wrapper.unmount());

  const css = (selector) => browser.getComputedStyle(wrapper.get(selector).element);

  assert.equal(css('.ui-pane-header__main').flexShrink, '0');
  assert.equal(css('.ui-pane-header__main').maxWidth, '100%');
  assert.equal(css('.ui-pane-header__actions').flexWrap, 'wrap');
  assert.equal(css('h2').fontSize, '12px');
  assert.equal(css('.ui-pane-header__meta').fontSize, '12px');
  await wrapper.get('button').trigger('click');
  assert.equal(clicks, 1);

  browser.happyDOM.setWindowSize({ width: 1280, height: 900 });
  refreshStyles();
  assert.equal(css('h2').fontSize, '13px');
  assert.equal(css('.ui-pane-header__main').flexShrink, '1');
});

test('PHONE-HEADER: панель и диалог используют спокойную шапку карточки задачи', async (t) => {
  browser.document.documentElement.setAttribute('data-ui-touch', '');
  t.after(() => browser.document.documentElement.removeAttribute('data-ui-touch'));

  const refreshStyles = await styleFixture(t, 390);
  const wrapper = mount({
    render: () => h('div', [
      h(UiPaneHeader, {}, { title: () => h('h2', 'Доска') }),
      h(UiDialog, { open: true, title: 'Драйверы трекеров' }, {
        default: () => h('p', 'Содержимое формы'),
      }),
    ]),
  }, {
    attachTo: browser.document.querySelector('#mount'),
    global: { stubs: { teleport: true } },
  });

  t.after(() => wrapper.unmount());

  const css = (selector) => browser.getComputedStyle(wrapper.get(selector).element);

  assert.equal(css('.ui-dialog__title').fontSize, css('.ui-pane-header h2').fontSize);
  assert.equal(css('.ui-dialog__title').fontSize, '12px');
  assert.equal(css('.ui-dialog__title').fontWeight, '500');
  assert.equal(css('.ui-dialog__title').color, css('.ui-pane-header h2').color);
  assert.equal(css('.ui-dialog__header').backgroundColor, css('.ui-pane-header').backgroundColor);
  assert.equal(css('.ui-dialog__header').borderBottomWidth, '1px');
  assert.equal(css('.ui-dialog__header').paddingBottom, '2px');

  browser.happyDOM.setWindowSize({ width: 1280, height: 900 });
  refreshStyles();
  assert.equal(css('.ui-dialog__title').fontSize, '15px');
  assert.equal(css('.ui-pane-header h2').fontSize, '13px');
});

test('PHONE-DENSITY: компактные отступы сохраняют 44px и читаемый ввод', async (t) => {
  browser.document.documentElement.setAttribute('data-ui-touch', '');
  t.after(() => browser.document.documentElement.removeAttribute('data-ui-touch'));

  const refreshStyles = await styleFixture(t, 390);
  const wrapper = mount({
    render: () => h('section', { class: 'ui-workspace', 'data-ui-workspace': '' }, [
      h(UiPaneHeader, {}, {
        navigation: () => h(UiButton, {}, () => 'Назад'),
        title: () => h('h2', 'Базы'),
      }),
      h('div', { class: 'ui-workspace-section__body' }, [
        h('div', { 'data-ui-settings-field': '' }, [h(UiInput, { modelValue: 'Имя' })]),
      ]),
      h('div', { class: 'ui-dialog' }, [
        h('header', { class: 'ui-dialog__header' }, 'Разделы'),
        h('div', { class: 'ui-dialog__body' }, 'Список'),
        h('footer', { class: 'ui-dialog__footer' }, [h(UiButton, {}, () => 'Закрыть')]),
      ]),
    ]),
  }, { attachTo: browser.document.querySelector('#mount') });

  t.after(() => wrapper.unmount());

  const css = (selector) => browser.getComputedStyle(wrapper.get(selector).element);

  assert.equal(css('.ui-workspace-section__body').paddingTop, '8px');
  assert.equal(css('[data-ui-settings-field]').paddingTop, '6px');
  assert.equal(css('.ui-pane-header__layout').paddingTop, '1px');
  assert.equal(css('input').fontSize, '16px');
  assert.equal(css('input').height, '44px');
  assert.equal(css('.ui-pane-header button').minHeight, '44px');
  assert.equal(css('.ui-dialog__body').paddingTop, '10px');

  browser.happyDOM.setWindowSize({ width: 1280, height: 900 });
  refreshStyles();
  assert.equal(css('.ui-workspace-section__body').paddingTop, '12px');
  assert.equal(css('[data-ui-settings-field]').paddingTop, '10px');
  assert.equal(css('.ui-dialog__body').paddingTop, '16px');
});
