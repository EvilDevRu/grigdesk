process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test from 'node:test';
import { compileVue, webFile, singletonUrl } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';
import { LIBRARY_ID, INTENT_ID, stateDto, modelDto, UNIT } from './helpers/studio3d-fixtures.js';

test('WC-11 библиотека после mount запускает offers с появившимся libraryId', async (t) => {
  await installUiBrowser(t);

  const { reactive, nextTick } = await import(singletonUrl('vue'));
  const { mount } = await import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.cjs.js');
  const calls = [];
  const store = reactive({
    state: null,
    libraryId: '',
    offers: [],
    quoted: null,
    busy: 0,
    loadOffers: async () => {
      calls.push(store.libraryId);
    }
  });

  globalThis.__studioCreate = { store };

  const component = await compileVue(webFile('src/views/studio3d/CreatePanel.vue'), {
    stubs: {
      '../../stores/studio3d.ts': 'export const useStudio3dStore=()=>globalThis.__studioCreate.store;',
      '../../shared/projectsApi.ts': 'export const projectsApi={list:async()=>[]};'
    }
  });
  const wrapper = mount(component);

  t.after(() => wrapper.unmount());
  await nextTick();

  store.state = stateDto();
  store.libraryId = LIBRARY_ID;
  await nextTick();

  assert.deepEqual(calls, [LIBRARY_ID]);
});

