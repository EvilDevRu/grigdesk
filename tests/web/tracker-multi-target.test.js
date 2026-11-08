import assert from 'node:assert/strict';
import test from 'node:test';

import { taskReferenceKey } from '../../shared/tasks/taskReference.ts';
import { saveMulti } from '../server/helpers/trackerMulti.js';
import { trackerCalls } from '../server/helpers/trackerFixture.js';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

/**
 * DOM устанавливается до первого импорта Pinia/Vue runtime в этом spec-файле.
 * Иначе runtime-dom запоминает null document и ложный RED возникает при рендере таймеров.
 */
async function webMultiFixture(t) {
  await installUiBrowser(t, 'http://grigdesk.test/#/board');

  const helper = await import('./helpers/trackerMulti.js');

  return helper.webMultiFixture(t);
}

test('MD-TIMER-REF: таймеры с одним номером открывают полную пару источника', async (t) => {
  const browser = await installUiBrowser(t, 'http://grigdesk.test/#/board');
  const [{ mount }, { nextTick }, component] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/vue/index.mjs'),
    compileVue(webFile('src/features/board/BoardTimerPopover.vue')),
  ]);
  const sources = [`fixture-a@${'a'.repeat(64)}`, `fixture-b@${'b'.repeat(64)}`];
  const tasks = sources.map((source, index) => ({
    id: 42,
    source,
    title: index ? 'Таймер B' : 'Таймер A',
    timerRunning: index === 0,
    timerElapsed: index + 1,
  }));
  const wrapper = mount(component, {
    attachTo: browser.document.querySelector('#mount'),
    props: { tasks, workedTodayHours: 0 },
  });

  t.after(() => wrapper.unmount());
  await wrapper.get('[data-context="board-timers-topbar"]').trigger('mouseenter');
  await nextTick();

  const buttons = browser.document.querySelectorAll('[data-context="topbar-timer-task"]');
  const toggles = browser.document.querySelectorAll('[data-context="topbar-timer-toggle"]');

  assert.equal(buttons.length, 2);
  await wrapper.setProps({ busyTaskId: taskReferenceKey({ id: 42, source: sources[0] }) });
  await nextTick();
  assert.equal(toggles[0].getAttribute('aria-busy'), 'true');
  assert.notEqual(toggles[1].getAttribute('aria-busy'), 'true');
  assert.equal(toggles[1].disabled, false, 'Занятый A не закрывает таймер B с тем же номером');
  await wrapper.setProps({ busyTaskId: null });
  toggles[1].dispatchEvent(new browser.MouseEvent('click', { bubbles: true }));
  await nextTick();
  assert.equal(wrapper.emitted('toggleTimer')[0][0].source, sources[1]);
  buttons[1].dispatchEvent(new browser.MouseEvent('click', { bubbles: true }));
  await nextTick();
  assert.deepEqual(wrapper.emitted('openTask')[0], [{ id: 42, source: sources[1] }]);
});

test('MD-CARD: A42 и B42 открываются и кешируются независимо от default B', async (t) => {
  const fixture = await webMultiFixture(t);

  await fixture.board.load(true);
  await fixture.trackers.load(true);

  for (const [source, title] of [[fixture.sourceA, 'fixture-a'], [fixture.sourceB, 'fixture-b']]) {
    const first = await fixture.tasks.load('42', false, undefined, source);
    const cached = await fixture.tasks.load('42', false, undefined, source);

    assert.equal(first.title, title);
    assert.equal(cached.title, title);
    assert.equal(fixture.tasks.details[taskReferenceKey({ id: '42', source })].data.title, title);
  }

  assert.equal(fixture.calls.filter((call) => call.url.endsWith('/task/42')).length, 2);
});

const MUTATIONS = [
  ['update', [{ title: 'Изменено' }], 'PUT', '/task/42'],
  ['comment', ['Комментарий'], 'POST', '/task/42/comment'],
  ['timer', ['start'], 'POST', '/task/42/timer/start'],
  ['complete', [], 'POST', '/task/42/complete'],
  ['renew', [], 'POST', '/task/42/renew'],
  ['addChecklistItem', [{ title: 'Пункт' }], 'POST', '/task/42/checklist'],
  ['updateChecklistItem', ['11', { complete: true }], 'PUT', '/task/42/checklist/11'],
  ['deleteChecklistItem', ['11'], 'DELETE', '/task/42/checklist/11'],
  ['updateTaskTags', [['Тег']], 'PUT', '/task/42/tags'],
  ['approveTask', [], 'POST', '/task/42/approve'],
  ['disapproveTask', [], 'POST', '/task/42/disapprove'],
  ['deleteTask', [], 'DELETE', '/task/42'],
];

for (const [method, args, verb, suffix] of MUTATIONS) {
  test(`MD-CARD-ALL: ${method} и readback используют цель A`, async (t) => {
    const fixture = await webMultiFixture(t);

    await fixture.board.load(true);
    await fixture.trackers.load(true);
    fixture.calls.length = 0;
    await fixture.tasks[method]('42', ...args, fixture.sourceA);

    const effects = fixture.calls.filter((call) => call.method !== 'GET');

    assert.equal(effects.length, 1);
    assert.equal(effects[0].method, verb);
    assert.equal(effects[0].url, `/api/tracker/fixture-a${suffix}`);
    assert.ok(fixture.calls.filter((call) => call.method === 'GET' && call.url.includes('/task/42'))
      .every((call) => call.url.startsWith('/api/tracker/fixture-a/')));
  });
}

test('MD-DIRECT-LINK: source вне dashboard подтверждается context, чужой hash отвергается', async (t) => {
  const fixture = await webMultiFixture(t);
  const loaded = await fixture.tasks.load('42', false, undefined, fixture.sourceA);

  assert.equal(loaded.title, 'fixture-a');
  assert.ok(fixture.calls.some((call) => call.url === '/api/tracker/fixture-a/context'));

  const before = fixture.calls.filter((call) => call.url.endsWith('/task/42')).length;
  const foreign = `fixture-a@${'f'.repeat(64)}`;

  await assert.rejects(fixture.tasks.load('42', true, undefined, foreign));
  assert.equal(fixture.calls.filter((call) => call.url.endsWith('/task/42')).length, before);
});

test('MD-CONFIRM: захваченный A не меняет цель при чужой смене, свой stale запрещён', async (t) => {
  const fixture = await webMultiFixture(t);

  await fixture.board.load(true);
  await fixture.trackers.load(true);
  await fixture.tasks.load('42', false, undefined, fixture.sourceA);
  assert.equal((await saveMulti(fixture, ['fixture-a', 'fixture-b'], 'fixture-b', {
    'fixture-b': { endpoint: 'https://changed-b.fixture' },
  })).statusCode, 200);
  await fixture.tasks.comment('42', 'Подтверждённый A', fixture.sourceA);
  assert.equal((await saveMulti(fixture, ['fixture-a', 'fixture-b'], 'fixture-b', {
    'fixture-a': { endpoint: 'https://changed-a.fixture' },
  })).statusCode, 200);

  const effects = fixture.calls.filter((call) => call.method === 'POST').length;

  await assert.rejects(fixture.tasks.comment('42', 'Старое подтверждение', fixture.sourceA));
  assert.ok(fixture.calls.filter((call) => call.method === 'POST').length <= effects + 1,
    'Допустим один отвергнутый HTTP, автоматического повтора нет');
  assert.equal((await trackerCalls(fixture.config, 'fixture-a'))
    .filter((call) => call.method === 'addComment').length, 1);
});
