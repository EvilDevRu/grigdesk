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
let UiWorkspacePage;
let UiActionLink;
let UiIconButton;
let TabsHarness;
let UiSearchInput;
let UiCreateButton;

before(async () => {
  browser = await createUiBrowser();

  const [vue, utils, input, number, header, button, dialog, page, link, icon] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/components/primitives/UiInput.vue')),
    compileVue(webFile('src/components/primitives/UiNumberInput.vue')),
    compileVue(webFile('src/components/composites/UiPaneHeader.vue')),
    compileVue(webFile('src/components/primitives/UiButton.vue')),
    compileVue(webFile('src/components/overlays/UiDialog.vue')),
    compileVue(webFile('src/components/composites/UiWorkspacePage.vue')),
    compileVue(webFile('src/components/primitives/UiActionLink.vue')),
    compileVue(webFile('src/components/primitives/UiIconButton.vue')),
  ]);

  ({ h } = vue);
  ({ mount } = utils);
  [UiInput, UiNumberInput, UiPaneHeader, UiButton] = [input, number, header, button];
  UiDialog = dialog;
  [UiWorkspacePage, UiActionLink, UiIconButton] = [page, link, icon];

  [TabsHarness, UiSearchInput, UiCreateButton] = await Promise.all([
    compileVue(webFile('../tests/web/fixtures/ui/components/TabsHarness.vue')),
    compileVue(webFile('src/components/composites/UiSearchInput.vue')),
    compileVue(webFile('src/components/primitives/UiCreateButton.vue')),
  ]);
});

after(async () => browser.close());

for (const touch of [false, true]) {
  test(`WORKSPACE-CREATE: общий круглый плюс при touch=${touch}`, async (t) => {
    await styleFixture(t, 390);

    if (touch) {
      browser.document.documentElement.setAttribute('data-ui-touch', '');
      t.after(() => browser.document.documentElement.removeAttribute('data-ui-touch'));
    }

    let clicks = 0;
    const create = () => h(UiCreateButton, {
      label: 'Добавить профиль',
      onClick: () => {
        clicks += 1;
      },
    });
    const wrapper = mount({
      render: () => h('div', [create(), h(UiPaneHeader, {}, { actions: create })]),
    }, { attachTo: browser.document.querySelector('#mount') });

    t.after(() => wrapper.unmount());

    for (const button of wrapper.findAll('button')) {
      const css = browser.getComputedStyle(button.element);

      assert.equal(css.width, '32px');
      assert.equal(css.height, '32px');
      assert.equal(css.borderRadius, '50%');
      assert.equal(css.marginLeft, '6px');
      assert.equal(css.marginRight, '6px');
      assert.equal(button.attributes('aria-label'), 'Добавить профиль');
      assert.equal(button.text(), '＋');
      await button.trigger('click');
    }

    assert.equal(clicks, 2);
  });
}

for (const width of [390, 1280]) {
  test(`WORKSPACE-CONTROLS: единые компактные вкладки и поиск при ${width}px`, async (t) => {
    await styleFixture(t, width);
    browser.document.documentElement.setAttribute('data-ui-touch', '');
    t.after(() => browser.document.documentElement.removeAttribute('data-ui-touch'));

    const wrapper = mount({
      render: () => h('div', [false, true].map((workspace) => h('section', {
        class: workspace ? 'ui-workspace' : undefined,
        'data-ui-workspace': workspace ? '' : undefined,
      }, [
        h(TabsHarness, { size: 'compact', 'data-ui-workspace-tabs': '' }),
        h(UiSearchInput, { size: 'compact', modelValue: 'Запрос' }),
      ]))),
    }, { attachTo: browser.document.querySelector('#mount') });

    t.after(() => wrapper.unmount());

    for (const section of wrapper.findAll('section')) {
      const css = (selector) => browser.getComputedStyle(section.get(selector).element);

      assert.equal(Number.parseFloat(css('.ui-tabs').gap), 0);
      assert.equal(css('.ui-tabs').overflowY, 'visible');
      assert.equal(css('.ui-tabs').marginTop, '6px');
      assert.equal(css('.ui-tab').minHeight, '32px');
      assert.equal(css('.ui-tab').fontSize, '12px');
      assert.equal(css('input').height, '32px');
      assert.equal(css('input').fontSize, '13px');
      assert.equal(css('.ui-search-input button').height, '24px');

      await section.get('[role="tablist"]').trigger('keydown', { key: 'End' });
      assert.equal(section.findAll('[role="tab"]')[1].attributes('aria-selected'), 'true');
      await section.get('.ui-search-input button').trigger('click');
      assert.equal(browser.document.activeElement === section.get('input').element, true);
    }
  });
}

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

