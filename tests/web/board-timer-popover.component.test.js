import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

test('BOARD-TIMERS-03: топбар раскрывает таймеры и связывает задачи с доской', async (t) => {
  const browser = await installUiBrowser(t, 'https://cockpit.test/#/pipeline');
  const [{ nextTick }, { mount }, BoardTimerPopover] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/features/board/BoardTimerPopover.vue')),
  ]);
  const tasks = [
    {
      id: 11,
      title: 'Первый активный таймер',
      group: 'Проект A',
      timerRunning: true,
      timerElapsed: 11,
    },
    {
      id: 22,
      title: 'Второй приостановленный таймер',
      group: '',
      timerRunning: false,
      timerElapsed: 22,
    },
  ];
  const wrapper = mount(BoardTimerPopover, {
    attachTo: browser.document.querySelector('#mount'),
    props: { tasks, workedTodayHours: 3.75 },
  });
  t.after(() => wrapper.unmount());

  const trigger = wrapper.get('[data-context="board-timers-topbar"]');
  assert.equal(trigger.attributes('aria-expanded'), 'false');
  assert.match(trigger.attributes('aria-label'), /активных 1/u);
  assert.match(trigger.attributes('aria-label'), /сегодня отработано 3ч 45мин/u);
  assert.equal(trigger.text(), '1');
  assert.equal(trigger.find('.board-timers-topbar-label').exists(), false);
  assert.equal(trigger.find('.board-timers-topbar-live').exists(), false);

  await trigger.trigger('mouseenter');
  await nextTick();

  const popover = browser.document.querySelector('.board-timers-popover');
  assert.ok(popover);
  const header = popover.querySelector('.board-timers-popover-head');
  assert.match(
    header?.textContent.replace(/\s+/gu, ' ').trim(),
    /^Таймеры задач Активно 1\s*·\s*сегодня 3ч 45мин$/u,
  );
  assert.equal(header?.querySelector('.board-timers-popover-count'), null);
  assert.equal(
    popover.querySelector('.board-timers-popover-today')?.textContent.trim(),
    '3ч 45мин',
  );
  const taskButtons = [...popover.querySelectorAll('[data-context="topbar-timer-task"]')];
  assert.equal(taskButtons.length, 2);
  assert.deepEqual(
    taskButtons.map((button) => button.querySelector('.board-timers-popover-title')?.textContent),
    ['Первый активный таймер', 'Второй приостановленный таймер'],
  );
  assert.deepEqual(
    taskButtons.map((button) => button.querySelector('.board-timers-popover-time')?.textContent.trim()),
    ['0:00:11', '0:00:22'],
  );

  const timerButtons = [
    ...popover.querySelectorAll('[data-context="topbar-timer-toggle"]'),
  ];
  assert.equal(timerButtons.length, 2);
  assert.match(timerButtons[0].getAttribute('aria-label'), /на паузу/u);
  assert.match(timerButtons[1].getAttribute('aria-label'), /Запустить/u);

  timerButtons[0].dispatchEvent(new browser.MouseEvent('click', { bubbles: true }));
  await nextTick();
  assert.deepEqual(wrapper.emitted('toggleTimer'), [[tasks[0]]]);
  assert.ok(browser.document.querySelector('.board-timers-popover'));

  timerButtons[1].dispatchEvent(new browser.MouseEvent('click', { bubbles: true }));
  await nextTick();
  assert.deepEqual(wrapper.emitted('toggleTimer'), [[tasks[0]], [tasks[1]]]);

  taskButtons[1].dispatchEvent(new browser.MouseEvent('click', { bubbles: true }));
  await nextTick();
  assert.deepEqual(wrapper.emitted('openTask'), [[22]]);
  assert.equal(Boolean(browser.document.querySelector('.board-timers-popover')), false);

  await trigger.trigger('click');
  await nextTick();
  const footer = browser.document.querySelector('.board-timers-popover-footer button');
  assert.ok(footer);

  footer.dispatchEvent(new browser.MouseEvent('click', { bubbles: true }));
  await nextTick();
  assert.equal(wrapper.emitted('openBoard')?.length, 1);
  assert.equal(Boolean(browser.document.querySelector('.board-timers-popover')), false);
});
