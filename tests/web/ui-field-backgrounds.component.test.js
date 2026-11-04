process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';

import { compileModule, webFile } from './helpers/compile-vue.js';
import { createUiBrowser } from './helpers/ui-components.js';

let browser;
let ui;
let mount;
let h;
let flushPromises;
let css;

const fieldSelector = '.ui-input, .ui-number-input, .ui-textarea, button.ui-select';

before(async () => {
  browser = await createUiBrowser();

  const [vue, utils, facade] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileModule(webFile('src/ui.ts')),
  ]);
  const componentsIndex = await readFile(webFile('src/styles/components/index.css'), 'utf8');
  const componentFiles = [...componentsIndex.matchAll(/@import '\.\/([^']+)';/gu)]
    .map((match) => `components/${match[1]}`);
  const sources = await Promise.all(['tokens.css', 'base.css', ...componentFiles]
    .map((file) => readFile(webFile(`src/styles/${file}`), 'utf8')));

  ({ h } = vue);
  ({ mount, flushPromises } = utils);
  ui = facade;
  css = sources.join('\n');
});

after(async () => {
  await browser?.close();
});

/**
 * Поля создаются через публичный UI-kit с настоящими primitives и составными controls.
 * Контекстные роли включены отдельно: они раньше перекрывали общий фон собственным цветом.
 */
function fields(props = {}, contextual = true) {
  const controls = [
    ui.UiInput,
    ui.UiNumberInput,
    ui.UiTextarea,
    ui.UiSearchInput,
    ui.UiPasswordInput,
    ui.UiNumberField,
  ].map((component) => h(component, props));

  if (contextual) {
    controls.push(
      h(ui.UiInput, { 'data-role': 'chat-title' }),
      h(ui.UiTextarea, { 'data-role': 'task-launch-note' }),
      h(ui.UiInput, { 'data-context': 'settings-field' }),
      h(ui.UiNumberInput, { 'data-context': 'settings-field' }),
      h(ui.UiTextarea, { 'data-context': 'settings-field' }),
    );

    for (const context of ['', 'settings-field', 'code-head-select', 'chat-session-toolbar']) {
      controls.push(h(ui.UiSelect, { searchable: true, 'data-context': context }, {
        default: () => h('option', { value: 'one' }, 'Первый'),
      }));
    }
  }

  return controls;
}

/**
 * Один document сохраняет корректный Vue Teleport, а новые узлы и style исключают старый CSS-кэш.
 * Данные полностью синтетические; фикстура не подключает store или сеть приложения.
 */
function fixture(t, render) {
  browser.document.body.innerHTML = '<div id="mount"></div>';

  const style = browser.document.createElement('style');

  style.textContent = css;
  browser.document.head.append(style);

  const wrapper = mount({ render }, { attachTo: browser.document.querySelector('#mount') });

  t.after(() => {
    wrapper.unmount();
    style.remove();
  });

  return wrapper;
}

/**
 * Сравниваем вычисленный цвет каждого видимого поля, включая вложенные primitives composites.
 * Навигационные селекты шапки кода сохраняют прозрачный фон поверх своей панели.
 * В assertion передаются только строки: форматирование DOM-узла при падении расходует память.
 */
function assertBackground(root, color) {
  const controls = [...root.querySelectorAll(fieldSelector)];

  assert.ok(controls.length > 0);

  for (const control of controls) {
    const context = control.dataset.role || control.dataset.context || control.className;
    const expectedColor = control.dataset.context === 'code-head-select' ? 'transparent' : color;

    assert.equal(browser.getComputedStyle(control).backgroundColor, expectedColor, context);
  }

  return controls;
}

for (const attrs of [{}, { 'data-ui-workspace': '' }, { 'data-ui-touch': '' }]) {
  test(`FIELD-SURFACE: общий фон в окружении ${JSON.stringify(attrs)}`, (t) => {
    const wrapper = fixture(t, () => h('section', attrs, fields()));
    const controls = assertBackground(wrapper.element, '#1c222c');

    assert.equal(controls.length, 15);
  });
}

test('FIELD-LAYER: диалог и поиск селекта сохраняют фон после Teleport из рабочей формы', async (t) => {
  const wrapper = fixture(t, () => h('section', { 'data-ui-workspace': '' }, [
    h(ui.UiInput),
    h(ui.UiDialog, { open: true, label: 'Поля слоя' }, { default: () => fields() }),
  ]));

  await flushPromises();

  const dialog = browser.document.querySelector('.ui-dialog');

  assert.ok(Boolean(dialog));
  assert.equal(wrapper.element.contains(dialog), false);
  assert.equal(Boolean(dialog.closest('[data-ui-workspace]')), false);
  assertBackground(dialog, '#1c222c');

  dialog.querySelector('button.ui-select').click();
  await flushPromises();

  const popup = browser.document.querySelector('.ui-select-popup');

  assert.ok(Boolean(popup));
  assert.equal(dialog.contains(popup), false);
  assertBackground(popup, '#1c222c');
});