test('PHONE-PANELS: общий каркас не зависит от рабочего режима и вида действия', async (t) => {
  await styleFixture(t, 390);

  const wrapper = mount({
    render: () => h('div', [false, true].map((workspace) => h(UiWorkspacePage, {
      'data-ui-workspace': workspace ? '' : undefined,
    }, {
      title: () => h('h1', 'Раздел'),
      actions: () => [
        h(UiButton, { 'data-context': 'workspace-toolbar' }, () => 'Создать'),
        h(UiActionLink, { href: '#/inbox', size: 'compact' }, () => 'Общая очередь'),
        h(UiIconButton, {
          label: 'Обновить',
          'data-context': 'workspace-toolbar',
        }, () => '↻'),
      ],
      default: () => h('p', { class: 'ui-workspace-intro' }, 'Пояснение раздела'),
    }))),
  }, { attachTo: browser.document.querySelector('#mount') });

  t.after(() => wrapper.unmount());

  const css = (root, selector) => browser.getComputedStyle(root.get(selector).element);
  const pages = wrapper.findAll('.ui-workspace-page');

  for (const page of pages) {
    assert.equal(page.element.children[0].tagName, 'HEADER');
    assert.equal(page.element.children[1].className, 'ui-workspace-page__body');
    assert.equal(page.find('.ui-pane-header .ui-workspace-intro').exists(), false);
    assert.equal(css(page, '.ui-workspace-page__body').overflow, 'auto');
    assert.equal(css(page, '.ui-workspace-page__body').paddingLeft, '10px');
    assert.equal(css(page, 'h1').fontSize, '12px');
    assert.equal(css(page, '.ui-button:not(.ui-icon-button)').minHeight, '32px');
    assert.equal(css(page, '.ui-action-link').minHeight, '32px');
    assert.equal(css(page, '.ui-action-link').borderRadius, '4px');
    assert.equal(css(page, '.ui-icon-button').height, '44px');
    assert.equal(css(page, '.ui-pane-header__actions').minHeight, '44px');
  }

  assert.equal(css(pages[0], '.ui-pane-header').backgroundColor,
    css(pages[1], '.ui-pane-header').backgroundColor);
});

for (const touch of [false, true]) {
  test(`SECTION-PANELS: desktop с touch=${touch} сохраняет общую шкалу шапки`, async (t) => {
    await styleFixture(t, 1280);

    if (touch) {
      browser.document.documentElement.setAttribute('data-ui-touch', '');
      t.after(() => browser.document.documentElement.removeAttribute('data-ui-touch'));
    }

    const wrapper = mount(UiWorkspacePage, {
      attachTo: browser.document.querySelector('#mount'),
      slots: {
        title: () => h('h1', 'Раздел'),
        actions: () => [
          h(UiButton, {}, () => 'Создать'),
          h(UiIconButton, { label: 'Обновить', 'data-context': 'workspace-toolbar' }, () => '↻'),
        ],
        default: () => h('p', 'Содержимое'),
      },
    });

    t.after(() => wrapper.unmount());

    const css = (selector) => browser.getComputedStyle(wrapper.get(selector).element);

    assert.equal(css('.ui-button:not(.ui-icon-button)').minHeight, touch ? '32px' : '28px');
    assert.equal(css('.ui-icon-button').height, touch ? '44px' : '28px');
    assert.equal(css('h1').fontSize, '13px');
    assert.equal(css('.ui-pane-header__layout').paddingTop, touch ? '1px' : '3px');
  });
}

test('PHONE-PANELS: панель фильтров сжимается, экран без шапки сохраняет тело', async (t) => {
  await styleFixture(t, 320);

  const wrapper = mount({
    render: () => h('div', [
      h(UiPaneHeader, {}, {
        default: () => h('div', 'Выбор проекта и состояния'),
        actions: () => h(UiIconButton, { label: 'Управление' }, () => '⋯'),
      }),
      h(UiWorkspacePage, {}, { default: () => h('p', 'Редактор') }),
    ]),
  }, { attachTo: browser.document.querySelector('#mount') });

  t.after(() => wrapper.unmount());

  const main = wrapper.get('.ui-pane-header__main').element;

  assert.equal(wrapper.get('.ui-pane-header').attributes('data-layout'), 'controls');
  assert.equal(browser.getComputedStyle(main).flexShrink, '1');
  assert.equal(wrapper.find('.ui-workspace-page .ui-pane-header').exists(), false);
  assert.equal(wrapper.get('.ui-workspace-page__body').text(), 'Редактор');
});

test('PANEL-HEADER: панель и диалог используют шапку задачи на телефоне и desktop', async (t) => {
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
  assert.equal(css('.ui-dialog__title').fontSize, '13px');
  assert.equal(css('.ui-pane-header h2').fontSize, '13px');
  assert.equal(css('.ui-dialog__title').fontWeight, css('.ui-pane-header h2').fontWeight);
  assert.equal(css('.ui-dialog__header').backgroundColor, css('.ui-pane-header').backgroundColor);
  assert.equal(css('.ui-dialog__header').paddingTop, css('.ui-pane-header__layout').paddingTop);
  assert.equal(css('.ui-dialog__header').paddingBottom, css('.ui-pane-header__layout').paddingBottom);

  browser.document.documentElement.removeAttribute('data-ui-touch');
  refreshStyles();
  assert.equal(css('.ui-dialog__header').paddingTop, '3px');
  assert.equal(css('.ui-dialog__header').paddingBottom, '4px');
  assert.equal(css('.ui-dialog__header').paddingTop, css('.ui-pane-header__layout').paddingTop);
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
