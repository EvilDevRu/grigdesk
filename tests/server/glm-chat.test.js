import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import { supportsScopedWorkspace } from '../../server/src/lib/executors/index.ts';
import chatModule from '../../server/src/modules/chat/index.ts';
import providersModule from '../../server/src/modules/providers/index.ts';
import authPlugin, { SESSION_COOKIE } from '../../server/src/plugins/auth.ts';
import { PrefsStore } from '../../server/src/lib/prefsStore.ts';
import { createGlmFakeRuntime } from '../helpers/glmFakeRuntime.mts';

const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireServer('fastify');
const MODEL = '["zai","glm-5.3"]';
const SESSION = 'glm-chat-session';
const TEXT = { updates: [{ sessionUpdate: 'agent_message_chunk', content: { text: 'glm-answer' } }] };

/**
 * Временный Fastify с общим auth guard, карточками исполнителей и модулем чата.
 * GLM — DI-адаптер на фейковом DSH web; каждый запуск хода виден тесту.
 */
async function fixture(t, scenario = TEXT) {
  const runtime = await createGlmFakeRuntime(t, scenario);
  const app = Fastify({ logger: false });
  const events = [];
  const runs = [];
  const executor = {
    ...runtime.adapter,
    run: (input) => {
      runs.push(input);

      return runtime.adapter.run(input);
    },
  };
  const config = {
    ...runtime.config,
    chatsDir: path.join(runtime.root, 'chats'),
    chatStoreLegacyPath: path.join(runtime.root, 'legacy.json'),
    chatBindingsDir: path.join(runtime.root, 'bindings'),
    factoryHome: runtime.root,
    agentsDir: path.join(runtime.root, 'agents'),
    modelsPath: path.join(runtime.root, 'models.json'),
    port: 18145,
  };

  app.decorate('sse', { broadcast: (event, data) => events.push({ event, data }) });
  await app.register(authPlugin, {
    authStore: {
      isConfigured: () => true,
      isValidSession: (id) => id === SESSION,
    },
  });
  await app.register(providersModule, {
    config,
    prefs: new PrefsStore({ prefsPath: path.join(runtime.root, 'prefs.json') }),
    getProviderAdapters: async () => new Map([['glm', executor]]),
    getModelsRegistry: async () => ({ glm: [{ id: MODEL, efforts: ['low', 'high', 'max'] }] }),
  });
  await app.register(chatModule, {
    config,
    factoryState: { readEnv: async () => ({}) },
    prefs: { read: () => ({ providerSettings: {} }) },
    claudeAuth: null,
    internalToken: 'test',
    modelsRegistry: async () => ({ glm: [{ id: MODEL, efforts: ['low', 'high', 'max'] }] }),
    executorResolver: async (provider) => (provider === 'glm' ? executor : null),
  });
  t.after(() => app.close());

  const headers = { cookie: `${SESSION_COOKIE}=${SESSION}` };
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    headers,
    payload: {
      chat: {
        id: 'glm-chat',
        modelRef: { provider: 'glm', model: MODEL },
        messages: [],
        revision: 0,
      },
    },
  });

  assert.equal(saved.statusCode, 200, saved.body);

  return {
    ...runtime,
    app,
    events,
    runs,
    headers,
    executor,
    chat: (payload = {}, options = {}) => app.inject({
      method: 'POST',
      url: '/api/chat',
      headers: options.anonymous ? {} : headers,
      payload: {
        chatKey: 'glm-chat',
        modelRef: { provider: 'glm', model: MODEL },
        message: 'synthetic',
        ...payload,
      },
    }),
    stored: async () => (await app.inject({ url: '/api/chat/store/chat/glm-chat', headers })).json().chat,
    prompts: async () => (await runtime.log()).filter((entry) => entry.message?.method === 'session/prompt')
      .length,
  };
}

const ESCALATION = {
  file_path: '/outside/file.txt',
  content: 'x',
  sandbox_permissions: 'danger-full-access',
  justification: 'нужна запись вне проекта',
};
const WRITE_CALL = {
  sessionUpdate: 'tool_call',
  toolCallId: 'call-1',
  title: 'write',
  rawInput: ESCALATION,
};

test('auth guard закрывает карточку, каталог и ход GLM', async (t) => {
  const f = await fixture(t);
  const anonymous = await Promise.all([
    f.app.inject('/api/providers'),
    f.app.inject('/api/providers/glm/mcp'),
    f.chat({}, { anonymous: true }),
  ]);

  assert.deepEqual(anonymous.map((response) => response.statusCode), [401, 401, 401]);
  assert.equal(f.runs.length, 0);
  assert.equal(f.children.length, 0);

  const providers = await f.app.inject({ url: '/api/providers', headers: f.headers });
  const card = providers.json().providers?.find((item) => item.id === 'glm')
    ?? providers.json().find?.((item) => item.id === 'glm');

  assert.equal(providers.statusCode, 200, providers.body);
  assert.equal(card.chatEnabled, true);
  assert.equal(card.sessionBinding, true);
});

/**
 * Ход по протоколу доставки: приём 202 по turnId, итог — в pending после SSE chat-done.
 * Возвращает ответ приёма и записи pending этого хода.
 */
async function deliver(f, turnId) {
  const accepted = await f.chat({ turnId });

  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (f.events.some((event) => event.event === 'chat-done' && event.data.turnId === turnId)) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const pending = (await f.app.inject({ url: '/api/chat/pending', headers: f.headers })).json().pending;

  return {
    accepted,
    records: pending.filter((item) => item.turnId === turnId),
  };
}

