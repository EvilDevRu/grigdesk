process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { createUiBrowser } from './helpers/ui-components.js';

let browser;
let UiSelect;
let mount;
let DOMWrapper;
let h;
let nextTick;
let flushPromises;

before(async () => {
  browser = await createUiBrowser();

  const [vue, utils, component] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/components/primitives/UiSelect.vue')),
  ]);

  ({ h, nextTick } = vue);
  ({
    mount,
    DOMWrapper,
    flushPromises,
  } = utils);
  UiSelect = component;
});

after(async () => {
  await browser?.close();
});

/**
 * Один document на файл предотвращает кеширование другого окна в Teleport.
 * Каждый сценарий получает свежий mount и управляемую модель, как настоящий consumer.
 */
function fixture(t, props = {}, slots = {}) {
  browser.document.body.innerHTML = '<div id="mount"></div>';

  const values = [];
  const changes = [];
  let wrapper;

  wrapper = mount(UiSelect, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      modelValue: '',
      ...props,
      'onUpdate:modelValue': (value) => {
        values.push(value);
        wrapper.setProps({ modelValue: value });
      },
      onChange: (event) => {
        changes.push(event);
      },
    },
    slots: {
      default: () => [
        h('option', { value: '' }, 'Без выбора'),
        h('option', { value: '2' }, 'Два'),
        h('option', { value: 'locked', disabled: true }, 'Запрещено'),
      ],
      ...slots,
    },
  });

  t.after(() => {
    if (wrapper.exists()) {
      wrapper.unmount();
    }
  });

  return {
    wrapper,
    values,
    changes,
  };
}

/**
 * Popup телепортируется в body и не является потомком wrapper.
 * Ожидаем Vue-обновления без таймингового ожидания CSS-анимации.
 */
async function openPicker(state) {
  await state.wrapper.get('button.ui-select').trigger('click');
  await nextTick();
  await flushPromises();

  const popup = browser.document.querySelector('.ui-select-popup');

  assert.ok(Boolean(popup), 'общий список не открылся');

  return new DOMWrapper(popup);
}

test('SELECT-UI-01: видимый выбор сохраняет native event и number modifier', async (t) => {
  const state = fixture(t, { compact: true, modelModifiers: { number: true } });
  const native = state.wrapper.get('select');

  assert.equal(native.attributes('hidden'), '');
  assert.equal(native.attributes('aria-hidden'), 'true');
  assert.equal(native.attributes('tabindex'), '-1');
  assert.equal(state.wrapper.get('button.ui-select').attributes('type'), 'button');

  const popup = await openPicker(state);

  await popup.get('[role="option"][data-option-index="1"]').trigger('click');
  await flushPromises();

  assert.deepEqual(state.values, [2]);
  assert.equal(state.changes.length, 1);
  assert.equal(state.changes[0].target instanceof browser.HTMLSelectElement, true);
  assert.equal(state.changes[0].target.value, '2');
  assert.match(state.wrapper.get('button.ui-select').text(), /Два/u);
  assert.equal(state.wrapper.get('button.ui-select').attributes('aria-expanded'), 'false');
});

test('SELECT-MODEL-01: явный undefined очищает управляемое поле после выбора', async (t) => {
  const state = fixture(t, { modelValue: undefined });
  const popup = await openPicker(state);

  await popup.get('[role="option"][data-option-index="1"]').trigger('click');
  await flushPromises();
  assert.deepEqual(state.values, ['2']);
  await state.wrapper.setProps({ modelValue: undefined });
  await nextTick();
  assert.equal(state.wrapper.get('select').element.value, '');
  assert.match(state.wrapper.get('button.ui-select').text(), /Без выбора/u);
});

test('SELECT-MODEL-02: тот же native change не дублирует update модели', async (t) => {
  const state = fixture(t, { modelValue: '2' });

  await state.wrapper.get('select').trigger('change');
  assert.deepEqual(state.values, []);
  assert.equal(state.changes.length, 1);
});

