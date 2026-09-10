// Проверяет атомарное создание и восстановление разговоров компаньона, принадлежащих серверу.
import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { ChatHistoryStore } from '../../server/src/lib/chat/historyStore.ts';
import chatModule from '../../server/src/modules/chat/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

const CREATED_AT = Date.UTC(2026, 7, 19, 10);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function storeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-companion-ensure-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    store: new ChatHistoryStore({
      chatsDir: path.join(root, 'chats'),
      now: () => CREATED_AT,
      registryProvider: async () => ({}),
    }),
  };
}

function ordinaryChat(id, extra = {}) {
  return {
    id,
    title: 'Обычный разговор',
    messages: [],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...extra,
  };
}

test('COMP-ENSURE-01/02: logical-key lock создаёт один случайный global/task chat', async (t) => {
  const { store } = await storeFixture(t);

  const global = await Promise.all(Array.from({ length: 12 }, () => (
    store.ensureByPurpose({ purpose: 'companion' })
  )));
  assert.equal(new Set(global.map((result) => result.chat.id)).size, 1);
  assert.match(global[0].chat.id, /^[0-9a-f-]{36}$/i);
  assert.equal(global[0].chat.purpose, 'companion');
  assert.equal(global[0].chat.taskId, null);
  assert.equal(global[0].chat.logicalIdentity, 'companion:global');

  const task = await Promise.all(Array.from({ length: 12 }, () => (
    store.ensureByPurpose({ purpose: 'companion', taskId: '44' })
  )));
  assert.equal(new Set(task.map((result) => result.chat.id)).size, 1);
  assert.notEqual(task[0].chat.id, global[0].chat.id);
  assert.equal(task[0].chat.taskId, '44');
  assert.equal(task[0].chat.logicalIdentity, 'companion:task:44');

  const other = await store.ensureByPurpose({ purpose: 'companion', taskId: '45' });
  assert.notEqual(other.chat.id, task[0].chat.id);
  const state = await store.read();
  assert.equal(state.sessions.length, 3, 'каждый logical key представлен одним chat-файлом');

  await assert.rejects(
    () => store.ensureByPurpose({ purpose: 'companion', taskId: '0044' }),
    (error) => error?.code === 'bad_companion_task_id',
  );
});

test('COMP-ENSURE-03: normal/debug и editable title не участвуют в identity search', async (t) => {
  const { store } = await storeFixture(t);
  await store.saveOne(ordinaryChat('normal-44', { taskId: '44', title: 'Компаньон' }));
  await store.saveOne(ordinaryChat('debug-44', {
    purpose: 'debug', taskId: '44', title: 'Компаньон задачи #44',
  }));

  const ensured = await store.ensureByPurpose({ purpose: 'companion', taskId: '44' });
  assert.notEqual(ensured.chat.id, 'normal-44');
  assert.notEqual(ensured.chat.id, 'debug-44');

  const renamed = await store.saveOne({
    ...ensured.chat,
    title: 'Совершенно обычное имя',
    updatedAt: CREATED_AT + 1,
  });
  const again = await store.ensureByPurpose({ purpose: 'companion', taskId: '44' });
  assert.equal(again.chat.id, renamed.chat.id);
});

test('COMP-ENSURE-04: archive восстанавливается тем же id, stale empty не очищает историю', async (t) => {
  const { store } = await storeFixture(t);
  const first = await store.ensureByPurpose({ purpose: 'companion', taskId: '77' });
  const staleEmpty = structuredClone(first.chat);
  const filled = await store.saveOne({
    ...first.chat,
    messages: [
      { role: 'user', text: 'Не теряй вопрос' },
      { role: 'assistant', text: 'И ответ' },
    ],
    updatedAt: CREATED_AT + 2,
  });
  const archived = await store.saveOne({
    ...filled.chat,
    closedAt: CREATED_AT + 3,
    updatedAt: CREATED_AT + 3,
  }, true);

  const restored = await store.ensureByPurpose({ purpose: 'companion', taskId: '77' });
  assert.equal(restored.chat.id, archived.chat.id);
  assert.equal(restored.chat.archived, false);
  assert.equal(restored.restored, true);

  const stale = await store.saveOne(staleEmpty, false);
  assert.equal(stale.stale, true);
  assert.equal(stale.restored, 2);
  assert.deepEqual((await store.readOne(first.chat.id)).messages.map((message) => message.text),
    ['Не теряй вопрос', 'И ответ']);
});

