import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalChatBrowserOwner, createChatBrowserOwnerSource }
  from '../../server/src/lib/chat/browserOwners.ts';

/**
 * Fixture хранит только синтетические heads и записи трёх чатов.
 * Смена trusted project позволяет проверить отказ прежнего canonical scope.
 */
function fixture() {
  const records = new Map<string, any>([
    ['free-one', { id: 'free-one', taskId: null }],
    ['free-two', { id: 'free-two' }],
    ['task-chat', { id: 'task-chat', taskId: '44' }],
  ]);
  let project: string | null = 'sample';
  const source = createChatBrowserOwnerSource({
    history: {
      heads: async () => [...records.values()],
      readOne: async (key) => records.get(String(key)) || null,
    },
    trustedProject: async () => project,
  });

  return {
    records,
    source,
    project: (value: string | null) => {
    project = value;
  }
  };
}

test('BR-C01: два свободных чата имеют разные canonical scopes с project=null', async () => {
  const f = fixture();
  const rows = await f.source.list();

  assert.equal(await f.source.owner('free-one'), '["chat",null,"free-one",null]');
  assert.equal(await f.source.owner('free-two'), '["chat",null,"free-two",null]');
  assert.equal(new Set(rows.map((row) => row.owner)).size, 3);
  assert.equal(await f.source.owner('free'), null);
  assert.throws(() => canonicalChatBrowserOwner('sample', 'bad:key'), /browser_owner_forbidden/u);
});

test('BR-C02: trusted project refresh, deletion, archive и corruption закрывают старый owner', async () => {
  const f = fixture();
  const before = await f.source.owner('task-chat');

  assert.equal(before, '["chat","sample","task-chat",null]');
  f.project('other');
  assert.equal(await f.source.owner('task-chat'), '["chat","other","task-chat",null]');
  assert.equal((await f.source.list()).some((row) => row.owner === before), false);
  f.project(null);
  assert.equal(await f.source.owner('task-chat'), '["chat",null,"task-chat",null]');
  assert.equal((await f.source.list()).some((row) => row.owner === before), false);
  f.records.delete('task-chat');
  f.records.get('free-one').archived = true;
  f.records.delete('free-two');
  f.records.set('corrupt', { id: 'corrupt', taskId: { forged: '44' } });
  assert.equal(await f.source.owner('free-one'), null);
  assert.equal(await f.source.owner('free-two'), null);
  assert.deepEqual(await f.source.list(), []);
});
