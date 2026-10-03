import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import { ChatSessionBindingStore } from '../../server/src/lib/chat/sessionBindingStore.ts';
import { chatHomeFor } from '../../server/src/lib/deepseek/env.ts';
import { createGlmAdapter } from '../../server/src/lib/executors/glm.ts';
import { glmCompatibilityIdentity } from '../../server/src/lib/glm/contract.ts';
import { describeGlmGeneration } from '../../server/src/lib/glm/generation.ts';
import { glmChatHome } from '../../server/src/lib/glm/launch.ts';
import { glmSessionJournalDir } from '../../server/src/lib/glm/session.ts';
import chatModule from '../../server/src/modules/chat/index.ts';
import { ensureTestDeepSeekArtifact } from '../helpers/deepseekRuntimeArtifact.mts';
import { startGlmLoopback } from '../helpers/glmLoopback.mts';
import { GLM_SERVICE_KEY, glmTextReply, writeGlmEgressGuard } from '../helpers/glmProductionFixture.mts';

const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireServer('fastify');
const ARTIFACTS = path.resolve(import.meta.dirname, '../../.state/artifacts/glm/G9/fixtures');
const MODEL = '["zai","glm-5.3"]';

/**
 * Стенд памяти: настоящая generation, фейк Z.ai, DI-адаптер с допуском этой сборки.
 * Каталог homes GLM и корень DeepSeek разведены, как в конфигурации службы.
 */
async function fixture(t, loopbackOptions) {
  const artifact = await ensureTestDeepSeekArtifact();

  await fs.mkdir(ARTIFACTS, { recursive: true });

  const root = await fs.mkdtemp(path.join(ARTIFACTS, 'session-'));
  const project = path.join(root, 'project');
  const mock = await startGlmLoopback({
    expectedKey: GLM_SERVICE_KEY,
    ...loopbackOptions,
  });
  const config = {
    rootDir: project,
    deepseekArtifactDir: artifact,
    deepseekRuntimeMode: 'embedded',
    deepseekRuntimeHome: path.join(root, 'deepseek-home'),
    glmRuntimeHome: path.join(root, 'glm-home'),
  };
  const identity = glmCompatibilityIdentity(describeGlmGeneration(config).runtime, 'api');
  const adapter = createGlmAdapter({
    env: {
      PATH: process.env.PATH,
      HOME: root,
      COCKPIT_GLM_API_MODE: 'api',
      ZAI_API_KEY: GLM_SERVICE_KEY,
    },
    admission: [{ mode: 'api', compatibility: identity }],
    catalog: [{ id: MODEL, efforts: ['low', 'high', 'max'] }],
    modelEndpoint: mock.endpoint,
    egressGuard: await writeGlmEgressGuard(path.join(root, 'guard')),
  });

  await fs.mkdir(path.join(project, '.git'), { recursive: true });
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await mock.stop();
  });

  return {
    root,
    project,
    config,
    identity,
    adapter,
    mock,
    home: (chatKey) => glmChatHome(config.glmRuntimeHome, identity, chatKey),
    run: (options = {}) => adapter.run({
      config,
      cwd: project,
      chatKey: 'chat-a',
      message: 'first-prompt',
      model: MODEL,
      onSessionCreated: async () => {},
      signal: AbortSignal.timeout(60_000),
      ...options,
    }),
  };
}

test('настоящий новый процесс продолжает память по binding', async (t) => {
  const f = await fixture(t, { respond: (_payload, index) => glmTextReply(`answer-${index}`) });
  const first = await f.run();
  const second = await f.run({ sessionId: first.sessionId, message: 'second-prompt' });
  const messages = JSON.stringify(f.mock.requests[1].payload.messages);

  assert.equal(second.sessionId, first.sessionId);
  assert.match(messages, /first-prompt/u);
  assert.match(messages, /answer-0/u);
  assert.match(messages, /second-prompt/u);
});

