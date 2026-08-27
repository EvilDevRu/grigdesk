import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

test('клик по конвейерам раскрывает агрегированную сводку и не уводит со страницы', async (t) => {
  const browser = await installUiBrowser(t, 'https://cockpit.test/#/chats');
  const [{ nextTick }, { mount }, PipelineTopbarPopover] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/features/pipeline/PipelineTopbarPopover.vue')),
  ]);
  const items = [
    {
      task: '33',
      title: 'Оборвавшийся прогон',
      kind: 'error',
      stateLabel: 'Встал',
      detail: 'Демон оборвался',
      stage: 'Ревью',
      progress: { done: 5, total: 7 },
    },
    {
      task: '44',
      title: 'Молчащий агент',
      kind: 'error',
      stateLabel: 'Молчит',
      detail: 'Нет событий 20 минут',
      stage: 'Браузер',
      progress: { done: 6, total: 7 },
    },
    {
      task: '22',
      title: 'Ждёт человека',
      kind: 'waiting',
      stateLabel: 'Ждёт решения',
      detail: 'Принять план',
      stage: 'Ворота плана',
      progress: { done: 2, total: 7 },
    },
    {
      task: '55',
      title: 'Ещё одно решение',
      kind: 'waiting',
      stateLabel: 'Ждёт решения',
      detail: 'Принять работу',
      stage: 'Приёмка',
      progress: { done: 3, total: 7 },
    },
    {
      task: '11',
      title: 'Обычный живой прогон',
      kind: 'running',
      stateLabel: 'В работе',
      detail: '',
      stage: 'Проверка',
      progress: { done: 4, total: 7 },
    },
  ];
  const wrapper = mount(PipelineTopbarPopover, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      items,
      total: 5,
      runningCount: 1,
      stoppedCount: 4,
      hasErrors: true,
      error: 'сервер временно недоступен',
      icon: 'M6 3v12',
    },
  });
  t.after(() => wrapper.unmount());

  const trigger = wrapper.get('[data-context="pipeline-topbar"]');
  assert.equal(trigger.element.tagName, 'BUTTON');
  assert.equal(trigger.attributes('aria-expanded'), 'false');
  assert.match(trigger.attributes('aria-label'), /всего 5, едут 1, стоят 4/u);
  assert.equal(browser.location.hash, '#/chats');

  await trigger.trigger('click');
  await nextTick();

  const popover = browser.document.querySelector('.pipeline-topbar-popover');
  assert.ok(popover);
  assert.equal(popover.closest('.ui-popover')?.getAttribute('role'), 'dialog');
  assert.equal(browser.location.hash, '#/chats');
  assert.equal(wrapper.emitted('openPipeline'), undefined);

  const rows = [...popover.querySelectorAll('[data-task-id]')];
  assert.deepEqual(rows.map((row) => row.getAttribute('data-task-id')), ['33', '44', '22']);
  assert.match(popover.textContent, /В работе\s*1/u);
  assert.match(popover.textContent, /Ждут решения\s*2/u);
  assert.match(popover.textContent, /Проблемы\s*2/u);
  assert.match(popover.textContent, /Этапы выполнены\s*20 \/ 35/u);
  assert.match(rows[0].textContent, /Демон оборвался/u);
  assert.match(rows[1].textContent, /Нет событий 20 минут/u);
  assert.match(rows[2].textContent, /Принять план/u);
  assert.doesNotMatch(popover.textContent, /Обычный живой прогон/u);
  assert.doesNotMatch(popover.textContent, /Ещё одно решение/u);
  assert.match(popover.textContent, /И ещё 1/u);
  assert.match(popover.textContent, /Состояние может быть устаревшим/u);

  const footer = popover.querySelector('.pipeline-topbar-popover-footer button');
  assert.ok(footer);

  footer.dispatchEvent(new browser.MouseEvent('click', { bubbles: true }));
  await nextTick();

  assert.equal(wrapper.emitted('openPipeline')?.length, 1);
  assert.equal(Boolean(browser.document.querySelector('.pipeline-topbar-popover')), false);
  assert.equal(browser.location.hash, '#/chats');

  await wrapper.setProps({
    items: [{
      task: '11',
      title: 'Обычный живой прогон',
      kind: 'running',
      stateLabel: 'В работе',
      detail: '',
      stage: 'Проверка',
      progress: { done: 4, total: 7 },
    }],
    total: 1,
    runningCount: 1,
    stoppedCount: 0,
    hasErrors: false,
    error: '',
  });
  await wrapper.get('[data-context="pipeline-topbar"]').trigger('click');
  await nextTick();

  const healthyPopover = browser.document.querySelector('.pipeline-topbar-popover');
  assert.ok(healthyPopover);
  assert.match(healthyPopover.textContent, /Все конвейеры работают/u);
  assert.match(healthyPopover.textContent, /Этапы выполнены\s*4 \/ 7/u);
  assert.equal(healthyPopover.querySelectorAll('[data-task-id]').length, 0);
});
