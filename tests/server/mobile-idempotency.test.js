import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { OperationJournal } from '../../server/src/lib/mobile/idempotency.ts';
import { temporary } from '../relay/helpers.js';

test('MB-25…MB-29: durable intent, повторы, конфликт и рестарт не повторяют эффект', async (t) => {
  const directory = await temporary(t);
  let now = 1000000;
  const journal = new OperationJournal(directory, { now: () => now });
  const input = {
    method: 'POST',
    path: '/api/mobile/v1/chats/chat1/stop',
    body: {},
    createdAt: now,
  };
  let calls = 0;
  const effect = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));

    return {
      status: 200,
      body: { ok: true },
    };
  };
  const device = 'd12345678';
  const key = 'stop-operation';
  const [first, second] = await Promise.all([
    journal.run(device, key, input, effect),
    journal.run(device, key, input, effect),
  ]);

  assert.deepEqual(first, second);
  assert.equal(calls, 1);

  const restored = new OperationJournal(directory, { now: () => now });

  assert.deepEqual(await restored.run(device, key, input, effect), first);
  assert.equal(calls, 1);
  await assert.rejects(
    () =>
      restored.run(
        device,
        key,
        {
          ...input,
          body: { different: true },
        },
        effect,
      ),
    (error) => error.code === 'idempotency_conflict',
  );
  await restored.run('d87654321', key, input, effect);
  assert.equal(calls, 2);
  now += 600001;
  assert.deepEqual(await restored.run(device, key, input, effect), first);
  await assert.rejects(
    () => restored.run(device, 'old-operation', input, effect),
    (error) => error.code === 'operation_expired',
  );
  assert.equal((await restored.get(device, key)).state, 'done');
});

test('MB-29: эффект с неизвестным исходом и заполненный журнал отказывают без повтора', async (t) => {
  const directory = await temporary(t);
  const input = {
    method: 'POST',
    path: '/api/mobile/v1/tasks/1/resume',
    body: {},
    createdAt: 1000000,
  };
  let calls = 0;
  const effect = async () => {
    calls += 1;

    throw new Error('crash after effect');
  };
  const journal = new OperationJournal(directory, {
    now: () => 1000000,
    maxRecords: 1,
  });

  await assert.rejects(() => journal.run('d12345678', 'unknown-op', input, effect));

  const restored = new OperationJournal(directory, {
    now: () => 1000000,
    maxRecords: 1,
  });

  await assert.rejects(
    () => restored.run('d12345678', 'unknown-op', input, effect),
    (error) => error.code === 'operation_unknown',
  );
  await assert.rejects(
    () => restored.run('d12345678', 'another-op', input, effect),
    (error) => error.code === 'operation_journal_full',
  );
  assert.equal(calls, 1);
});

test('MB-29: все pending резервируют место будущего результата до допуска новой команды', async (t) => {
  const directory = await temporary(t);
  const journal = new OperationJournal(directory, { maxBytes: 600000 });
  const input = {
    method: 'POST',
    path: '/api/mobile/v1/tasks/1/stop',
    body: {},
    createdAt: Date.now(),
  };
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const effect = async () => {
    await held;

    return {
      status: 200,
      body: { ok: true },
    };
  };
  const first = journal.run('d12345678', 'pending-one', input, effect);
  const second = journal.run('d12345678', 'pending-two', input, effect);

  try {
    while (
      (await fs.readdir(path.join(directory, 'operations/d12345678')).catch(() => [])).length < 2
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await assert.rejects(
      () =>
        journal.run('d12345678', 'pending-three', input, async () => ({
          status: 200,
          body: { ok: true },
        })),
      (error) => error.code === 'operation_journal_full',
    );
  } finally {
    release();
    await Promise.all([first, second]);
  }
});

test('MB-30: после падения восстанавливается только доказанный owned turn, без нового эффекта', async (t) => {
  const directory = await temporary(t);
  const proof = {
    kind: 'chat',
    chatId: 'synthetic-chat',
    clientId: 'synthetic-client',
    turnId: 'm_' + 'a'.repeat(64),
    contentHash: 'b'.repeat(64),
  };
  const device = 'd12345678';
  const createdAt = Date.now();
  const input = {
    method: 'POST',
    path: '/api/mobile/v1/chats/synthetic-chat/messages',
    body: {
      text: 'Синтетический ход',
      clientId: proof.clientId,
    },
    createdAt,
    proof,
  };
  const first = new OperationJournal(directory);
  let calls = 0;

  await assert.rejects(() =>
    first.run(device, 'crashed-operation', input, async () => {
      calls += 1;

      throw new Error('synthetic process crash after accepted ledger');
    }),
  );

  const answer = {
    status: 202,
    body: {
      accepted: true,
      clientId: proof.clientId,
      turnId: proof.turnId,
      state: 'done',
      duplicate: true,
    },
  };
  const restarted = new OperationJournal(directory, {
    recover: async (owner, recorded) => {
      assert.equal(owner, device);
      assert.deepEqual(recorded, proof);

      return answer;
    },
  });

  assert.deepEqual(await restarted.get(device, 'crashed-operation'), {
    state: 'done',
    result: answer,
  });
  assert.deepEqual(
    await restarted.run(device, 'crashed-operation', input, async () => {
      calls += 1;

      return {
        status: 500,
        body: null,
      };
    }),
    answer,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    () =>
      restarted.run(
        device,
        'crashed-operation',
        {
          ...input,
          body: {
            ...input.body,
            text: 'Изменённый текст',
          },
        },
        async () => answer,
      ),
    { code: 'idempotency_conflict' },
  );
});