test('SELECT-KEY-01: стрелки пропускают disabled и Enter выбирает активный вариант', async (t) => {
  const state = fixture(t, { modelValue: '2' });
  const popup = await openPicker(state);
  const listbox = popup.get('[role="listbox"]');

  assert.equal(String(listbox.attributes('aria-activedescendant') ?? '').endsWith('-option-1'), true);
  await listbox.trigger('keydown', { key: 'ArrowDown' });
  assert.equal(String(listbox.attributes('aria-activedescendant') ?? '').endsWith('-option-0'), true);
  assert.deepEqual(state.values, []);
  await listbox.trigger('keydown', { key: 'Enter' });
  await flushPromises();
  assert.deepEqual(state.values, ['']);
  assert.equal(browser.document.activeElement === state.wrapper.get('button.ui-select').element, true);

  await openPicker(state);
  browser.document.body.dispatchEvent(new browser.KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  }));
  await nextTick();
  assert.equal(state.wrapper.get('button.ui-select').attributes('aria-expanded'), 'false');
});

test('SELECT-KEY-02: Home, End, буквенный поиск и Space сохраняют прежний смысл', async (t) => {
  const state = fixture(t, { modelValue: '2' });
  const popup = await openPicker(state);
  const listbox = popup.get('[role="listbox"]');

  await listbox.trigger('keydown', { key: 'Home' });
  assert.equal(String(listbox.attributes('aria-activedescendant') ?? '').endsWith('-option-0'), true);
  await listbox.trigger('keydown', { key: 'End' });
  assert.equal(String(listbox.attributes('aria-activedescendant') ?? '').endsWith('-option-1'), true);
  await listbox.trigger('keydown', { key: 'б' });
  assert.equal(String(listbox.attributes('aria-activedescendant') ?? '').endsWith('-option-0'), true);
  assert.deepEqual(state.values, []);
  await listbox.trigger('keydown', { key: ' ' });
  await flushPromises();
  assert.deepEqual(state.values, ['']);
});

test('SELECT-SEARCH-01: auto, поиск по ID и группы не меняют модель', async (t) => {
  const state = fixture(t, { modelValue: 'm0' }, {
    default: () => [
      h('optgroup', { label: 'Первый провайдер' }, Array.from({ length: 10 }, (_, index) => {
        return h('option', { value: 'm' + index }, 'Модель ' + index);
      })),
      h('optgroup', { label: 'Другой провайдер' }, [
        h('option', { value: 'repo/special' }, 'Особая модель'),
      ]),
    ],
  });
  const popup = await openPicker(state);
  const search = popup.get('input[type="search"]');

  await search.setValue('REPO/SPECIAL');
  await flushPromises();

  assert.equal(popup.findAll('[role="option"]').length, 1);
  assert.equal(popup.get('[role="group"]').attributes('aria-label'), 'Другой провайдер');
  assert.deepEqual(state.values, []);
  assert.match(state.wrapper.get('button.ui-select').text(), /Модель 0/u);
  await search.trigger('keydown', { key: 'Enter', isComposing: true });
  assert.deepEqual(state.values, []);
  await search.trigger('keydown', { key: 'Enter' });
  await flushPromises();
  assert.deepEqual(state.values, ['repo/special']);
});

test('SELECT-SEARCH-02: явные режимы и пустой результат сохраняют поле поиска', async (t) => {
  const state = fixture(t, { searchable: true });
  const popup = await openPicker(state);

  await popup.get('input[type="search"]').setValue('ничего');
  await flushPromises();

  assert.equal(popup.findAll('[role="option"]').length, 0);
  assert.equal(popup.find('[role="status"]').exists(), true);
  assert.equal(popup.find('input[type="search"]').exists(), true);
  assert.deepEqual(state.values, []);
});

test('SELECT-GROUPS-01: текущая группа, общий поиск и переход не меняют выбор', async (t) => {
  const state = fixture(t, {
    modelValue: 'glm',
    searchable: true,
    groupNavigation: true,
  }, {
    default: () => [
      h('optgroup', { label: 'Codex' }, [h('option', { value: 'gpt' }, 'GPT')]),
      h('optgroup', { label: 'GLM' }, [
        h('option', { value: 'glm' }, 'GLM-5.3'),
        h('option', { value: 'glm-old' }, 'GLM-4.7'),
      ]),
    ],
  });
  const popup = await openPicker(state);

  assert.equal(popup.findAll('[role="option"]').length, 2);
  assert.equal(popup.get('[data-select-group="1"]').attributes('aria-pressed'), 'true');
  await popup.get('[data-select-group="0"]').trigger('click');
  assert.equal(popup.get('[role="option"]').text(), 'GPT');
  assert.deepEqual(state.values, []);
  assert.deepEqual(state.changes, []);
  await popup.get('input[type="search"]').setValue('GLM-4.7');
  await flushPromises();
  assert.equal(popup.get('[data-select-group="all"]').attributes('aria-pressed'), 'true');
  assert.equal(popup.findAll('[role="option"]').length, 1);
  assert.equal(popup.get('[role="option"]').attributes('data-option-index'), '2');
  await popup.get('input[type="search"]').trigger('keydown', { key: 'Enter' });
  await flushPromises();
  assert.deepEqual(state.values, ['glm-old']);
  assert.equal(state.changes[0].target.selectedIndex, 2);

  const reopened = await openPicker(state);

  assert.equal(reopened.get('[data-select-group="1"]').attributes('aria-pressed'), 'true');
  assert.equal(reopened.findAll('[role="option"]').length, 2);
});