test('настоящие два чата GLM и чат DeepSeek не смешивают homes и память', async (t) => {
  const f = await fixture(t, { respond: () => glmTextReply() });
  const first = await f.run();
  const other = await f.run({ chatKey: 'chat-b', message: 'other-prompt' });
  const deepseekHome = chatHomeFor(path.join(f.config.deepseekRuntimeHome, 'generations', 'build'), 'chat-a');

  assert.notEqual(f.home('chat-a'), f.home('chat-b'));
  assert.notEqual(other.sessionId, first.sessionId);
  assert.doesNotMatch(JSON.stringify(f.mock.requests[1].payload.messages), /first-prompt/u);
  assert.ok(path.relative(f.config.glmRuntimeHome, deepseekHome).startsWith('..'));
  await assert.rejects(f.run({ chatKey: 'chat-b', sessionId: first.sessionId }), {
    code: 'glm_session_missing',
  });
  assert.equal(f.mock.requests.length, 2);
});

test('настоящий повреждённый журнал сессии даёт glm_session_missing без новой сессии', async (t) => {
  const f = await fixture(t, { respond: () => glmTextReply() });
  const first = await f.run();
  const directory = glmSessionJournalDir(f.home('chat-a'), await fs.realpath(f.project), first.sessionId);
  const journal = (await fs.readdir(directory)).find((name) => name.startsWith('session.v'));

  await fs.writeFile(path.join(directory, journal), 'corrupt-not-zstd');

  const sessions = await fs.readdir(path.dirname(directory));

  await assert.rejects(f.run({ sessionId: first.sessionId, message: 'after-corruption' }), {
    code: 'glm_session_missing',
  });
  assert.equal(f.mock.requests.length, 1);
  assert.deepEqual(await fs.readdir(path.dirname(directory)), sessions);
});

test('настоящее summary-сжатие сохраняет историю чата', async (t) => {
  const f = await fixture(t, { respond: (_payload, index) => glmTextReply(['first-answer', 'SUMMARY-MARK',
    'after-compact'][index] ?? 'extra') });
  const app = Fastify({ logger: false });
  const chatConfig = {
    ...f.config,
    chatsDir: path.join(f.root, 'chats'),
    chatStoreLegacyPath: path.join(f.root, 'legacy.json'),
    chatBindingsDir: path.join(f.root, 'bindings'),
    factoryHome: f.root,
    agentsDir: path.join(f.root, 'agents'),
    port: 18144,
  };

  app.decorate('sse', { broadcast() {} });
  await app.register(chatModule, {
    config: chatConfig,
    factoryState: { readEnv: async () => ({}) },
    prefs: { read: () => ({ providerSettings: {} }) },
    claudeAuth: null,
    internalToken: 'test',
    modelsRegistry: async () => ({ glm: [{ id: MODEL, efforts: ['low', 'high', 'max'] }] }),
    executorResolver: async (provider) => (provider === 'glm' ? f.adapter : null),
  });
  t.after(() => app.close());

  const saved = await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        id: 'glm-chat',
        modelRef: { provider: 'glm', model: MODEL },
        messages: [],
        revision: 0,
      },
    },
  });
  const turn = (message) => app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: {
      chatKey: 'glm-chat',
      modelRef: { provider: 'glm', model: MODEL },
      message,
    },
  });

  assert.equal(saved.statusCode, 200, saved.body);

  const opened = await turn('remember-this');

  assert.equal(opened.statusCode, 200, opened.body);

  const bindings = new ChatSessionBindingStore({ dir: chatConfig.chatBindingsDir });
  const before = await bindings.read('glm-chat');
  const compact = await app.inject({
    method: 'POST',
    url: '/api/chat/compact',
    payload: { chatKey: 'glm-chat', sessionId: before.sessionId },
  });

  assert.equal(compact.statusCode, 200, compact.body);

  // Ядро хранит выжимку в pendingSeed; в следующее сообщение её вклеивает окно чата.
  const stored = (await app.inject('/api/chat/store/chat/glm-chat')).json().chat;
  const seeded = await turn(`[Выжимка предыдущего разговора]\n${stored.pendingSeed}\n\nafter-summary`);
  const after = await bindings.read('glm-chat');
  const summaryRequest = JSON.stringify(f.mock.requests[1].payload.messages);
  const messages = JSON.stringify(f.mock.requests[2].payload.messages);

  assert.equal(stored.pendingSeed, 'SUMMARY-MARK');
  assert.match(summaryRequest, /remember-this/u);
  assert.match(summaryRequest, /first-answer/u);
  assert.equal(seeded.statusCode, 200, seeded.body);
  assert.notEqual(after.sessionId, before.sessionId);
  assert.match(messages, /SUMMARY-MARK/u);
  assert.doesNotMatch(messages, /first-answer/u);
});