test('COMP-ENSURE-05: duplicate logical identity даёт явный conflict без выбора свежего', async (t) => {
  const { root, store } = await storeFixture(t);
  const month = path.join(root, 'chats', '2026-08');
  await fs.mkdir(month, { recursive: true });
  for (const [index, id] of ['duplicate-old', 'duplicate-new'].entries()) {
    await fs.writeFile(path.join(month, `${id}.json`), JSON.stringify({
      schema: 2,
      surface: 'chats',
      revision: 1,
      id,
      title: id,
      purpose: 'companion',
      taskId: '91',
      logicalIdentity: 'companion:task:91',
      messages: [{ role: 'assistant', text: `history-${index}` }],
      archived: index === 0,
      createdAt: CREATED_AT + index,
      updatedAt: CREATED_AT + index,
    }));
  }

  await assert.rejects(
    () => store.ensureByPurpose({ purpose: 'companion', taskId: '91' }),
    (error) => {
      assert.equal(error?.code, 'companion_chat_conflict');
      assert.deepEqual(new Set(error?.conflicts?.map((chat) => chat.id)),
        new Set(['duplicate-old', 'duplicate-new']));
      return true;
    },
  );
  assert.equal((await store.read()).sessions.length, 1);
  assert.equal((await store.read()).archived.length, 1);
});

test('COMP-ENSURE-05: mismatched taskId не прячет уже объявленный logical key', async (t) => {
  const { root, store } = await storeFixture(t);
  const month = path.join(root, 'chats', '2026-08');
  await fs.mkdir(month, { recursive: true });
  await fs.writeFile(path.join(month, 'corrupt-identity.json'), JSON.stringify({
    schema: 2,
    surface: 'chats',
    revision: 1,
    id: 'corrupt-identity',
    title: 'Повреждённая identity',
    purpose: 'companion',
    taskId: '2',
    logicalIdentity: 'companion:task:1',
    messages: [],
    archived: false,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  }));

  await assert.rejects(
    () => store.ensureByPurpose({ purpose: 'companion', taskId: '1' }),
    (error) => error?.code === 'companion_chat_conflict'
      && error.conflicts?.[0]?.id === 'corrupt-identity',
  );
  assert.equal((await store.read()).sessions.length, 1,
    'ensure не создаёт второй файл с уже объявленным logical key');
});

test('COMP-ENSURE-06: обычный save не создаёт и не перепривязывает server identity', async (t) => {
  const { store } = await storeFixture(t);
  const ensured = await store.ensureByPurpose({ purpose: 'companion', taskId: '8' });

  await assert.rejects(
    () => store.saveOne({ ...ensured.chat, purpose: 'debug', taskId: '9' }),
    (error) => error?.code === 'chat_identity_rebind',
  );
  await assert.rejects(
    () => store.saveOne(ordinaryChat('forged', {
      purpose: 'companion',
      taskId: '8',
      logicalIdentity: 'companion:task:8',
    })),
    (error) => error?.code === 'chat_identity_rebind',
  );

  const persisted = await store.readOne(ensured.chat.id);
  assert.equal(persisted.purpose, 'companion');
  assert.equal(persisted.taskId, '8');
  assert.equal(persisted.logicalIdentity, 'companion:task:8');
  assert.equal(await store.readOne('forged'), null);
});

