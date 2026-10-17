process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test from 'node:test';
import { compileVue, webFile, singletonUrl } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';
import { LIBRARY_ID, INTENT_ID, UNIT, tasksDto } from './helpers/studio3d-fixtures.js';

test('WT-01/02 очередь, внешний импорт, scan и неизвестный child', async (t) => {
  await installUiBrowser(t);
  
  const { reactive } = await import(singletonUrl('vue'));
  const { mount } = await import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.cjs.js');
  const calls = [];
  const row = {
    intentId: INTENT_ID,
    childId: 'c-2',
    modelId: 'hero',
    modelName: 'Герой',
    versionId: null,
    label: 'Проверка',
    provider: 'tripo',
    status: 'unknown',
    progress: 20,
    etaSeconds: 60,
    estimated: 0,
    actual: null,
    paymentState: 'unknown',
    unit: UNIT,
    waitReason: null,
    retryAvailable: false,
    retryReason: 'Исход неизвестен',
    error: null,
    updatedAt: '2026-10-11T10:00:00Z'
  };
  const store = reactive({
    libraryId: LIBRARY_ID,
    busy: 0,
    tasks: tasksDto({
    active: [row, {
      ...row,
      childId: 'c-1',
      status: 'running',
      label: 'Движение'
    }],
    recent: [{
      ...row,
      status: 'failed',
      childId: 'c-3',
      error: { kind: 'failed', message: 'Ошибка поставщика' },
      paymentState: 'refunded'
    }],
    external: [{
      provider: 'tripo',
      taskId: 'outside',
      type: 'model',
      label: 'Внешняя модель',
      credits: 30,
      createdAt: '2026-10-11T09:00:00Z',
      modelId: null
    }],
    week: { partial: true, groups: [{
      provider: 'tripo',
      unit: UNIT,
      sectionActual: 210,
      externalActual: 30,
      estimated: 40,
      reserved: 50,
      refunded: 10,
      unknownCount: 1,
      unknownEstimated: 30
    }] },
  }),
    loadTasks: async (refresh) => calls.push(['refresh', refresh]),
    scan: async () => ({
      libraryId: LIBRARY_ID,
      found: 18,
      imported: 18,
      skipped: 0,
      partial: false,
      reasons: []
    }),
    importExternal: async (provider, task) => { calls.push(['import', provider, task]);
      
      return { libraryId: LIBRARY_ID, modelId: 'imported' }; },
    loadJob: async () => ({
      libraryId: LIBRARY_ID,
      intentId: INTENT_ID,
      deleted: false,
      modelId: 'hero',
      updatedAt: row.updatedAt,
      children: [{
        ...row,
        operation: 'rig-check',
        candidates: [
        {
          taskId: 'candidate',
          type: 'rig-check',
          createdAt: null,
          credits: 0
        }],
        taskId: null
      }]
    }),
    reconcileChild: async (...args) => calls.push(['reconcile', ...args]),
    closeUnknownChild: async (...args) => calls.push(['close', ...args])
  });
  
  globalThis.__studioTasks = {
    store,
    calls,
    questions: []
  };
  
  const Panel = await compileVue(webFile('src/views/studio3d/TasksPanel.vue'), { stubs: {
    '../../stores/studio3d.ts': 'export const useStudio3dStore=()=>globalThis.__studioTasks.store;',
    '../../ui.ts': `export * from './src/ui.ts'; export const confirmDialog=async(text)=>{
      globalThis.__studioTasks.questions.push(text);return true;};`,
  } });
  const wrapper = mount(Panel);
  
  t.after(() => wrapper.unmount());
  assert.equal(wrapper.get('[data-group="attention"]').findAll('.studio-task-row').length, 2);
  assert.equal(wrapper.get('[data-group="active"]').findAll('.studio-task-row').length, 1);
  assert.equal(wrapper.get('[data-group="attention"]').find('[role="progressbar"]').exists(), false);
  assert.match(wrapper.text(), /≈ 1 мин/);
  assert.match(wrapper.text(), /Возврат подтверждён/);
  assert.match(wrapper.text(), /Ошибка поставщика/);
  assert.match(wrapper.text(), /в разделе 210.*вне раздела 30/);
  assert.match(wrapper.text(), /Списание неизвестно/);
  await wrapper.findAll('button').find((item) => item.text() === 'Обновить').trigger('click');
  assert.deepEqual(calls[0], ['refresh', true]);
  await wrapper.findAll('button')
    .find((item) => item.text() === 'Найти прошлые заказы на диске').trigger('click');
  await new Promise(setImmediate);
  assert.match(wrapper.text(), /Найдено 18, добавлено 18/);
  await wrapper.findAll('button').find((item) => item.text() === 'Забрать в библиотеку').trigger('click');
  await new Promise(setImmediate);
  assert.deepEqual(wrapper.emitted('open')[0], ['imported']);
  await wrapper.findAll('button').find((item) => item.text() === 'Разобрать заказ').trigger('click');
  await new Promise(setImmediate);
  await wrapper.get('[data-context="studio-candidate"]').setValue('candidate');
  await wrapper.findAll('button').find((item) => item.text() === 'Связать заказ').trigger('click');
  await new Promise(setImmediate);
  assert.deepEqual(calls.find((call) => call[0] === 'reconcile'), ['reconcile', INTENT_ID, 'c-2',
    'candidate']);

  await t.test('WT-03 close не обещает возврат и адресует child без версии', async () => {
    await wrapper.findAll('button').find((item) => item.text() === 'Разобрать заказ').trigger('click');
    await new Promise(setImmediate);
    await wrapper.findAll('button').find((item) => item.text() === 'Оставить неразобранным').trigger('click');
    await new Promise(setImmediate);
    assert.deepEqual(calls.find((call) => call[0] === 'close'), ['close', INTENT_ID, 'c-2']);
    assert.match(globalThis.__studioTasks.questions.at(-1), /не отменяет заказ.*не подтверждает возврат/);
  });

  await t.test('WT-04 поздний job после смены библиотеки не показывает прежних кандидатов', async () => {
    const load = store.loadJob;
    let finish;
    
    store.loadJob = () => new Promise((resolve) => {
      finish = resolve;
    });
    await wrapper.findAll('button').find((item) => item.text() === 'Разобрать заказ').trigger('click');
    store.libraryId = '00000000-0000-4000-8000-000000000020';
    await wrapper.vm.$nextTick();
    finish(await load());
    await new Promise(setImmediate);
    assert.equal(wrapper.find('[data-context="studio-candidate"]').exists(), false);
    assert.equal(calls.filter((call) => call[0] === 'reconcile').length, 1);
  });
});
