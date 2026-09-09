import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { autoDecision } from '../../server/src/lib/chat/auto-approve.js';
import { createKnowledgeBroker } from '../../server/src/lib/search/broker.ts';
import chatModule from '../../server/src/modules/chat/index.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const RECORD_ID = '00000000-0000-4000-8000-000000000077';
const RECORD = {
  repository: 'main',
  kind: 'fact',
  title: 'Проверенное знание',
  body: 'Новое содержимое знания.',
  tags: ['knowledge'],
};

/**
 * Изолированный broker считает мутации и позволяет менять живой gate или запись
 * во время ожидания человека. Пользовательская БД в тестах не открывается.
 */
function brokerFixture() {
  let enabled = true;
  let current = { id: RECORD_ID, project: 'alpha', revision: 1, ...RECORD, body: 'До правки.' };
  const mutations = [];
  const maps = [];
  const broker = createKnowledgeBroker({
    pluginEnabled: () => enabled,
    knowledge: {
      async read() {
        return current && structuredClone(current);
      },
      async search() {
        return { items: [] };
      },
      async create(input) {
        mutations.push(input);
        return { id: RECORD_ID, revision: 1, ...input };
      },
      async update(id, input) {
        mutations.push(input);
        current = { ...current, ...input, revision: current.revision + 1 };
        return current;
      },
    },
    transfer: {
      async updateMaps(input) {
        maps.push(input);
      },
    },
  });

  return {
    broker,
    mutations,
    maps,
    setEnabled(value) {
      enabled = value;
    },
    setCurrent(value) {
      current = value;
    },
  };
}

test('Знание требует подтверждения в manual/default и без явно разрешающего режима', async () => {
  for (const permissionMode of ['manual', 'default', '', 'unknown']) {
    const fixture = brokerFixture();
    const scope = { projectId: 'alpha', chatKey: 'fixture-chat', permissionMode };
    const input = { action: 'write', record: RECORD };
    const missing = await fixture.broker.invoke(scope, input);
    assert.equal(missing.error, 'permission_denied');
    assert.equal(missing.reason, 'approval_unavailable');

    let prompts = 0;
    const denied = await fixture.broker.invoke(scope, input, {
      async onPermission(presentation) {
        prompts += 1;
        assert.equal(presentation.input.diff.new, RECORD.body);
        assert.equal(presentation.canRemember, false);
        return { allow: false, comment: 'Сначала проверь факт' };
      },
    });
    assert.equal(denied.comment, 'Сначала проверь факт');
    assert.equal(fixture.mutations.length, 0);
    assert.equal(fixture.maps.length, 0);

    const allowed = await fixture.broker.invoke(scope, input, {
      async onPermission() {
        prompts += 1;
        return { allow: true };
      },
    });
    assert.equal(allowed.ok, true);
    assert.equal(prompts, 2);
    assert.equal(fixture.mutations.length, 1);
  }
});

test('Режим plan закрывает запись, а явно разрешённые правки не спрашивают повторно', async () => {
  for (const permissionMode of ['plan', 'acceptEdits', 'dontAsk', 'bypassPermissions', 'yolo']) {
    const fixture = brokerFixture();
    const scope = { projectId: 'alpha', chatKey: 'fixture-chat', permissionMode };
    const result = await fixture.broker.invoke(scope, { action: 'write', record: RECORD }, {
      onPermission() {
        assert.fail('Этот режим не требует запроса подтверждения');
      },
    });
    assert.equal(result.ok, permissionMode !== 'plan');
    assert.equal(fixture.mutations.length, permissionMode === 'plan' ? 0 : 1);
    assert.equal((await fixture.broker.invoke(scope, { action: 'read', id: RECORD_ID })).ok, true);
    assert.equal((await fixture.broker.invoke(scope, { action: 'search', query: 'знание' })).ok, true);
  }
});