test('принятый ход, SSE, pending и F5 дают одну запись ответа', async (t) => {
  const f = await fixture(t);
  const { accepted, records } = await deliver(f, 'turn-glm-0001');
  const repeated = await f.chat({ turnId: 'turn-glm-0001' });
  const status = await f.app.inject({ url: '/api/chat/turns?ids=turn-glm-0001', headers: f.headers });

  assert.equal(accepted.statusCode, 202, accepted.body);
  assert.equal(records.length, 1);
  assert.equal(records[0].reply, 'glm-answer');
  assert.ok(f.events.some((event) => event.event === 'chat-done' && event.data.turnId === 'turn-glm-0001'));
  // F5 повторяет отправку тем же turnId: сервер отвечает duplicate и исполнителя не будит.
  assert.equal(repeated.statusCode, 202);
  assert.equal(repeated.json().duplicate, true);
  assert.equal(status.json().turns['turn-glm-0001'].state, 'done');
  assert.equal(f.runs.length, 1);
  assert.equal(await f.prompts(), 1);
});

test('glm_ambiguous_outcome и полученные steps видны после переподключения без повтора', async (t) => {
  const f = await fixture(t, {
    hooks: true,
    closeAfterPrompt: true,
    updates: [{
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      title: 'read',
      rawInput: { file_path: 'a' },
    }],
  });
  const { accepted, records } = await deliver(f, 'turn-glm-0002');
  const repeated = await f.chat({ turnId: 'turn-glm-0002' });
  const steps = records[0]?.steps ?? [];

  assert.equal(accepted.statusCode, 202, accepted.body);
  assert.equal(records.length, 1);
  assert.equal(records[0].role, 'error');
  assert.match(records[0].reply, /автоматического повтора не было/u);
  assert.ok(steps.some((step) => step.k === 'tool' && step.id === 'call-1'), JSON.stringify(records[0]));
  assert.equal(repeated.json().duplicate, true);
  assert.equal(await f.prompts(), 1);
});

test('режим по умолчанию после allowedMode; внешний путь и MCP в auto — человеку', async (t) => {
  const f = await fixture(t, TEXT);

  assert.equal((await f.chat({ mode: undefined })).statusCode, 200);
  assert.equal((await f.chat({ mode: 'plan' })).statusCode, 200);
  // Факт: ядро превращает неизвестный GLM режим в пустой — адаптер видит «Правки в проекте».
  assert.deepEqual(f.runs.map((run) => run.permissionMode || ''), ['', '']);

  await f.scenario({
    hooks: true,
    updates: [WRITE_CALL],
    permission: { toolCallId: 'call-1', toolName: 'write' },
  });

  const running = f.chat({ mode: 'auto' });

  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (f.events.some((event) => event.event === 'chat-permission')) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const asked = f.events.find((event) => event.event === 'chat-permission');

  assert.ok(asked, 'запрос ушёл человеку, а не авто-решению');

  const answer = await f.app.inject({
    method: 'POST',
    url: `/api/chat/permission/${asked.data.pid}`,
    headers: f.headers,
    payload: { allow: false },
  });

  assert.equal(answer.statusCode, 200, answer.body);
  assert.equal((await running).statusCode, 200);

  const response = (await f.log()).find((entry) => entry.kind === 'permission_response');

  assert.deepEqual(response.message.result, { kind: 'result', value: 'rejected' });
});

test('отказ с комментарием: commentDelivered false', async (t) => {
  const f = await fixture(t, {
    hooks: true,
    updates: [WRITE_CALL],
    permission: { toolCallId: 'call-1', toolName: 'write' },
  });
  const running = f.chat();

  const asking = () => f.events.some((event) => event.event === 'chat-permission');

  for (let attempt = 0; attempt < 500 && !asking(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const asked = f.events.find((event) => event.event === 'chat-permission');
  const answer = await f.app.inject({
    method: 'POST',
    url: `/api/chat/permission/${asked.data.pid}`,
    headers: f.headers,
    payload: { allow: false, comment: 'не надо' },
  });

  assert.deepEqual(answer.json(), { ok: true, commentDelivered: false });
  assert.equal((await running).statusCode, 200);
});

test('Factory, триаж, plan и scoped отклоняются до процесса без правки allowedMode', async (t) => {
  const f = await fixture(t);
  const providers = await f.app.inject({ url: '/api/providers', headers: f.headers });
  const card = providers.json().providers?.find((item) => item.id === 'glm')
    ?? providers.json().find?.((item) => item.id === 'glm');

  assert.equal(card.capabilities.untrustedText, false, 'триаж требует untrusted-ввода');
  assert.equal(card.capabilities.scopedWorkspace, false, 'анализатор требует scoped workspace');
  assert.equal(await supportsScopedWorkspace(f.executor, f.config), false);

  for (const options of [{ permissionMode: 'plan' }, { factory: true }, { scopedWorkspace: true }]) {
    await assert.rejects(f.adapter.run({
      config: f.config,
      cwd: f.project,
      chatKey: 'direct',
      message: 'x',
      model: MODEL,
      onSessionCreated: async () => {},
      ...options,
    }), (error) => ['glm_mode_unsupported', 'glm_consumer_unsupported'].includes(error.code));
  }

  assert.equal(f.children.length, 0);
});