for (const attrs of [{}, { 'data-ui-workspace': '' }, { 'data-ui-touch': '' }]) {
  test(`SELECT-STYLE: одинаковые шрифт и поиск во всех меню ${JSON.stringify(attrs)}`, async (t) => {
    const variants = [
      { name: 'inline', props: { compact: true, optionLayout: 'inline' } },
      { name: 'plain', props: {} },
      { name: 'compact', props: { compact: true } },
      { name: 'groups', props: { groupNavigation: true } },
      { name: 'compact-groups', props: { compact: true, groupNavigation: true } },
    ];
    const wrapper = fixture(t, () => h('section', attrs, variants.map((variant) => {
      return h(ui.UiSelect, {
        ...variant.props,
        'data-select-style': variant.name,
        modelValue: 'copy',
        searchable: true,
      }, {
        default: () => h('optgroup', { label: 'repo' }, [
          h('option', { value: 'copy', 'data-description': 'dev' }, 'Основная'),
        ]),
      });
    })));
    let reference;

    for (const variant of variants) {
      await wrapper.get(`button[data-select-style="${variant.name}"]`).trigger('click');
      await flushPromises();

      const popup = browser.document.querySelector('.ui-select-popup');
      const input = popup.querySelector('input');

      input.value = 'Ос';
      input.dispatchEvent(new browser.Event('input', { bubbles: true }));
      input.focus();
      await flushPromises();

      const rowStyle = browser.getComputedStyle(popup.querySelector('[role="option"]'));
      const searchStyle = browser.getComputedStyle(input);
      const clearStyle = browser.getComputedStyle(popup.querySelector('.ui-search-input > button'));
      const actual = {
        width: popup.style.width,
        fontSize: browser.getComputedStyle(popup).fontSize,
        rowMinHeight: rowStyle.minHeight,
        searchHeight: searchStyle.height,
        searchMinHeight: searchStyle.minHeight,
        searchFontSize: searchStyle.fontSize,
        searchRadius: searchStyle.borderRadius,
        searchShadow: searchStyle.boxShadow,
        clearHeight: clearStyle.height,
        clearTop: clearStyle.top,
      };

      if (reference) {
        assert.deepEqual(actual, reference, variant.name);
      } else {
        reference = actual;
        assert.equal(actual.fontSize, '13px');
        assert.equal(actual.searchShadow, 'none');

        if ('data-ui-touch' in attrs) {
          assert.equal(actual.searchHeight, '44px');
        }
      }

      browser.document.body.dispatchEvent(new browser.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
      }));
      await flushPromises();
    }
  });
}

for (const [props, color] of [
  [{ readonly: true }, '#151b24'],
  [{ disabled: true }, '#1c222c'],
  [{ invalid: true }, '#1c222c'],
]) {
  test(`FIELD-STATE: общий фон и состояние ${JSON.stringify(props)}`, (t) => {
    const wrapper = fixture(t, () => h('section', {}, fields(props, false)));
    const controls = assertBackground(wrapper.element, color);

    for (const control of controls) {
      if (props.readonly) {
        assert.equal(control.readOnly, true);
      }
      if (props.disabled) {
        assert.equal(control.disabled, true);
        assert.equal(browser.getComputedStyle(control).opacity, '0.48');
      }
      if (props.invalid) {
        assert.equal(control.getAttribute('aria-invalid'), 'true');
        assert.equal(browser.getComputedStyle(control).borderTopColor, '#f0564c');
      }
    }
  });
}

for (const attrs of [{}, { 'data-ui-workspace': '' }, { 'data-ui-touch': '' }]) {
  test(`ACTION-SURFACE: кнопки и ссылки используют поверхность действий ${JSON.stringify(attrs)}`, (t) => {
    const wrapper = fixture(t, () => h('section', attrs, [
      h(ui.UiButton, {}, () => 'Обычная кнопка'),
      h(ui.UiButton, { disabled: true }, () => 'Недоступная кнопка'),
      h(ui.UiActionLink, { href: '#stand' }, () => 'Фронт :5182'),
      h(ui.UiIconButton, { label: 'Открыть', variant: 'outline' }, () => '+'),
      h(ui.UiButton, { variant: 'ghost' }, () => 'Без заливки'),
      h(ui.UiButton, { variant: 'solid', tone: 'danger' }, () => 'Остановить'),
    ]));
    const controls = [...wrapper.element.querySelectorAll('button, a')];

    assert.equal(controls.length, 6);

    for (const control of controls.slice(0, 4)) {
      assert.equal(browser.getComputedStyle(control).backgroundColor, '#1c222c');
    }

    assert.equal(browser.getComputedStyle(controls[4]).backgroundColor, 'transparent');
    assert.equal(browser.getComputedStyle(controls[5]).backgroundColor, '#f0564c');
  });
}
