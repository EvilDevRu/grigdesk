import assert from 'node:assert/strict';
import test from 'node:test';

import { knowledgeFixture, record } from './helpers/knowledge.js';

let brokerModule;
let brokerModuleError;
try {
  brokerModule = await import('../../server/src/lib/search/broker.ts');
} catch (error) {
  brokerModuleError = error;
}

function knowledgeBrokerFactory() {
  const factory = brokerModule?.createKnowledgeBroker || brokerModule?.default;
  assert.equal(
    typeof factory,
    'function',
    `Broker знаний ещё не реализован: ${brokerModuleError?.message || 'нет фабрики'}`,
  );
  return factory;
}

function writeRecord(overrides = {}) {
  return {
    repository: 'main',
    kind: 'fact',
    title: 'Проверяемая запись broker-а',
    body: 'Точное тело записи.',
    tags: ['knowledge'],
    ...overrides,
  };
}

test('Живое выключение инструмента не удаляет запись из реального хранилища', async (t) => {
  const createBroker = knowledgeBrokerFactory();
  const { storage } = await knowledgeFixture(t);
  const created = await storage.create(record({ body: 'Знание переживает выключение плагина.' }));
  let enabled = true;
  const broker = createBroker({
    pluginEnabled: (id) => id === 'knowledge' && enabled,
    knowledge: storage,
  });
  const before = await broker.invoke(
    { projectId: created.project },
    { action: 'read', id: created.id },
  );
  enabled = false;
  const disabled = await broker.invoke(
    { projectId: created.project },
    { action: 'read', id: created.id },
  );
  enabled = true;
  const restored = await broker.invoke(
    { projectId: created.project },
    { action: 'read', id: created.id },
  );

  assert.deepEqual({ before: before.record?.body, disabled, restored: restored.record?.body }, {
    before: 'Знание переживает выключение плагина.',
    disabled: { ok: false, error: 'plugin_disabled' },
    restored: 'Знание переживает выключение плагина.',
  });
});

test('Broker создаёт запись в server-owned проекте и обновляет только её карту', async () => {
  const createBroker = knowledgeBrokerFactory();
  const calls = [];
  const broker = createBroker({
    pluginEnabled: () => true,
    knowledge: {
      async create(input) {
        calls.push(['create', input]);
        return {
          id: '00000000-0000-4000-8000-000000000041',
          ...input,
          updatedAt: '2026-08-30T00:00:00.000Z',
          revision: 1,
        };
      },
    },
    transfer: {
      async updateMaps(input) {
        calls.push(['updateMaps', input]);
      },
    },
  });

  const result = await broker.invoke(
    { projectId: 'trusted-project', chatKey: 'chat-42', permissionMode: 'acceptEdits' },
    {
      action: 'write',
      record: writeRecord({
        project: 'forged-project',
        provenance: { actor: 'human', channel: 'cli', ref: 'forged' },
      }),
    },
  );

  assert.deepEqual({ calls, result }, {
    calls: [
      ['create', {
        ...writeRecord(),
        project: 'trusted-project',
        provenance: { actor: 'executor', channel: 'chat', ref: 'chat-42' },
      }],
      ['updateMaps', { project: 'trusted-project', sourceDocuments: ['knowledge'] }],
    ],
    result: {
      ok: true,
      record: {
        id: '00000000-0000-4000-8000-000000000041',
        ...writeRecord(),
        project: 'trusted-project',
        provenance: { actor: 'executor', channel: 'chat', ref: 'chat-42' },
        updatedAt: '2026-08-30T00:00:00.000Z',
        revision: 1,
      },
    },
  });
});

test('Broker не разрешает создание из свободного чата без project scope', async () => {
  const createBroker = knowledgeBrokerFactory();
  let createCalls = 0;
  const broker = createBroker({
    pluginEnabled: () => true,
    knowledge: { async create() { createCalls += 1; } },
    transfer: { async updateMaps() {} },
  });

  const result = await broker.invoke(
    { projectId: null, chatKey: 'free-chat', permissionMode: 'acceptEdits' },
    { action: 'write', record: writeRecord() },
  );

  assert.deepEqual({ result, createCalls }, {
    result: { ok: false, error: 'project_scope_unavailable' },
    createCalls: 0,
  });
});