test('SELECT-GROUPS-02: Все включает варианты без группы и сбрасывает поиск', async (t) => {
  const state = fixture(t, {
    modelValue: 'grouped',
    searchable: true,
    groupNavigation: true,
  }, {
    default: () => [
      h('option', { value: 'plain' }, 'Без группы'),
      h('optgroup', { label: 'Исполнитель' }, [h('option', { value: 'grouped' }, 'Модель')]),
    ],
  });
  const popup = await openPicker(state);

  assert.equal(popup.findAll('[role="option"]').length, 1);
  await popup.get('input[type="search"]').setValue('ничего');
  await popup.get('[data-select-group="all"]').trigger('click');
  assert.equal(popup.get('input[type="search"]').element.value, '');
  assert.equal(popup.findAll('[role="option"]').length, 2);
  assert.deepEqual(state.values, []);
});

test('SELECT-SEARCH-03: граница 9/10 и явное выключение работают при открытом списке', async (t) => {
  const { ref } = await import('../../web/node_modules/vue/index.mjs');
  const count = ref(9);
  const state = fixture(t, {}, {
    default: () => [
      h('option', { value: 'hidden', hidden: true }, 'Скрытый'),
      ...Array.from({ length: count.value }, (_, index) => {
        return h('option', { value: String(index), disabled: index === 8 }, 'Вариант ' + index);
      }),
    ],
  });
  const popup = await openPicker(state);

  assert.equal(popup.find('input[type="search"]').exists(), false);
  count.value = 10;
  await nextTick();
  await flushPromises();
  assert.equal(popup.find('input[type="search"]').exists(), true);
  await state.wrapper.setProps({ searchable: false });
  assert.equal(popup.find('input[type="search"]').exists(), false);
  await state.wrapper.setProps({ searchable: true });
  assert.equal(popup.find('input[type="search"]').exists(), true);
  assert.deepEqual(state.values, []);
});

test('SELECT-SLOTS-01: действия и описание не становятся вариантами', async (t) => {
  let actions = 0;
  const state = fixture(t, {}, {
    default: () => h('option', {
      value: '',
      'data-description': 'Пояснение варианта',
    }, 'Пункт'),
    actions: () => h('button', {
      type: 'button',
      'data-adjacent-action': '',
      onClick: () => {
        actions += 1;
      },
    }, 'Обновить'),
    footer: ({ close }) => h('button', {
      type: 'button',
      'data-footer-action': '',
      onClick: () => {
        actions += 1;
        close();
      },
    }, 'Добавить'),
  });

  await state.wrapper.get('[data-adjacent-action]').trigger('click');
  assert.equal(actions, 1);
  assert.equal(state.wrapper.get('button.ui-select').attributes('aria-expanded'), 'false');

  const popup = await openPicker(state);

  assert.match(popup.get('[role="option"]').text(), /Пояснение варианта/u);
  assert.equal(popup.find('[role="listbox"] [data-footer-action]').exists(), false);
  await popup.get('[data-footer-action]').trigger('click');
  await nextTick();
  assert.equal(actions, 2);
  assert.deepEqual(state.values, []);
  assert.equal(state.wrapper.get('button.ui-select').attributes('aria-expanded'), 'false');
});

test('SELECT-SLOTS-02: представление значения и варианта передаёт метаданные наружу', async (t) => {
  const state = fixture(t, { modelValue: '2' }, {
    value: ({ value }) => h('span', { 'data-custom-value': '' }, 'Значение ' + value),
    option: ({ option, selected }) => h('span', {
      'data-custom-option': option.value,
      'data-custom-selected': String(selected),
    }, '◈ ' + option.label),
    header: () => h('span', { 'data-custom-header': '' }, 'Заголовок списка'),
  });

  assert.equal(state.wrapper.get('[data-custom-value]').text(), 'Значение 2');

  const popup = await openPicker(state);

  assert.equal(popup.get('[data-custom-option="2"]').attributes('data-custom-selected'), 'true');
  assert.match(popup.get('[data-custom-option="2"]').text(), /◈ Два/u);
  assert.equal(popup.find('[role="listbox"] [data-custom-header]').exists(), false);
});