test('COMP-ENSURE-06: DELETE сериализован с point/full PUT и не даёт воскресить identity', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-companion-delete-race-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const writeStarted = deferred();
  const releaseWrite = deferred();
  let pauseWrite = false;
  class PausedHistoryStore extends ChatHistoryStore {
    async writeAtomic(file, data) {
      if (pauseWrite) {
        pauseWrite = false;
        writeStarted.resolve();
        await releaseWrite.promise;
      }
      return super.writeAtomic(file, data);
    }
  }
  const store = new PausedHistoryStore({
    chatsDir: path.join(root, 'chats'),
    now: () => CREATED_AT,
    registryProvider: async () => ({}),
  });
  const ensured = await store.ensureByPurpose({ purpose: 'companion', taskId: '8' });
  const changed = {
    ...ensured.chat,
    title: 'Новое имя перед удалением',
    updatedAt: CREATED_AT + 1,
  };

  pauseWrite = true;
  const pointSave = store.saveOne(changed);
  await writeStarted.promise;
  let deleteSettled = false;
  const deletion = store.remove(changed.id).then((removed) => {
    deleteSettled = true;
    return removed;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deleteSettled, false, 'DELETE ждёт atomic point PUT под общим per-id lock');
  releaseWrite.resolve();
  await pointSave;
  assert.equal(await deletion, true);
  assert.equal(await store.readOne(changed.id), null, 'результат раннего PUT удалён последующим DELETE');

  await assert.rejects(
    () => store.saveOne(changed),
    (error) => error?.code === 'chat_identity_rebind',
    'point PUT после удаления не создаёт companion identity заново',
  );
  await assert.rejects(
    () => store.save({ sessions: [changed], archived: [] }),
    (error) => error?.code === 'chat_identity_rebind',
    'full-store PUT проходит тот же per-id identity gate',
  );
});

test('COMP-ENSURE-01/02/06: HTTP ensure атомарен, scope берёт только top-level taskId', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-companion-ensure-api-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const events = [];
  let executorCalls = 0;
  let factoryCalls = 0;
  const taskChecks = [];
  const knownTasks = new Set(['123']);
  const app = Fastify({ logger: false });
  app.decorate('sse', { broadcast(event, data) { events.push({ event, data }); } });
  await app.register(chatModule, {
    config: {
      chatsDir: path.join(root, 'chats'),
      chatStoreLegacyPath: path.join(root, 'legacy.json'),
      chatBindingsDir: path.join(root, 'bindings'),
      rootDir: root,
      factoryHome: root,
      port: 18140,
    },
    factoryState: {
      async readEnv() { factoryCalls += 1; throw new Error('ensure не читает factory-only state'); },
      async readRegistry() { factoryCalls += 1; throw new Error('ensure не читает factory-only state'); },
    },
    prefs: {
      read() { return { speech: {}, trustedDirectories: [], providerSettings: {}, chatAutoCompactWindow: 0 }; },
    },
    modelsRegistry: async () => ({}),
    executorResolver: async () => { executorCalls += 1; return null; },
    taskExists: async (taskId) => {
      taskChecks.push(String(taskId));
      return knownTasks.has(String(taskId));
    },
  });
  await app.ready();
  t.after(() => app.close());

  await app.inject({
    method: 'PUT', url: '/api/chat/store/meta',
    payload: { activeId: 'normal-active', defMode: 'acceptEdits', origin: 'seed' },
  });
  const payload = {
    purpose: 'companion', taskId: '123', origin: 'window-a',
    id: 'client-picked', model: 'forged', cwd: '/tmp/evil', mode: 'acceptEdits',
    details: { taskId: '999' },
  };
  const responses = await Promise.all(Array.from({ length: 8 }, () => app.inject({
    method: 'POST', url: '/api/chat/store/ensure', payload,
  })));
  responses.forEach((response) => assert.equal(response.statusCode, 200, response.body));
  const ids = responses.map((response) => response.json().chat.id);
  assert.equal(new Set(ids).size, 1);
  assert.notEqual(ids[0], 'client-picked');
  const taskChat = responses[0].json().chat;
  assert.equal(taskChat.taskId, '123');
  assert.equal(taskChat.model, undefined);
  assert.equal(taskChat.cwd, undefined);
  assert.equal(taskChat.mode, undefined);

  const rebind = await app.inject({
    method: 'PUT', url: '/api/chat/store/chat',
    payload: { chat: { ...taskChat, taskId: '999', purpose: 'companion' } },
  });
  assert.equal(rebind.statusCode, 409, rebind.body);
  assert.equal(rebind.json().error, 'chat_identity_rebind');
  const afterRebind = await app.inject({
    method: 'GET', url: `/api/chat/store/chat/${taskChat.id}`,
  });
  assert.equal(afterRebind.json().chat.taskId, '123');

  const legacyRebind = await app.inject({
    method: 'PUT', url: '/api/chat/store',
    payload: { sessions: [{ ...taskChat, taskId: '999' }], archived: [] },
  });
  assert.equal(legacyRebind.statusCode, 409, legacyRebind.body);
  assert.equal(legacyRebind.json().error, 'chat_identity_rebind');

  const global = await app.inject({
    method: 'POST', url: '/api/chat/store/ensure',
    payload: { purpose: 'companion', details: { taskId: '999' } },
  });
  assert.equal(global.statusCode, 200, global.body);
  assert.equal(global.json().chat.taskId, null, 'details не является routing scope');
  assert.notEqual(global.json().chat.id, taskChat.id);

  const taskChecksBeforeInvalid = taskChecks.length;
  for (const [payload, expectedError] of [
    [{ taskId: '123' }, 'bad_chat_purpose'],
    [{ purpose: 'debug', taskId: '123' }, 'bad_chat_purpose'],
    [{ purpose: 'companion', taskId: '../123' }, 'bad_companion_task_id'],
  ]) {
    const rejected = await app.inject({
      method: 'POST', url: '/api/chat/store/ensure', payload,
    });
    assert.equal(rejected.statusCode, 400, rejected.body);
    assert.equal(rejected.json().error, expectedError);
  }
  assert.equal(taskChecks.length, taskChecksBeforeInvalid,
    'невалидные purpose/taskId отсекаются до server-owned task resolver');

  const invalid = await app.inject({
    method: 'POST', url: '/api/chat/store/ensure',
    payload: { purpose: 'companion', taskId: '00123' },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error, 'bad_companion_task_id');
  assert.equal(taskChecks.length, taskChecksBeforeInvalid,
    'неканонический numeric taskId тоже не достигает resolver-а');

  const unknown = await app.inject({
    method: 'POST', url: '/api/chat/store/ensure',
    payload: { purpose: 'companion', taskId: '124' },
  });
  assert.equal(unknown.statusCode, 404, unknown.body);
  assert.equal(unknown.json().error, 'companion_task_not_found');

  const state = await app.inject({ method: 'GET', url: '/api/chat/store' });
  assert.equal(state.statusCode, 200, state.body);
  assert.equal(state.json().activeId, 'normal-active');
  assert.equal(state.json().defMode, 'acceptEdits');
  assert.equal(state.json().sessions.length, 2);
  assert.equal(executorCalls, 0);
  assert.equal(factoryCalls, 0, 'HTTP gate использует только внедрённый server-owned resolver');
  assert.ok(taskChecks.includes('123'));
  assert.ok(taskChecks.includes('124'));
  assert.equal(events.filter((event) => event.event === 'chat-store').length, 2,
    'SSE публикуется только для двух реально созданных записей');
});