test('Broker обновляет из свободного чата проект существующей записи', async () => {
  const createBroker = knowledgeBrokerFactory();
  const calls = [];
  const id = '00000000-0000-4000-8000-000000000046';
  const broker = createBroker({
    pluginEnabled: () => true,
    knowledge: {
      async read(readId) {
        calls.push(['read', readId]);
        return { id, project: 'alpha', tags: ['knowledge'], revision: 2 };
      },
      async update(updateId, input) {
        calls.push(['update', updateId, input]);
        return {
          id,
          ...input,
          updatedAt: '2026-08-30T00:00:00.000Z',
          revision: 3,
        };
      },
    },
    transfer: {
      async updateMaps(input) {
        calls.push(['updateMaps', input]);
      },
    },
  });

  const result = await broker.invoke(
    { projectId: null, chatKey: 'free-chat', permissionMode: 'acceptEdits' },
    {
      action: 'write',
      id,
      revision: 2,
      record: writeRecord({ body: 'Исправленное тело.' }),
    },
  );

  assert.deepEqual({ calls, project: result.record?.project, revision: result.record?.revision }, {
    calls: [
      ['read', id],
      ['update', id, {
        ...writeRecord({ body: 'Исправленное тело.' }),
        project: 'alpha',
        expectedRevision: 2,
        provenance: { actor: 'executor', channel: 'chat', ref: 'free-chat' },
      }],
      ['updateMaps', { project: 'alpha', sourceDocuments: ['knowledge'] }],
    ],
    project: 'alpha',
    revision: 3,
  });
});

test('Свободный чат проходит search/read/write и получает CAS-конфликт', async (t) => {
  const createBroker = knowledgeBrokerFactory();
  const { storage } = await knowledgeFixture(t);
  const created = await storage.create(record({
    project: 'alpha',
    title: 'Сквозная проверка свободного чата',
    body: 'Исходное тело знания.',
    tags: ['knowledge'],
  }));
  const maps = [];
  const broker = createBroker({
    pluginEnabled: () => true,
    knowledge: storage,
    transfer: {
      async updateMaps(input) {
        maps.push(input);
      },
    },
  });
  const scope = { projectId: null, chatKey: 'free-chat', permissionMode: 'acceptEdits' };

  const searched = await broker.invoke(scope, {
    action: 'search',
    query: 'Сквозная проверка свободного чата',
  });
  const before = await broker.invoke(scope, { action: 'read', id: created.id });
  const updated = await broker.invoke(scope, {
    action: 'write',
    id: created.id,
    revision: before.record.revision,
    record: writeRecord({
      title: created.title,
      body: 'Исправленное тело знания.',
    }),
  });
  const after = await broker.invoke(scope, { action: 'read', id: created.id });
  const stale = await broker.invoke(scope, {
    action: 'write',
    id: created.id,
    revision: before.record.revision,
    record: writeRecord({
      title: created.title,
      body: 'Устаревшая правка.',
    }),
  });

  assert.deepEqual({
    found: searched.items.some((item) => item.id === created.id),
    beforeRevision: before.record.revision,
    updatedRevision: updated.record.revision,
    afterBody: after.record.body,
    stale,
    maps,
  }, {
    found: true,
    beforeRevision: 1,
    updatedRevision: 2,
    afterBody: 'Исправленное тело знания.',
    stale: { ok: false, error: 'knowledge_conflict', currentRevision: 2 },
    maps: [{ project: 'alpha', sourceDocuments: ['knowledge'] }],
  });
});

test('Broker не превращает пустой id правки в создание записи', async () => {
  const createBroker = knowledgeBrokerFactory();
  let createCalls = 0;
  const broker = createBroker({
    pluginEnabled: () => true,
    knowledge: { async create() { createCalls += 1; } },
    transfer: { async updateMaps() {} },
  });

  const result = await broker.invoke(
    { projectId: 'alpha', chatKey: 'chat-42', permissionMode: 'acceptEdits' },
    { action: 'write', id: '', record: writeRecord() },
  );

  assert.deepEqual({ result, createCalls }, {
    result: { ok: false, error: 'invalid_arguments' },
    createCalls: 0,
  });
});

test('Broker сохраняет текущую ревизию при конфликте правки', async (t) => {
  const createBroker = knowledgeBrokerFactory();
  const { storage } = await knowledgeFixture(t);
  const created = await storage.create(record({ project: 'alpha', tags: ['knowledge'] }));
  const broker = createBroker({
    pluginEnabled: () => true,
    knowledge: storage,
    transfer: { async updateMaps() {} },
  });

  const result = await broker.invoke(
    { projectId: 'alpha', chatKey: 'chat-42', permissionMode: 'acceptEdits' },
    {
      action: 'write',
      id: created.id,
      revision: created.revision + 1,
      record: writeRecord({ body: 'Не должно сохраниться.' }),
    },
  );

  assert.deepEqual(result, {
    ok: false,
    error: 'knowledge_conflict',
    currentRevision: created.revision,
  });
});

