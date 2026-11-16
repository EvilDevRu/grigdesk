import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { FactoryTaskSources, factoryTicketHash } from '../../server/src/lib/factoryTaskSources.ts';

const source = `grigdesk-b24@${'a'.repeat(64)}`;
const record = {
  taskId: '42',
  source,
  dispatchId: 'd5f1c2b3-1234-4567-890a-123456789abc',
  ticketHash: factoryTicketHash({ task: '42', title: 'Тикет' }),
};

test('источник переживает переоткрытие и подтверждается только exact попыткой', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-sources-'));

  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const target = path.join(directory, 'sources.json');
  const store = new FactoryTaskSources(target);

  assert.deepEqual((await store.read()).entries, {});
  await store.put(record);

  const saved = (await new FactoryTaskSources(target).read()).entries['42'];
  const proof = {
    attempt: `a_${'1'.repeat(32)}`,
    queueDispatchId: record.dispatchId,
    ticketHash: record.ticketHash,
  };

  assert.equal(FactoryTaskSources.verified(saved, proof), source);
  assert.equal(FactoryTaskSources.verified(saved, { ...proof, queueDispatchId: 'other' }), undefined);
  assert.equal(FactoryTaskSources.verified(saved, { ...proof, ticketHash: 'f'.repeat(64) }), undefined);
  await store.put({ ...record, attempt: proof.attempt });
  assert.equal(FactoryTaskSources.verified((await store.read()).entries['42'],
    { ...proof, attempt: `a_${'2'.repeat(32)}` }), undefined);
  assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
});

test('повреждённый индекс не заменяется новым документом', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-sources-corrupt-'));

  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const target = path.join(directory, 'sources.json');

  await fs.writeFile(target, '{bad json');
  await assert.rejects(new FactoryTaskSources(target).put(record));
  assert.equal(await fs.readFile(target, 'utf8'), '{bad json');
});

test('API sources=1 публикует доказанный source, обычный GET сохраняет строгий legacy DTO', async (t) => {
  const { createRequire } = await import('node:module');
  const { default: factoryModule } = await import('../../server/src/modules/factory/index.ts');
  const require = createRequire(new URL('../../server/package.json', import.meta.url));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-sources-api-'));
  const target = path.join(root, 'sources.json');
  const index = new FactoryTaskSources(target);

  await index.put(record);

  const app = require('fastify')();
  let proof = {
    attempt: `a_${'1'.repeat(32)}`,
    queueDispatchId: record.dispatchId,
    ticketHash: record.ticketHash,
  };

  await app.register(factoryModule, {
    config: {
      factoryTaskSourcesPath: target,
      ticketsDir: root,
      stateDir: root,
      factoryBin: path.join(root, 'factory'),
      factoryConfigRoot: root,
      profilesDir: root,
    },
    prefs: { read: () => ({}) },
    analyzer: {},
    tracker: { accountIdentity: () => {
      throw new Error('GET не читает текущий портал');
    } },
    factoryState: {
      listTasks: async () => [{ task: '42', daemonAlive: true }],
      readTrustedTicketProof: async () => proof,
    },
  });
  t.after(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const legacy = (await app.inject('/api/tasks')).json();
  const extended = (await app.inject('/api/tasks?sources=1')).json();

  assert.equal(legacy.tasks[0].source, undefined);
  assert.equal(extended.tasks[0].source, source);
  assert.equal(extended.sourcesVersion, 1);
  proof = { ...proof, queueDispatchId: 'other' };
  assert.equal((await app.inject('/api/tasks?sources=1')).json().tasks[0].source, undefined);
});


test('отпечаток тикета сохраняется после сериализации движка с другим порядком полей', () => {
  assert.equal(factoryTicketHash({
    task: '42',
    title: 'Тикет',
    acceptanceCriteria: ['a', 'b'],
  }),
    factoryTicketHash({
      acceptanceCriteria: ['a', 'b'],
      title: 'Тикет',
      task: '42',
    }));
  assert.notEqual(factoryTicketHash({ acceptanceCriteria: ['a', 'b'] }),
    factoryTicketHash({ acceptanceCriteria: ['b', 'a'] }));
});

test('OWN-REMOVED-INDEX: mixed индекс хранит историю, но подтверждает только внешний source', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-mixed-'));

  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const target = path.join(directory, 'sources.json');
  const legacy = {
    ...record,
    taskId: '100000000001',
    source: 'grigdesk',
  };
  const document = { schemaVersion: 1, entries: { '42': record, [legacy.taskId]: legacy } };
  const bytes = JSON.stringify(document);

  await fs.writeFile(target, bytes);

  const store = new FactoryTaskSources(target);
  const read = await store.read();
  const proof = {
    attempt: `a_${'1'.repeat(32)}`,
    queueDispatchId: record.dispatchId,
    ticketHash: record.ticketHash,
  };

  assert.equal(FactoryTaskSources.verified(read.entries['42'], proof), source);
  assert.equal(await fs.readFile(target, 'utf8'), bytes, 'Чтение не переписывает историю');
  await store.put({ ...record, taskId: '43' });

  const saved = await new FactoryTaskSources(target).read();

  assert.deepEqual(saved.entries[legacy.taskId], legacy);
  assert.equal(FactoryTaskSources.verified(saved.entries['43'], proof), source);
  assert.equal(FactoryTaskSources.verified(saved.entries[legacy.taskId], proof), undefined);
});
