import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

// Vue сохраняет document при первом импорте: все сценарии Teleport используют одно окно.
// Каждый сценарий снимает свой компонент, а окно закрывается после всего файла.
const browser = await installUiBrowser({ after }, 'https://grigdesk.test/#/pipeline');

test('BOARD-TIMERS-03: топбар раскрывает таймеры и связывает задачи с доской', async (t) => {
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
  assert.equal(trigger.get('.board-timers-topbar-count').text(), '1');
  assert.equal(trigger.get('.topbar-status-label').text(), 'Таймеры задач');
  assert.equal(trigger.find('.board-timers-topbar-label').exists(), false);
  assert.equal(trigger.find('.board-timers-topbar-live').exists(), false);

  await trigger.trigger('mouseenter');
  await nextTick();

  const popover = browser.document.querySelector('.board-timers-popover');
  assert.ok(popover);

  const header = popover.closest('.ui-topbar-panel').querySelector('.ui-topbar-panel__head');

  assert.equal(header.querySelector('.ui-topbar-panel__title')?.textContent.trim(), 'Таймеры задач');
  assert.match(
    header.querySelector('.board-timers-popover-summary')?.textContent.replace(/\s+/gu, ' ').trim(),
    /^Активно 1\s*·\s*сегодня 3ч 45мин$/u,
  );
  assert.equal(Boolean(header?.querySelector('.board-timers-popover-count')), false);
  assert.equal(
    header.querySelector('.board-timers-popover-today')?.textContent.trim(),
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

test('BOARD-TIMERS-05: поповер показывает подпись устаревания', async (t) => {
  const [{ nextTick }, { mount }, BoardTimerPopover] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/features/board/BoardTimerPopover.vue')),
  ]);
  const wrapper = mount(BoardTimerPopover, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      tasks: [{
        id: 11,
        title: 'Таймер',
        timerRunning: true,
        timerElapsed: 11
      }],
      staleNotice: 'Данные не обновлялись 3 мин — учёт может быть неточным.',
    },
  });

  t.after(() => wrapper.unmount());

  await wrapper.get('[data-context="board-timers-topbar"]').trigger('mouseenter');
  await nextTick();

  const notice = browser.document.querySelector('.board-timers-popover-stale');

  assert.ok(notice);
  assert.match(notice.textContent ?? '', /не обновлялись 3 мин/u);
});

test('BOARD-TIMERS-06: общий отказ виден без строк, восстановление скрывает панель', async (t) => {
  const [{ nextTick }, { mount }, BoardTimerPopover] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/features/board/BoardTimerPopover.vue')),
  ]);
  const wrapper = mount(BoardTimerPopover, {
    attachTo: browser.document.querySelector('#mount'),
    props: { tasks: [], staleNotice: 'Данные не обновлялись 5 мин — учёт может быть неточным.' },
  });

  t.after(() => wrapper.unmount());

  assert.equal(wrapper.find('[data-context="board-timers-topbar"]').exists(), true);

  const trigger = wrapper.get('[data-context="board-timers-topbar"]');

  assert.equal(trigger.get('.board-timers-topbar-count').text(), '—');
  assert.match(trigger.attributes('aria-label'), /не обновлялись 5 мин/u);
  await trigger.trigger('mouseenter');
  await nextTick();
  assert.match(browser.document.querySelector('.board-timers-popover-stale')?.textContent ?? '',
    /не обновлялись 5 мин/u);
  assert.equal(browser.document.querySelectorAll('[data-context="topbar-timer-task"]').length, 0);
  assert.equal(browser.document.querySelectorAll('.board-timers-popover-summary').length, 0);
  await wrapper.setProps({ staleNotice: '' });
  await nextTick();
  assert.equal(wrapper.find('[data-context="board-timers-topbar"]').exists(), false);
});
