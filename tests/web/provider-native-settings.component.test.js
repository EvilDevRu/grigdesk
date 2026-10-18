import assert from 'node:assert/strict';
import test from 'node:test';

import catalog from '../fixtures/executor-settings/synthetic-catalog.json' with { type: 'json' };
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

test('общая форма нативных настроек', async (t) => {
  await installUiBrowser(t);

  const { reactive } = await import('../../web/node_modules/vue/index.mjs');
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const Component = await compileVue(webFile('src/views/settings/ProviderNativeSettings.vue'), {
    stubs: {
      '../../stores/providerSettings.ts':
        'export const useProviderSettingsStore = () => globalThis.__nativeStore;',
    },
  });

  t.after(() => {
    delete globalThis.__nativeStore;
  });

  await t.test('boolean рисуется с label и передаёт исходный false', async (scenario) => {
    const saves = [];
    const state = reactive({
      catalog: structuredClone(catalog),
      drafts: {},
      errors: {},
      error: '',
      message: '',
      loading: false,
      saving: false,
    });

    globalThis.__nativeStore = {
      panel: () => state,
      async load() {},
      draft(_id, fieldId, value) {
        state.drafts[fieldId] = value;
      },
      async save(...args) {
        saves.push(args);
      },
      async reset() {},
    };

    const wrapper = mount(Component, { props: { providerId: 'future-provider', active: true } });

    scenario.after(() => wrapper.unmount());
    await flushPromises();

    assert.equal(wrapper.find('[role="switch"]').exists(), true);
    assert.match(wrapper.text(), /Для чатов GrigDesk/);
    assert.match(wrapper.text(), /Наследуется/);
    assert.equal(wrapper.get('[role="switch"]').attributes('aria-label'), 'Новая настройка');
    await wrapper.get('[role="switch"]').setValue(false);
    await flushPromises();

    assert.deepEqual(saves[0], ['future-provider', '["enabled"]', false]);
    assert.match(wrapper.text(), /Не сохранено/);
  });

  await t.test(
    'схема рисует числа, typed enum, вложенную строку и список без изменения Vue',
    async (scenario) => {
      const saves = [];
      const value = structuredClone(catalog);
      const base = value.fields[0];
      const field = (name, kind, extra = {}) => ({
        ...base,
        id: JSON.stringify([name]),
        path: [name],
        label: name,
        kind,
        base: { state: 'unknown' },
        default: { state: 'unknown' },
        ...extra,
      });

      value.fields = [
        field('count', 'integer', { constraints: { minimum: 0, maximum: 10 } }),
        field('choice', 'enum', { constraints: { enum: ['1', 1, true, null] } }),
        field('group', 'object', { writable: false, children: [field('text', 'string')] }),
        field('list', 'array', { base: { state: 'known', value: [true] }, items: field('item', 'boolean') }),
      ];

      const state = reactive({
        catalog: value,
        drafts: {},
        errors: {},
        error: '',
        message: '',
        loading: false,
        saving: false,
      });

      globalThis.__nativeStore = {
        panel: () => state,
        async load() {},
        async reset() {},
        draft(_id, fieldId, next) {
          state.drafts[fieldId] = next;
        },
        async save(...args) {
          saves.push(args);
          state.drafts[args[1]] = args[2];
        },
      };

      const wrapper = mount(Component, { props: { providerId: 'future-provider', active: true } });

      scenario.after(() => wrapper.unmount());
      await flushPromises();
      assert.equal(wrapper.get('input[type="number"]').attributes('min'), '0');
      await wrapper.get('select').setValue('option-1');
      await flushPromises();
      assert.equal(saves.at(-1)[2], 1);
      await wrapper.get('[aria-expanded]').trigger('click');
      await flushPromises();
      assert.equal(wrapper.find('input[type="text"]').exists(), true);
      assert.equal(wrapper.text().includes('Элемент 1'), true);

      const nested = wrapper.findAll('[data-field-id]').find((node) => (
        node.attributes('data-field-id') === '["text"]'
      ));

      await nested.get('input[type="text"]').setValue('Вложенный ввод');
      await flushPromises();

      assert.match(nested.text(), /Не сохранено/);

      state.catalog.fields[2].children[0].override = { state: 'known', value: 'Вложенный ввод' };
      delete state.drafts['["text"]'];
      await flushPromises();

      assert.match(nested.text(), /Свой выбор/);
      assert.equal(nested.text().includes('Не сохранено'), false);
    },
  );

  await t.test('числовой шаг UI не подменяет multipleOf; null и reset различаются', async (scenario) => {
    const saves = [];
    const resets = [];
    const value = structuredClone(catalog);
    const boolean = value.fields[0];

    value.fields = [
      {
        ...boolean,
        id: '["amount"]',
        path: ['amount'],
        label: 'Число',
        kind: 'number',
        constraints: { minimum: 0.1, multipleOf: 0.5 },
        base: { state: 'known', value: 0.5 },
      },
      {
        ...boolean,
        kind: 'enum',
        constraints: { enum: [false, null] },
        override: { state: 'known', value: false },
      },
    ];

    const state = reactive({
      catalog: value,
      drafts: {},
      errors: {},
      error: '',
      message: '',
      loading: false,
      saving: false,
    });

    globalThis.__nativeStore = {
      panel: () => state,
      async load() {},
      draft() {},
      async save(...args) {
        saves.push(args);
      },
      async reset(...args) {
        resets.push(args);
      },
    };

    const wrapper = mount(Component, { props: { providerId: 'future-provider', active: true } });

    scenario.after(() => wrapper.unmount());
    await flushPromises();

    assert.equal(wrapper.get('input[type="number"]').attributes('step'), 'any');

    await wrapper.get('select').setValue('option-1');
    await flushPromises();

    assert.deepEqual(saves[0], ['future-provider', '["enabled"]', null]);

    const reset = wrapper.findAll('button').find((button) => button.text() === 'Сбросить');

    assert.equal(Boolean(reset), true);

    await reset.trigger('click');
    await flushPromises();

    assert.deepEqual(resets[0], ['future-provider', '["enabled"]']);
  });

  await t.test('недоступные поля скрыты также при поиске, полный каталог остаётся в сторе',
    async (scenario) => {
      const value = structuredClone(catalog);
      const base = value.fields[0];
      const field = (name, extra = {}) => ({
        ...base,
        id: JSON.stringify([name]),
        path: [name],
        label: name,
        ...extra,
      });

      value.fields = [
        field('Недоступный параметр', {
          kind: 'unknown',
          writable: false,
          reason: 'Тип поля не поддерживается',
          description: 'Длинный технический справочник из схемы CLI',
        }),
        field('Группа', {
          kind: 'object',
          writable: false,
          children: [field('Нужная настройка'), field('Старый флаг', { writable: false })],
        }),
        field('Рабочий переключатель', {
          description: 'Подробное описание рабочего переключателя. '.repeat(10),
        }),
      ];

      const state = reactive({
        catalog: value,
        drafts: {},
        errors: {},
        error: '',
        message: '',
        loading: false,
        saving: false,
      });

      globalThis.__nativeStore = {
        panel: () => state,
        async load() {},
        async reset() {},
        draft() {},
        async save() {},
      };

      const wrapper = mount(Component, { props: { providerId: 'future-provider', active: true } });

      scenario.after(() => wrapper.unmount());
      await flushPromises();

      assert.equal(wrapper.find('[aria-label="Рабочий переключатель"]').exists(), true);
      assert.equal(wrapper.text().includes('Недоступный параметр'), false);
      assert.equal(wrapper.text().includes('Длинный технический справочник'), false);
      assert.equal(wrapper.text().includes('Подробное описание рабочего переключателя'), true);
      assert.equal(wrapper.text().includes('Подробное описание рабочего переключателя. '.repeat(10)), false);
      assert.equal(wrapper.text().includes('Недоступные параметры'), false);

      const working = wrapper.findAll('[data-field-id]').find((node) => (
        node.attributes('data-field-id') === '["Рабочий переключатель"]'
      ));

      assert.equal(Boolean(working), true);

      const details = working.findAll('button').find((button) => button.text().includes('Подробнее'));

      assert.equal(Boolean(details), true);
      await details.trigger('click');
      await flushPromises();

      const description = 'Подробное описание рабочего переключателя. '.repeat(10).trim();

      assert.equal(wrapper.text().includes(description), true);

      for (const button of wrapper.findAll('[aria-controls]')) {
        assert.equal(wrapper.find(`[id="${button.attributes('aria-controls')}"]`).exists(), true);
      }

      await wrapper.get('input[aria-label="Поиск настроек"]').setValue('Недоступный параметр');
      await flushPromises();

      assert.equal(wrapper.text().includes('Недоступный параметр'), false);
      assert.equal(wrapper.text().includes('Тип поля не поддерживается'), false);
      assert.match(wrapper.text(), /Параметры не найдены/);
      assert.equal(state.catalog.fields[0].label, 'Недоступный параметр');
      assert.equal(state.catalog.fields[1].children[1].label, 'Старый флаг');

      await wrapper.get('input[aria-label="Поиск настроек"]').setValue('Нужная');
      await flushPromises();

      assert.equal(wrapper.get('[aria-label="Нужная настройка"]').isVisible(), true);
      assert.equal(wrapper.find('[aria-label="Рабочий переключатель"]').exists(), false);
      assert.equal(wrapper.text().includes('Старый флаг'), false);
    },
  );

  await t.test('устаревший каталог оставляет сброс, черновик и ошибку в рабочей части', async (scenario) => {
    const value = structuredClone(catalog);
    const base = value.fields[0];
    const field = (name, extra = {}) => ({
      ...base,
      id: JSON.stringify([name]),
      path: [name],
      label: name,
      writable: false,
      ...extra,
    });

    value.state = 'stale';
    value.fields = [
      field('Сохранённое', { override: { state: 'known', value: false } }),
      field('Черновик'),
      field('С ошибкой'),
      field('Справочная запись'),
    ];

    const resets = [];
    const state = reactive({
      catalog: value,
      drafts: { '["Черновик"]': false },
      errors: { '["С ошибкой"]': 'Проверьте выбор после смены схемы' },
      error: '',
      message: '',
      loading: false,
      saving: false,
    });

    globalThis.__nativeStore = {
      panel: () => state,
      async load() {},
      async reset(...args) {
        resets.push(args);
      },
      draft() {},
      async save() {},
    };

    const wrapper = mount(Component, { props: { providerId: 'future-provider', active: true } });

    scenario.after(() => wrapper.unmount());
    await flushPromises();

    assert.equal(wrapper.text().includes('Черновик'), true);
    assert.equal(wrapper.text().includes('Проверьте выбор после смены схемы'), true);
    assert.equal(wrapper.text().includes('Справочная запись'), false);
    assert.equal(wrapper.find('[role="switch"]').exists(), false);

    await wrapper.findAll('button').find((button) => button.text() === 'Сбросить').trigger('click');
    await flushPromises();

    assert.deepEqual(resets[0], ['future-provider', '["Сохранённое"]']);
  });

  await t.test('неизвестный base не подменяется default, boolean-редактор сохраняет вид после выбора',
    async (scenario) => {
      const value = structuredClone(catalog);

      value.fields[0].base = { state: 'unknown' };

      const state = reactive({
        catalog: value,
        drafts: {},
        errors: {},
        error: '',
        message: '',
        loading: false,
        saving: false,
      });
      const saves = [];

      globalThis.__nativeStore = {
        panel: () => state,
        async load() {},
        draft() {},
        async reset() {},
        async save(...args) {
          saves.push(args);
          state.catalog.fields[0].override = { state: 'known', value: args[2] };
        },
      };

      const wrapper = mount(Component, { props: { providerId: 'future-provider', active: true } });

      scenario.after(() => wrapper.unmount());
      await flushPromises();

      assert.equal(wrapper.get('select').element.value, '');
      assert.equal(wrapper.get('select option[value=""]').text(), 'Выбирает исполнитель');

      await wrapper.get('select').setValue('option-1');
      await flushPromises();

      assert.deepEqual(saves[0], ['future-provider', '["enabled"]', false]);
      assert.equal(wrapper.find('[role="switch"]').exists(), false);
      assert.equal(wrapper.get('select').element.value, 'option-1');
      assert.match(wrapper.text(), /Свой выбор/);
    },
  );

  await t.test('после ошибки выбор можно сохранить повторно или сбросить', async (scenario) => {
    const state = reactive({
      catalog: structuredClone(catalog),
      drafts: { '["enabled"]': false },
      errors: { '["enabled"]': 'Не удалось сохранить настройку' },
      error: '',
      message: 'Сохранено для следующего запуска',
      loading: false,
      saving: false,
    });
    const saves = [];
    const resets = [];

    globalThis.__nativeStore = {
      panel: () => state,
      async load() {},
      draft() {},
      async save(...args) {
        saves.push(args);
      },
      async reset(...args) {
        resets.push(args);
      },
    };

    const wrapper = mount(Component, { props: { providerId: 'future-provider', active: true } });

    scenario.after(() => wrapper.unmount());
    await flushPromises();

    assert.equal(wrapper.get('[role="switch"]').element.checked, false);
    assert.equal(wrapper.get('[role="switch"]').attributes('aria-invalid'), 'true');
    assert.match(wrapper.get('[role="alert"]').text(), /Не удалось сохранить настройку/);
    assert.equal(wrapper.get('.native-settings__feedback').text(), '');

    await wrapper.findAll('button').find((button) => button.text() === 'Повторить').trigger('click');
    await flushPromises();

    assert.deepEqual(saves[0], ['future-provider', '["enabled"]', false]);

    await wrapper.findAll('button').find((button) => button.text() === 'Сбросить').trigger('click');
    await flushPromises();

    assert.deepEqual(resets[0], ['future-provider', '["enabled"]']);
  });

  await t.test('nullable строка различает null, пустую строку и сброс', async (scenario) => {
    const value = structuredClone(catalog);

    value.fields[0].kind = 'string';
    value.fields[0].constraints = { nullable: true };
    value.fields[0].base = { state: 'unknown' };
    value.fields[0].default = { state: 'unknown' };
    value.fields[0].override = { state: 'known', value: null };

    const state = reactive({
      catalog: value,
      drafts: {},
      errors: {},
      error: '',
      message: '',
      loading: false,
      saving: false,
    });
    const saves = [];
    const resets = [];

    globalThis.__nativeStore = {
      panel: () => state,
      async load() {},
      draft() {},
      async save(...args) {
        saves.push(args);
        state.catalog.fields[0].override = { state: 'known', value: args[2] };
      },
      async reset(...args) {
        resets.push(args);
      },
    };

    const wrapper = mount(Component, { props: { providerId: 'future-provider', active: true } });

    scenario.after(() => wrapper.unmount());
    await flushPromises();

    assert.equal(wrapper.get('input[type="text"]').attributes('placeholder'), 'Пустое значение (null)');

    const emptyString = wrapper.findAll('button').find((button) => button.text() === 'Задать пустую строку');

    await emptyString.trigger('click');
    await flushPromises();

    assert.deepEqual(saves[0], ['future-provider', '["enabled"]', '']);

    const setNull = wrapper.findAll('button').find((button) => (
      button.text() === 'Задать пустое значение (null)'
    ));

    await setNull.trigger('click');
    await flushPromises();

    assert.deepEqual(saves[1], ['future-provider', '["enabled"]', null]);

    await wrapper.findAll('button').find((button) => button.text() === 'Сбросить').trigger('click');
    await flushPromises();

    assert.deepEqual(resets[0], ['future-provider', '["enabled"]']);
  });

  await t.test('scope и поддержка consumers приходят из общего каталога', async (scenario) => {
    const value = structuredClone(catalog);

    value.scope = { id: 'grigdesk-chats-and-pipelines', label: 'Чаты и конвейеры' };
    value.fields[0].appliesTo = ['chat'];
    value.fields[0].consumerSupport = {
      chat: { state: 'verified' },
      pipeline: { state: 'unsupported', reason: 'Поле доступно только в web' },
    };

    const state = reactive({
      catalog: value,
      drafts: {},
      errors: {},
      loading: false,
      saving: false,
    });

    globalThis.__nativeStore = { panel: () => state, async load() {} };

    const wrapper = mount(Component, { props: { providerId: 'future-provider', active: true } });

    scenario.after(() => wrapper.unmount());
    await flushPromises();

    assert.match(wrapper.text(), /Чаты и конвейеры/);
    assert.match(wrapper.text(), /Только чаты/);

    state.catalog.fields[0].consumerSupport.pipeline = {
      state: 'unverified',
      reason: 'ACP-схема временно недоступна',
    };
    await flushPromises();

    assert.equal(wrapper.text().includes('Только чаты'), false);
    assert.match(wrapper.text(), /ACP-схема временно недоступна/);
    assert.equal(wrapper.find('[role="switch"]').exists(), true);
  });

  await t.test('каталог без доступных действий показывает короткое пустое состояние', async (scenario) => {
    const value = structuredClone(catalog);

    value.fields[0].writable = false;

    const state = reactive({
      catalog: value,
      drafts: {},
      errors: {},
      error: '',
      message: '',
      loading: false,
      saving: false,
    });

    globalThis.__nativeStore = {
      panel: () => state,
      async load() {},
    };

    const wrapper = mount(Component, { props: { providerId: 'future-provider', active: true } });

    scenario.after(() => wrapper.unmount());
    await flushPromises();

    assert.match(wrapper.text(), /Дополнительных параметров для изменения сейчас нет/);
    assert.equal(wrapper.find('[data-field-id]').exists(), false);
    assert.equal(wrapper.find('input[type="search"]').exists(), false);
    assert.equal(wrapper.text().includes('Новая настройка'), false);
    assert.equal(state.catalog.fields.length, 1);
  });
});