test('Авто-режим использует общий классификатор правок знания', async () => {
  const fixture = brokerFixture();
  let decisions = 0;
  const result = await fixture.broker.invoke(
    { projectId: 'alpha', chatKey: 'fixture-chat', permissionMode: 'auto' },
    { action: 'write', record: RECORD },
    {
      async onPermission(presentation) {
        decisions += 1;
        return { allow: autoDecision(presentation).verdict === 'allow' };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(decisions, 1);
  assert.equal(fixture.mutations.length, 1);
});

test('После подтверждения перепроверяются плагин, ход, проект и ревизия записи', async () => {
  for (const change of ['plugin', 'turn', 'abort', 'project', 'revision']) {
    const fixture = brokerFixture();
    const controller = new AbortController();
    let currentTurn = true;
    const result = await fixture.broker.invoke(
      { projectId: 'alpha', chatKey: 'fixture-chat', permissionMode: 'manual' },
      { action: 'write', id: RECORD_ID, revision: 1, record: RECORD },
      {
        signal: controller.signal,
        isCurrent: () => currentTurn,
        async onPermission(presentation) {
          assert.deepEqual(presentation.input.diff, { old: 'До правки.', new: RECORD.body });
          if (change === 'plugin') {
            fixture.setEnabled(false);
          } else if (change === 'turn') {
            currentTurn = false;
          } else if (change === 'abort') {
            controller.abort();
          } else {
            fixture.setCurrent({
              id: RECORD_ID,
              ...RECORD,
              project: change === 'project' ? 'other' : 'alpha',
              revision: change === 'revision' ? 2 : 1,
            });
          }
          return { allow: true };
        },
      },
    );
    assert.equal(result.ok, false, change);
    assert.equal(fixture.mutations.length, 0, change);
    assert.equal(fixture.maps.length, 0, change);
  }
});

/**
 * Поддельный исполнитель использует сохранённый workTools между ходами, как
 * persistent CLI. Запрос и ответ проходят настоящие маршруты разрешений чата.
 */
async function chatFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-knowledge-permission-'));
  const fixture = brokerFixture();
  const app = Fastify({ logger: false });
  const results = [];
  let tools;
  let pendingPermission;
  let notifyPermission;
  const resetPermission = () => {
    pendingPermission = new Promise((resolve) => {
      notifyPermission = resolve;
    });
  };
  resetPermission();
  app.decorate('sse', {
    broadcast(name, payload) {
      if (name === 'chat-permission') {
        notifyPermission(payload);
      }
    },
  });
  const executor = {
    id: 'fixture',
    async modes() {
      return [{ id: 'manual' }];
    },
    async run(options) {
      tools ||= options.workTools;
      const result = await tools.invoke('knowledge_search', {
        action: 'write', id: RECORD_ID, revision: 1, record: RECORD,
      });
      results.push(result);
      return { reply: 'Готово', steps: [], sessionId: 'fixture-session' };
    },
  };
  await app.register(chatModule, {
    config: {
      rootDir: root,
      factoryHome: root,
      agentsDir: path.join(root, 'agents'),
      chatsDir: path.join(root, 'chats'),
      chatBindingsDir: path.join(root, 'bindings'),
      chatStoreLegacyPath: path.join(root, 'legacy.json'),
    },
    factoryState: { async readEnv() { return {}; } },
    prefs: { read() { return { trustedDirectories: [], providerSettings: {} }; } },
    modelsRegistry: async () => ({ fixture: [{ id: 'fixture-model', efforts: [] }] }),
    executorResolver: async () => executor,
    knowledgeBroker: fixture.broker,
  });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const chatKey = 'knowledge-permission-chat';
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: { chat: {
      id: chatKey,
      title: 'Тест разрешения знаний',
      modelRef: { provider: 'fixture', model: 'fixture-model' },
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    } },
  });
  assert.equal(saved.statusCode, 200, saved.body);

  return {
    ...fixture,
    results,
    async turn(answer) {
      resetPermission();
      const turn = app.inject({
        method: 'POST', url: '/api/chat',
        payload: { chatKey, message: 'Исправь знание', mode: 'manual' },
      });
      const permission = await pendingPermission;
      assert.equal(permission.canRemember, false);
      assert.equal(permission.input.diff.new, RECORD.body);
      const reply = await app.inject({
        method: 'POST', url: `/api/chat/permission/${permission.pid}`, payload: answer,
      });
      assert.equal(reply.statusCode, 200, reply.body);
      const response = await turn;
      assert.equal(response.statusCode, 200, response.body);
    },
    async staleWrite() {
      return tools.invoke('knowledge_search', {
        action: 'write', id: RECORD_ID, revision: 1, record: RECORD,
      });
    },
  };
}

test('Переиспользованный инструмент получает решение текущего хода и не пишет после него', {
  timeout: 10_000,
}, async (t) => {
  const fixture = await chatFixture(t);
  await fixture.turn({ allow: false, comment: 'Проверь источник' });
  assert.equal(fixture.results[0].error, 'permission_denied');
  assert.equal(fixture.results[0].comment, 'Проверь источник');
  assert.equal(fixture.mutations.length, 0);

  await fixture.turn({ allow: true });
  assert.equal(fixture.results[1].ok, true);
  assert.equal(fixture.mutations.length, 1);
  const stale = await fixture.staleWrite();
  assert.equal(stale.reason, 'turn_inactive');
  assert.equal(fixture.mutations.length, 1);
});
