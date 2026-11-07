process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { createUiBrowser } from './helpers/ui-components.js';
import { vTooltip } from '../../web/src/services/tooltipDirective.ts';

let sharedBrowser;

before(async () => {
  sharedBrowser = await createUiBrowser();
});

after(async () => {
  await sharedBrowser.close();
});

async function installUiBrowser() {
  return sharedBrowser;
}


test('UiInput сохраняет modifiers и composition semantics', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, UiInput] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/components/primitives/UiInput.vue')),
  ]);
  const values = [];
  const wrapper = mount(UiInput, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      modelValue: '',
      modelModifiers: { trim: true },
      'onUpdate:modelValue': (value) => values.push(value),
    },
  });
  const input = wrapper.element;
  input.dispatchEvent(new browser.CompositionEvent('compositionstart', { bubbles: true }));
  input.value = ' текст ';
  input.dispatchEvent(new browser.InputEvent('input', { bubbles: true }));
  assert.deepEqual(values, []);
  input.dispatchEvent(new browser.CompositionEvent('compositionend', { bubbles: true }));
  assert.deepEqual(values, ['текст']);

  await wrapper.setProps({ modelModifiers: { number: true } });
  input.value = '12.5';
  input.dispatchEvent(new browser.InputEvent('input', { bubbles: true }));
  assert.equal(values.at(-1), 12.5);
  wrapper.unmount();
});

test('UiField связывает label, hint/error и invalid с control', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, Harness] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('../tests/web/fixtures/ui/components/FieldHarness.vue')),
  ]);
  const wrapper = mount(Harness, { attachTo: browser.document.querySelector('#mount') });
  const input = wrapper.get('input');
  const id = input.attributes('id');
  assert.ok(id);
  assert.equal(wrapper.get('label').attributes('for'), id);
  assert.equal(input.attributes('required'), '');
  assert.equal(input.attributes('aria-describedby'), `${id}-hint`);
  await wrapper.setProps({ error: 'Ошибка' });
  assert.equal(input.attributes('aria-invalid'), 'true');
  assert.equal(input.attributes('aria-describedby'), `${id}-error`);
  await wrapper.setProps({ help: 'Имя видно в списке участников.' });
  assert.equal(wrapper.get('label').attributes('for'), id);
  assert.equal(input.attributes('aria-describedby'), `${id}-error`);
  assert.equal(wrapper.find('label button').exists(), false);
  assert.match(wrapper.get('button').attributes('aria-label'), /Имя/);
  wrapper.unmount();
});

test('UiNumberInput не превращает пустое значение в ноль', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, UiNumberInput] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/components/primitives/UiNumberInput.vue')),
  ]);
  const values = [];
  const wrapper = mount(UiNumberInput, {
    attachTo: browser.document.querySelector('#mount'),
    props: { modelValue: 4, 'onUpdate:modelValue': (value) => values.push(value) },
  });
  wrapper.element.value = '';
  wrapper.element.dispatchEvent(new browser.InputEvent('input', { bubbles: true }));
  assert.equal(values.at(-1), '');
  wrapper.unmount();
});

test('UiSelect compact сжимает wrapper и сохраняет number modifier', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, UiSelect] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/components/primitives/UiSelect.vue')),
  ]);
  const values = [];
  const wrapper = mount(UiSelect, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      compact: true,
      modelValue: '',
      modelModifiers: { number: true },
      'onUpdate:modelValue': (value) => values.push(value),
    },
    slots: {
      default: '<option value="">—</option><option value="2">Два</option>',
    },
  });

  assert.equal(wrapper.classes().includes('ui-select-wrap--compact'), true);
  assert.equal(wrapper.get('button.ui-select').classes().includes('ui-select--compact'), true);
  await wrapper.get('select').setValue('2');
  assert.equal(values.at(-1), 2);
  wrapper.unmount();
});

test('UiFilePicker dropzone передаёт файлы и может скрыть служебные actions', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, UiFilePicker] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/components/composites/UiFilePicker.vue')),
  ]);
  const changes = [];
  const wrapper = mount(UiFilePicker, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      presentation: 'dropzone',
      density: 'compact',
      showSummary: false,
      showReset: false,
      onChange: (files) => changes.push(files),
    },
    slots: {
      default: 'Выбрать запись',
      hint: 'Видео или аудио',
      trailing: 'Открыть',
    },
  });
  const input = wrapper.get('input[type="file"]');

  Object.defineProperty(input.element, 'files', {
    value: [new browser.File(['данные'], 'встреча.mp4', { type: 'video/mp4' })],
    configurable: true,
  });
  await input.trigger('change');

  assert.equal(wrapper.classes().includes('ui-file-picker--dropzone'), true);
  assert.equal(wrapper.classes().includes('ui-file-picker--compact'), true);
  assert.equal(changes.length, 1);
  assert.equal(changes[0][0].name, 'встреча.mp4');
  assert.equal(wrapper.find('.ui-file-picker__summary').exists(), false);
  assert.equal(wrapper.findAll('button').length, 1);
  wrapper.unmount();
});

test('TIP-MIG-02: составные поля сохраняют описание и справку на корне', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, { h, withDirectives }] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/vue/index.mjs'),
  ]);

  for (const [file, field] of [
    ['src/components/primitives/UiSelect.vue', 'select'],
    ['src/components/primitives/UiSwitch.vue', 'input'],
    ['src/components/composites/UiSearchInput.vue', 'input'],
  ]) {
    const control = await compileVue(webFile(file));
    const wrapper = mount({
      render: () => withDirectives(h(control, { 'aria-description': 'x' }), [[vTooltip, 'x']]),
    }, { attachTo: browser.document.querySelector('#mount') });

    t.after(() => wrapper.unmount());
    assert.equal(wrapper.element.getAttribute('data-ui-tooltip'), 'x');
    assert.equal(wrapper.get(field).attributes('aria-description'), 'x');
    wrapper.unmount();
  }
});


test('UiPaneHeader сохраняет семантику слотов и действия вложенных controls', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, { h }, UiPaneHeader, UiButton] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/vue/index.mjs'),
    compileVue(webFile('src/components/composites/UiPaneHeader.vue')),
    compileVue(webFile('src/components/primitives/UiButton.vue')),
  ]);
  let clicks = 0;
  const wrapper = mount(UiPaneHeader, {
    attachTo: browser.document.querySelector('#mount'),
    props: { inset: 'content' },
    attrs: { 'aria-label': 'Паспорт проекта' },
    slots: {
      title: () => h('h2', 'Название из данных'),
      meta: () => h('span', 'Активный'),
      navigation: () => h(UiButton, {}, () => 'Проекты'),
      actions: () => h(UiButton, { onClick: () => {
        clicks += 1;
      } }, () => 'Открыть'),
      default: () => h('span', 'Дополнительное содержимое'),
    },
  });

  t.after(() => wrapper.unmount());
  assert.equal(wrapper.element.tagName, 'HEADER');
  assert.equal(wrapper.attributes('aria-label'), 'Паспорт проекта');
  assert.equal(wrapper.get('h2').text(), 'Название из данных');
  assert.match(wrapper.text(), /Дополнительное содержимое/);
  await wrapper.get('.ui-pane-header__actions button').trigger('click');
  assert.equal(clicks, 1);
});
