import assert from 'node:assert/strict';
import test from 'node:test';
import { coordinatorFixture, snapshot, instance } from './helpers/tool-window-coordinator.js';
import { tick } from './helpers/tool-window-harness.js';

test(
  'TW-S01: detach/return соблюдают export → unmount → mount; отказ возвращает тот же снимок',
  async (t) => {
  const f = await coordinatorFixture(t);
  const opening = f.coordinator.detach('code');

  await tick();
  assert.deepEqual(f.events.slice(0, 2), ['export:code', 'unmount:code']);
  assert.equal(f.mounted.has('code'), false);
  await f.ready();
  await opening;

  const init = f.channels.main.posted.find((item) => item.type === 'init');

  assert.deepEqual(init.state, snapshot);
  await f.receive('return', { seq: 1, state: snapshot });
  assert.deepEqual(f.events.at(-1), ['mount:code', snapshot]);
  assert.equal(f.dock.isOpen, true);
  assert.equal(f.channels.main.posted.at(-1).type, 'return-ack');
  await f.receive('return', { seq: 1, state: snapshot });
  assert.equal(f.events.filter((event) => Array.isArray(event) && event[0] === 'mount:code').length, 1);

  await t.test('подтверждённый отказ native восстанавливает исходную панель', async (t) => {
    const refused = await coordinatorFixture(t, {
      native: { open: async () => ({ opened: false }) },
    });

    await refused.coordinator.detach('code');
    assert.deepEqual(refused.events, ['export:code', 'unmount:code', ['mount:code', snapshot]]);
    assert.equal(refused.mounted.has('code'), true);
  });
});

test(
  'TW-S02: обычный close не показывает док; следующий open локален, bootstrap не открывает окна',
  async (t) => {
  const f = await coordinatorFixture(t);

  assert.equal(f.nativeCalls.filter(([method]) => method === 'open').length, 0);

  const opening = f.coordinator.detach('code');

  await tick();
  await f.ready();
  await opening;
  await f.coordinator.closed({ id: 'code', instance });
  assert.equal(f.dock.isOpen, false);
  assert.equal(await f.coordinator.activateIfDetached('code'), false);
  assert.equal(f.context.capture({ path: '/chats' }).promptContext.details?.toolWindow, undefined);
  assert.equal(f.nativeCalls.filter(([method]) => method === 'open').length, 1);
});