test('SELECT-ARIA-01: поиск и extension-поле не наследуют внешний required/id/hint', async (t) => {
  browser.document.body.innerHTML = '<div id="mount"></div>';

  const Harness = await compileVue(webFile('../tests/web/fixtures/ui/components/SelectFieldHarness.vue'));
  const wrapper = mount(Harness, { attachTo: browser.document.querySelector('#mount') });

  t.after(() => wrapper.unmount());

  const trigger = wrapper.get('button.ui-select');

  assert.equal(wrapper.get('label').attributes('for'), trigger.attributes('id'));
  assert.equal(trigger.attributes('aria-required'), 'true');
  assert.ok(Boolean(trigger.attributes('aria-describedby')));
  await trigger.trigger('click');
  await flushPromises();

  for (const selector of ['input[type="search"]', '[data-select-extra-field]']) {
    const input = browser.document.querySelector('.ui-select-popup ' + selector);

    assert.ok(Boolean(input));
    assert.equal(input.required, false);
    assert.equal(input.id === trigger.attributes('id'), false);
    assert.equal(input.hasAttribute('aria-describedby'), false);
  }
});

test('SELECT-LIFE-01: disabled и неизвестное значение не сохраняют случайный выбор', async (t) => {
  const state = fixture(t, { searchable: true }, {
    default: () => h('option', { value: '' }, 'Изначально'),
  });

  await openPicker(state);

  await state.wrapper.setProps({ disabled: true });
  await nextTick();
  assert.equal(state.wrapper.get('button.ui-select').attributes('aria-expanded'), 'false');
  assert.deepEqual(state.values, []);
  assert.deepEqual(state.changes, []);

  await state.wrapper.setProps({ disabled: false, modelValue: 'missing' });
  assert.match(state.wrapper.get('button.ui-select').text(), /missing/u);
  assert.deepEqual(state.values, []);
});

test('SELECT-FIELD-01: invalid фокусирует trigger, внутренний поиск не становится required', async (t) => {
  const state = fixture(t, {
    id: 'fixture-choice',
    required: true,
    searchable: true,
  });
  const native = state.wrapper.get('select');

  native.element.dispatchEvent(new browser.Event('invalid', { cancelable: true }));
  await nextTick();
  assert.equal(browser.document.activeElement === state.wrapper.get('button.ui-select').element, true);
  assert.equal(state.wrapper.get('button.ui-select').attributes('aria-invalid'), 'true');

  const popup = await openPicker(state);
  const search = popup.get('input[type="search"]');

  assert.equal(search.attributes('required'), undefined);
  assert.equal(search.attributes('id') === 'fixture-choice', false);
  await popup.get('[role="option"][data-option-index="1"]').trigger('click');
  await flushPromises();
  assert.equal(state.wrapper.get('button.ui-select').attributes('aria-invalid'), undefined);
});

test('SELECT-VALIDITY-02: внешняя модель снимает старый invalid без change', async (t) => {
  const state = fixture(t, { required: true });

  state.wrapper.get('select').element.dispatchEvent(new browser.Event('invalid', { cancelable: true }));
  await nextTick();
  assert.equal(state.wrapper.get('button.ui-select').attributes('aria-invalid'), 'true');
  await state.wrapper.setProps({ modelValue: '2' });
  await nextTick();
  assert.equal(state.wrapper.get('button.ui-select').attributes('aria-invalid'), undefined);
  assert.deepEqual(state.values, []);
  assert.deepEqual(state.changes, []);
});