test('WC-04/05 создание, наборы, server batch и виды', async (t) => {
  await installUiBrowser(t);
  
  const { reactive, nextTick } = await import(singletonUrl('vue'));
  const { mount } = await import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.cjs.js');
  
  t.mock.timers.enable({ apis: ['setTimeout'] });
  
  const calls = [];
  const offer = {
    provider: 'tripo',
    providerName: 'Tripo',
    local: false,
    operation: 'text-to-model',
    label: 'Модель',
    group: 'model',
    fields: [{
      id: 'prompt',
      kind: 'textarea',
      label: 'Описание',
      default: ''
    }],
    presets: [{
      id: 'character',
      label: 'Персонаж',
      values: { prompt: 'Персонаж' },
      hint: null
    }],
    note: null,
    priceKnown: true,
    available: true,
    reason: null,
    quote: {
      total: 40,
      lines: [],
      unit: UNIT,
      usd: null,
      note: null
    }
  };
  const store = reactive({
    state: stateDto(),
    libraryId: LIBRARY_ID,
    offers: [offer],
    quoted: null,
    busy: 0,
    loadOffers: async () => ({ libraryId: LIBRARY_ID, offers: [offer] }),
    quote: async (input) => {
      calls.push({ kind: 'quote', input });
      store.quoted = {
        libraryId: LIBRARY_ID,
        quote: offer.quote,
        validation: {
          values: input.values,
          errors: [],
          warnings: []
        }
      };

      return store.quoted;
    },
    batchQuote: async (rows) => {
      calls.push({ kind: 'batchQuote', rows });
      
      return {
        libraryId: LIBRARY_ID,
        snapshot: {
          libraryId: LIBRARY_ID,
          rows,
          catalogVersion: 'fixture',
          totalEstimated: 120,
          unit: UNIT
        },
        snapshotHash: 'a'.repeat(64),
        totalEstimated: 120,
        unit: UNIT,
        rows: rows.map((row) => ({
          valid: true,
          errors: [],
          quote: offer.quote,
          row
        })),
        expiresAt: '2026-10-11T10:10:00Z'
      };
    },
    batchRun: async (input, key) => {
      calls.push({
        kind: 'batchRun',
        input,
        key
      });
      
      return {
        libraryId: LIBRARY_ID,
        intentId: INTENT_ID,
        children: [],
        status: 'waiting',
        totalEstimated: 120,
        unit: UNIT
      };
    },
    run: async (input, key) => { calls.push({
      kind: 'run',
      input,
      key
    });
      
      return {
        libraryId: LIBRARY_ID,
        intentId: INTENT_ID,
        deleted: false,
        model: modelDto(),
        versions: []
      }; }
  });
  const h = {
    store,
    calls,
    allow: true,
    questions: []
  };
  
  globalThis.__studioCreate = h;
  
  const Create = await compileVue(webFile('src/views/studio3d/CreatePanel.vue'), { stubs: {
    '../../stores/studio3d.ts': 'export const useStudio3dStore=()=>globalThis.__studioCreate.store;',
    '../../shared/projectsApi.ts': 'export const projectsApi={list:async()=>[]};',
    '../../ui.ts': `export * from './src/ui.ts';
      export const confirmDialog=async(text)=>{globalThis.__studioCreate.questions.push(text);
      return globalThis.__studioCreate.allow;};`,
  } });
  const wrapper = mount(Create);
  
  t.after(() => wrapper.unmount());
  await new Promise(setImmediate);
  await nextTick();
  assert.equal(wrapper.text().includes('Из текста'), true);
  assert.equal(wrapper.text().includes('Свой файл'), true);
  
  const preset = wrapper.findAll('button').find((button) => button.text() === 'Персонаж');
  
  await preset.trigger('click');
  assert.equal(wrapper.get('textarea').element.value, 'Персонаж');
  await wrapper.get('[data-context="studio-batch-toggle"]').setValue(true);
  await wrapper.get('textarea').setValue('Первый\nВторой\nТретий');
  t.mock.timers.tick(301);
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  await wrapper.get('[data-context="studio-price"]').trigger('click');
  await new Promise(setImmediate);
  assert.equal(h.questions[0].includes('120 кредитов'), true);
  assert.equal(h.questions[0].includes('Создать 3 модели'), true);
  assert.equal(calls.filter((call) => call.kind === 'batchRun').length, 1);
  assert.equal(calls.filter((call) => call.kind === 'run').length, 0);
  assert.equal(calls.find((call) => call.kind === 'batchRun').input.snapshot.rows.length, 3);

  await t.test('WC-04 отказ подтверждения не вызывает run, следующая цена требует нового решения',
    async () => {
    h.allow = false;
    
    const before = calls.filter((call) => call.kind === 'batchRun').length;
    
    await wrapper.get('[data-context="studio-price"]').trigger('click');
    await new Promise(setImmediate);
    assert.equal(calls.filter((call) => call.kind === 'batchRun').length, before);
    assert.equal(calls.filter((call) => call.kind === 'run').length, 0);
  });

  await t.test('WC-14 правка формы во время подтверждения пачки не вызывает batchRun', async () => {
    const batchRuns = () => calls.filter((call) => call.kind === 'batchRun').length;
    const asked = h.questions.length;
    const before = batchRuns();
    let confirm;

    // Диалог висит, пока тест не ответит: заглушка confirmDialog возвращает этот Promise.
    h.allow = new Promise((resolve) => {
      confirm = resolve;
    });
    await wrapper.get('[data-context="studio-price"]').trigger('click');
    await new Promise(setImmediate);
    assert.equal(h.questions.length, asked + 1);

    await wrapper.get('textarea').setValue('Первый\nВторой\nЧетвёртый');
    confirm(true);
    await new Promise(setImmediate);
    assert.equal(batchRuns(), before);

    // Контроль: та же форма без правки во время диалога после согласия даёт ровно один batchRun.
    t.mock.timers.tick(301);
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    h.allow = new Promise((resolve) => {
      confirm = resolve;
    });
    await wrapper.get('[data-context="studio-price"]').trigger('click');
    await new Promise(setImmediate);
    assert.equal(h.questions.length, asked + 2);
    assert.equal(batchRuns(), before);

    confirm(true);
    await new Promise(setImmediate);
    assert.equal(batchRuns(), before + 1);
    assert.deepEqual(calls.filter((call) => call.kind === 'batchRun').at(-1).input.snapshot.rows
      .map((row) => row.values.prompt), ['Первый', 'Второй', 'Четвёртый']);
  });

  await t.test('WC-14 скрытие формы во время подтверждения пачки не вызывает batchRun', async () => {
    const batchRuns = () => calls.filter((call) => call.kind === 'batchRun').length;
    const asked = h.questions.length;
    const before = batchRuns();
    let confirm;

    // Цена пачки готова, даже если прежний сценарий оставил её расчёт в таймере.
    t.mock.timers.tick(301);
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    h.allow = new Promise((resolve) => {
      confirm = resolve;
    });
    await wrapper.get('[data-context="studio-price"]').trigger('click');
    await new Promise(setImmediate);
    assert.equal(h.questions.length, asked + 1);

    await wrapper.setProps({ active: false });
    confirm(true);
    await new Promise(setImmediate);
    await wrapper.setProps({ active: true });
    assert.equal(batchRuns(), before);
  });

  await t.test('WC-14 размонтирование во время подтверждения пачки не вызывает batchRun', async () => {
    const batchRuns = () => calls.filter((call) => call.kind === 'batchRun').length;
    const panel = mount(Create);
    const asked = h.questions.length;
    const before = batchRuns();
    let confirm;

    await new Promise(setImmediate);
    await nextTick();
    await panel.get('[data-context="studio-batch-toggle"]').setValue(true);
    await panel.get('textarea').setValue('Первый\nВторой');
    t.mock.timers.tick(301);
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    h.allow = new Promise((resolve) => {
      confirm = resolve;
    });
    await panel.get('[data-context="studio-price"]').trigger('click');
    await new Promise(setImmediate);
    assert.equal(h.questions.length, asked + 1);

    panel.unmount();
    confirm(true);
    await new Promise(setImmediate);
    assert.equal(batchRuns(), before);
  });

  await t.test('WC-12 черновик сохраняется, чужой и поздний quote не разрешают запуск', async () => {
    await wrapper.get('[data-context="studio-batch-toggle"]').setValue(false);
    await wrapper.get('textarea').setValue('Лампа из металла');
    await new Promise(setImmediate);

    const quote = store.quote;
    let finishQuote;

    store.quote = () => new Promise((resolve) => {
      finishQuote = resolve;
    });
    await wrapper.get('textarea').setValue('Лампа из дерева');
    await wrapper.setProps({ active: false });

    const quoteCalls = calls.filter((call) => call.kind === 'quote').length;

    store.offers = [{
      ...offer,
      operation: 'export',
      fields: []
    }];
    store.quoted = {
      libraryId: LIBRARY_ID,
      quote: { ...offer.quote, total: 999 },
      validation: {
        values: {},
        errors: [],
        warnings: []
      }
    };
    finishQuote(store.quoted);
    await new Promise(setImmediate);
    assert.equal(wrapper.get('textarea').element.value, 'Лампа из дерева');
    assert.equal(wrapper.get('[data-context="studio-price"]').element.disabled, true);
    assert.equal(wrapper.get('.studio-price-summary').text().includes('999'), false);
    assert.equal(calls.filter((call) => call.kind === 'quote').length, quoteCalls);

    store.quote = quote;
    await wrapper.setProps({ active: true });
    await new Promise(setImmediate);
    assert.equal(wrapper.get('textarea').element.value, 'Лампа из дерева');
    assert.equal(wrapper.get('[data-context="studio-price"]').element.disabled, false);
    assert.match(wrapper.get('.studio-price-summary').text(), /40 кредитов/);
  });

  await t.test('WC-13 удаление входа и двойное нажатие при бесплатном импорте', async () => {
    let imports = 0;
    let finishImport;

    store.upload = async () => ({ uploadId: 'fixture-own' });
    store.createFromFile = () => {
      imports += 1;

      return new Promise((resolve) => {
        finishImport = resolve;
      });
    };
    await wrapper.findAll('button').find((button) => button.text() === 'Свой файл').trigger('click');

    const input = wrapper.get('input[type="file"]');

    Object.defineProperty(input.element, 'files', {
      configurable: true,
      value: [new File(['fixture'], 'model.glb')]
    });
    await input.trigger('change');
    await new Promise(setImmediate);
    assert.match(wrapper.text(), /model.glb · готов к добавлению/);

    const add = wrapper.findAll('button').find((button) => button.text() === 'Добавить бесплатно');

    await wrapper.findAll('button').find((button) => button.text() === 'Убрать файл').trigger('click');
    assert.equal(add.element.disabled, true);
    await input.trigger('change');
    await new Promise(setImmediate);
    await add.trigger('click');
    await add.trigger('click');
    assert.equal(imports, 1);
    assert.equal(wrapper.get('input[type="file"]').element.disabled, true);
    await wrapper.setProps({ active: false });
    finishImport({ model: modelDto(), version: { id: 'fixture-file' } });
    await new Promise(setImmediate);
    assert.equal(wrapper.emitted('created'), undefined);
  });

  await t.test('WC-05 виды swap/clear и общие pointer/keyboard линии', async (scenario) => {
    const Views = await compileVue(webFile('src/views/studio3d/ViewSlots.vue'));
    const front = new File(['fixture'], 'front.png', { type: 'image/png' });
    const left = new File(['fixture'], 'left.png', { type: 'image/png' });
    let slots;
    
    slots = mount(Views, { props: { modelValue: {
      front,
      left,
      back: null,
      right: null
    },
      'onUpdate:modelValue': (value) => slots.setProps({ modelValue: value }) } });
    scenario.after(() => slots.unmount());
    
    const lines = slots.findAll('[role="slider"]');
    
    assert.equal(lines.length, 12);
    await lines[0].trigger('keydown', { key: 'ArrowDown', shiftKey: true });

    const sharedHeight = slots.findAll('[aria-label="Макушка"]')
      .every((line) => line.attributes('aria-valuenow') === '20');

    assert.equal(sharedHeight, true);
    
    const swap = slots.findAll('button').find((button) => button.text() === 'Поменять с соседним');
    
    await swap.trigger('click');
    await nextTick();
    assert.equal(slots.emitted('update:modelValue')[0][0].front.name, 'left.png');
    
    const clear = slots.findAll('button').find((button) => button.text() === 'Очистить');
    
    await clear.trigger('click');
    await nextTick();
    assert.equal(slots.text().includes('Нужен вид спереди'), true);
  });
});
