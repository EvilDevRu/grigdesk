import assert from 'node:assert/strict';
import test from 'node:test';
import { createSettingsSession } from '../../web/src/features/settings/session.ts';
import { createBrowserSettingsAdapter } from '../../web/src/features/settings/resources/browser.ts';

const fields = ['open', 'external', 'agents'].map((key) => ({
  key,
  address: { pageId: 'tools.browser', fieldPath: [key] },
}));

test('BR-S01: полный record, только Apply, подтверждённые значения становятся baseline', async () => {
  const calls: unknown[] = [];
  const session = createSettingsSession();
  const adapter = createBrowserSettingsAdapter({
    read: async () => ({
      open: 'external',
      external: 'app:fixture',
      agents: false
    }),
    disablePreference: async () => {},
    write: async (value) => {
      calls.push(value);

      return { preferences: value, revision: 2 };
    },
  });

  session.begin();
  session.register(adapter, fields);
  await session.load('browser');
  session.setField('browser', 'open', 'internal');
  session.setField('browser', 'agents', true);
  assert.equal(calls.length, 0);

  const result = await session.apply();

  assert.equal(result.status, 'success');
  assert.deepEqual(calls, [{
    open: 'internal',
    external: 'app:fixture',
    agents: true
  }]);
  assert.equal(session.getSnapshot().dirtyCount, 0);
  session.dispose();
});

test('BR-S02: malformed preferences ACK оставляет dirty и unknown, автоматического POST нет', async () => {
  let calls = 0;
  const session = createSettingsSession();

  session.begin();
  session.register(createBrowserSettingsAdapter({
    read: async () => ({
      open: 'external',
      external: 'system',
      agents: false
    }),
    disablePreference: async () => {},
    write: async () => {
      calls += 1;

      return { preferences: {
        open: 'internal',
        external: '/tmp/forged',
        agents: true
      }, revision: 2 };
    },
  }), fields);
  await session.load('browser');
  session.setField('browser', 'agents', true);

  const result = await session.apply();

  assert.equal(result.status, 'unknown');
  assert.equal(session.getSnapshot().dirtyCount, 1);
  assert.equal(calls, 1);
  session.dispose();
});

test('BR-S03: validation не принимает unset, path вместо app ID и чужое поле', () => {
  const adapter = createBrowserSettingsAdapter({
    read: async () => null,
    write: async () => null,
    disablePreference: async () => {},
  });
  const result = adapter.validate(new Map([
    ['open', { op: 'unset' as const }],
    ['external', { op: 'set' as const, value: '/bin/browser' }],
    ['owner', { op: 'set' as const, value: 'victim' }],
  ]), {});

  assert.deepEqual(result.map((item) => item.key), ['open', 'external', 'owner']);
});

test('BR-S04: явный off сначала native commit, потом mode ACK; loss ACK сохраняет dirty', async () => {
  const order: string[] = [];
  const session = createSettingsSession();

  session.begin();
  session.register(createBrowserSettingsAdapter({
    read: async () => ({
      open: 'external',
      external: 'system',
      agents: true
    }),
    write: async (preferences) => {
      order.push('native');

      return { preferences, revision: 2 };
    },
    disablePreference: async () => {
      order.push('mode');

      throw new Error('lost ACK');
    },
  }), fields);
  await session.load('browser');
  session.setField('browser', 'agents', false);

  const result = await session.apply();

  assert.deepEqual(order, ['native', 'mode']);
  assert.equal(result.status, 'unknown');
  assert.equal(session.getSnapshot().dirtyCount, 1);
  session.dispose();
});