test('SELECT-UPDATE-01: реактивный slot обновляет открытый каталог без change', async (t) => {
  browser.document.body.innerHTML = '<div id="mount"></div>';

  const { ref, defineComponent } = await import('../../web/node_modules/vue/index.mjs');
  const catalog = ref([{ value: 'old', label: 'Старая модель' }]);
  const updates = [];
  const changes = [];
  const Parent = defineComponent({
    setup() {
      return () => h(UiSelect, {
        modelValue: 'old',
        searchable: true,
        'onUpdate:modelValue': (value) => {
          updates.push(value);
        },
        onChange: (event) => {
          changes.push(event.type);
        },
      }, {
        default: () => catalog.value.map((item) => {
          return h('option', { value: item.value }, item.label);
        }),
      });
    },
  });
  const wrapper = mount(Parent, { attachTo: browser.document.querySelector('#mount') });

  t.after(() => wrapper.unmount());
  await wrapper.get('button.ui-select').trigger('click');
  await flushPromises();
  catalog.value = [{ value: 'new', label: 'Новая модель' }];
  await nextTick();
  await flushPromises();

  const popup = new DOMWrapper(browser.document.querySelector('.ui-select-popup'));

  assert.match(popup.get('[role="option"]').text(), /Новая модель/u);
  assert.match(wrapper.get('button.ui-select').text(), /old/u);
  assert.deepEqual(updates, []);
  assert.deepEqual(changes, []);
});

test('SELECT-VALIDITY-03: снятие required и приход options исправляют состояние без событий', async (t) => {
  const { ref } = await import('../../web/node_modules/vue/index.mjs');
  const arrived = ref(false);
  const state = fixture(t, { modelValue: 'later', required: true }, {
    default: () => arrived.value ? h('option', { value: 'later' }, 'Поздний вариант') : [],
  });

  state.wrapper.get('select').element.dispatchEvent(new browser.Event('invalid', { cancelable: true }));
  await nextTick();
  assert.equal(state.wrapper.get('button.ui-select').attributes('aria-invalid'), 'true');
  arrived.value = true;
  await nextTick();
  await flushPromises();
  assert.equal(state.wrapper.get('button.ui-select').attributes('aria-invalid'), undefined);
  arrived.value = false;
  await nextTick();
  state.wrapper.get('select').element.dispatchEvent(new browser.Event('invalid', { cancelable: true }));
  await state.wrapper.setProps({ required: false });
  await nextTick();
  assert.equal(state.wrapper.get('button.ui-select').attributes('aria-invalid'), undefined);
  assert.deepEqual(state.values, []);
  assert.deepEqual(state.changes, []);
});

test('SELECT-LIFE-02: unmount во время открытия не оставляет подписки окна', async (t) => {
  const state = fixture(t);
  const listeners = new Set();
  const add = browser.addEventListener;
  const remove = browser.removeEventListener;

  browser.addEventListener = function (type, listener, options) {
    if (type === 'resize') {
      listeners.add(listener);
    }

    return add.call(this, type, listener, options);
  };
  browser.removeEventListener = function (type, listener, options) {
    if (type === 'resize') {
      listeners.delete(listener);
    }

    return remove.call(this, type, listener, options);
  };
  t.after(() => {
    browser.addEventListener = add;
    browser.removeEventListener = remove;
  });

  state.wrapper.get('button.ui-select').element.click();
  state.wrapper.unmount();
  await nextTick();
  await flushPromises();
  assert.equal(listeners.size, 0);
});

test('PH-SELECT: touch открывает список, поиск начинается только явно', async (t) => {
  browser.document.documentElement.setAttribute('data-ui-touch', '');
  t.after(() => browser.document.documentElement.removeAttribute('data-ui-touch'));

  const state = fixture(t, { searchable: true }, {
    default: () => Array.from({ length: 12 }, (_, index) =>
      h('option', { value: String(index) }, `Проект ${index}`)),
  });
  const popup = await openPicker(state);
  const list = popup.get('[role="listbox"]');
  const search = popup.get('input[type="search"]');

  assert.equal(browser.document.activeElement === list.element, true);
  assert.equal(list.attributes('tabindex'), '0');
  assert.deepEqual(state.values, []);

  search.element.focus();
  await search.setValue('Проект 11');
  await nextTick();
  assert.equal(popup.findAll('[role="option"]').length, 1);
  await popup.get('[role="option"]').trigger('click');
  await flushPromises();

  assert.deepEqual(state.values, ['11']);
  assert.equal(state.changes.length, 1);
  assert.equal(state.changes[0].target === state.wrapper.get('select').element, true);
});

test('PH-SELECT: desktop сохраняет автофокус поиска', async (t) => {
  browser.document.documentElement.removeAttribute('data-ui-touch');

  const state = fixture(t, { searchable: true });
  const popup = await openPicker(state);

  assert.equal(browser.document.activeElement === popup.get('input[type="search"]').element, true);
});