test('Broker при переносе записи обновляет старую и новую темы', async () => {
  const createBroker = knowledgeBrokerFactory();
  const calls = [];
  const id = '00000000-0000-4000-8000-000000000045';
  const broker = createBroker({
    pluginEnabled: () => true,
    knowledge: {
      async read(readId) {
        calls.push(['read', readId]);
        return { id, project: 'alpha', tags: ['old-topic'], revision: 3 };
      },
      async update(updateId, input) {
        calls.push(['update', updateId, input]);
        return {
          id,
          project: 'alpha',
          ...input,
          tags: ['new-topic'],
          updatedAt: '2026-08-30T00:00:00.000Z',
          revision: 4,
        };
      },
    },
    transfer: {
      async updateMaps(input) {
        calls.push(['updateMaps', input]);
      },
    },
  });

  const result = await broker.invoke(
    { projectId: 'alpha', chatKey: 'chat-42', permissionMode: 'acceptEdits' },
    {
      action: 'write',
      id,
      revision: 3,
      record: writeRecord({ tags: ['new-topic'] }),
    },
  );

  assert.deepEqual({ calls, revision: result.record?.revision }, {
    calls: [
      ['read', id],
      ['update', id, {
        ...writeRecord({ tags: ['new-topic'] }),
        project: 'alpha',
        expectedRevision: 3,
        provenance: { actor: 'executor', channel: 'chat', ref: 'chat-42' },
      }],
      ['updateMaps', { project: 'alpha', sourceDocuments: ['old-topic', 'new-topic'] }],
    ],
    revision: 4,
  });
});

test('Broker в режиме plan отклоняет write как операцию записи', async () => {
  const createBroker = knowledgeBrokerFactory();
  let createCalls = 0;
  const broker = createBroker({
    pluginEnabled: () => true,
    knowledge: { async create() { createCalls += 1; } },
    transfer: { async updateMaps() {} },
  });

  const result = await broker.invoke(
    { projectId: 'alpha', chatKey: 'chat-42', permissionMode: 'plan' },
    { action: 'write', record: writeRecord() },
  );

  assert.deepEqual({
    blocked: result.ok === false,
    clearReason: /plan|read.?only|permission/iu.test(JSON.stringify(result)),
    createCalls,
  }, {
    blocked: true,
    clearReason: true,
    createCalls: 0,
  });
});

test('Broker скрывает запись чужого проекта до попытки обновления', async () => {
  const createBroker = knowledgeBrokerFactory();
  let updateCalls = 0;
  const broker = createBroker({
    pluginEnabled: () => true,
    knowledge: {
      async read() {
        return { id: '00000000-0000-4000-8000-000000000042', project: 'other-project' };
      },
      async update() {
        updateCalls += 1;
      },
    },
    transfer: { async updateMaps() {} },
  });

  const result = await broker.invoke(
    { projectId: 'trusted-project', chatKey: 'chat-42', permissionMode: 'acceptEdits' },
    {
      action: 'write',
      id: '00000000-0000-4000-8000-000000000042',
      revision: 1,
      record: writeRecord(),
    },
  );

  assert.deepEqual({ result, updateCalls }, {
    result: { ok: false, error: 'not_found' },
    updateCalls: 0,
  });
});

test('Broker сообщает частичный успех базы при отказе пересборки карты', async () => {
  const createBroker = knowledgeBrokerFactory();
  const broker = createBroker({
    pluginEnabled: () => true,
    knowledge: {
      async create(input) {
        return {
          id: '00000000-0000-4000-8000-000000000043',
          ...input,
          updatedAt: '2026-08-30T00:00:00.000Z',
          revision: 1,
        };
      },
    },
    transfer: {
      async updateMaps() {
        const error = new Error('карта недоступна');
        error.code = 'KNOWLEDGE_UNAVAILABLE';
        error.reasonCode = 'maps_refresh_failed';
        throw error;
      },
    },
  });

  const result = await broker.invoke(
    { projectId: 'alpha', chatKey: 'chat-42', permissionMode: 'acceptEdits' },
    { action: 'write', record: writeRecord() },
  );

  assert.deepEqual(result, {
    ok: false,
    error: 'maps_refresh_failed',
    committed: true,
    id: '00000000-0000-4000-8000-000000000043',
    revision: 1,
  });
});

test('Broker отвергает delete без обращения к human-only удалению', async () => {
  const createBroker = knowledgeBrokerFactory();
  let deleteCalls = 0;
  const broker = createBroker({
    pluginEnabled: () => true,
    knowledge: { async delete() { deleteCalls += 1; } },
  });

  const result = await broker.invoke(
    { projectId: 'alpha', chatKey: 'chat-42', permissionMode: 'acceptEdits' },
    { action: 'delete', id: '00000000-0000-4000-8000-000000000043', revision: 1 },
  );

  assert.deepEqual({ result, deleteCalls }, {
    result: { ok: false, error: 'invalid_arguments' },
    deleteCalls: 0,
  });
});