test('COMP-ENSURE-05: HTTP conflict возвращает 409 и оба кандидата для handoff', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-companion-conflict-api-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const month = path.join(root, 'chats', '2026-08');
  await fs.mkdir(month, { recursive: true });
  for (const id of ['conflict-a', 'conflict-b']) {
    await fs.writeFile(path.join(month, `${id}.json`), JSON.stringify({
      schema: 2,
      surface: 'chats',
      revision: 1,
      id,
      title: id,
      purpose: 'companion',
      taskId: null,
      logicalIdentity: 'companion:global',
      messages: [],
      archived: false,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    }));
  }

  const app = Fastify({ logger: false });
  app.decorate('sse', { broadcast() {} });
  await app.register(chatModule, {
    config: {
      chatsDir: path.join(root, 'chats'),
      chatStoreLegacyPath: path.join(root, 'legacy.json'),
      chatBindingsDir: path.join(root, 'bindings'),
      rootDir: root,
      factoryHome: root,
      port: 18140,
    },
    factoryState: { async readEnv() { return {}; } },
    prefs: { read() { return { speech: {}, trustedDirectories: [] }; } },
    modelsRegistry: async () => ({}),
  });
  await app.ready();
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST', url: '/api/chat/store/ensure', payload: { purpose: 'companion' },
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error, 'companion_chat_conflict');
  assert.deepEqual(new Set(response.json().chatIds), new Set(['conflict-a', 'conflict-b']));
  assert.equal(response.json().conflicts.length, 2);
});
