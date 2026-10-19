import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { ChatSessionBindingStore } from '../../server/src/lib/chat/sessionBindingStore.ts';
import { createGlmAdapter } from '../../server/src/lib/executors/glm.ts';
import { glmCompatibilityIdentity } from '../../server/src/lib/glm/contract.ts';
import { describeGlmGeneration } from '../../server/src/lib/glm/generation.ts';
import { glmChatHome } from '../../server/src/lib/glm/launch.ts';
import { glmSessionJournalDir } from '../../server/src/lib/glm/session.ts';
import chatModule from '../../server/src/modules/chat/index.ts';
import { GLM_FIXTURE_PLUGIN, writeGlmArtifactFixture } from '../helpers/glmArtifactFixture.mts';

const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireServer('fastify');
const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const FAKE_WEB = path.join(REPO_ROOT, 'tests/fixtures/deepseek-harness/fakeWeb.mjs');
const MODEL = '["zai","glm-5.3"]';
const TEXT = { updates: [{ sessionUpdate: 'agent_message_chunk', content: { text: 'ok' } }] };

/**
 * Generation-фикстура с entry, запускающим фейковый DSH web; две сборки дают разные identity.
 * Возвращает config, identity обеих сборок и запись сценария.
 */
async function fixture(t, scenario = TEXT) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-session-'));
  const project = path.join(root, 'project');
  const other = path.join(root, 'other');
  const scenarioFile = path.join(root, 'scenario.json');
  const logFile = path.join(root, 'fake.ndjson');
  const entry = [
    'if (process.argv[2] === "-V") { console.log("0.1.5-rc.2"); process.exit(0); }',
    `process.argv.push("--scenario", ${JSON.stringify(scenarioFile)},`
      + ` "--log", ${JSON.stringify(logFile)});`,
    `await import(${JSON.stringify(pathToFileURL(FAKE_WEB).href)});`,
    '',
  ].join('\n');

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  for (const directory of [project, other]) {
    await fs.mkdir(path.join(directory, '.git'), { recursive: true });
  }

  await fs.writeFile(scenarioFile, JSON.stringify(scenario));
  await fs.writeFile(logFile, '');
  await writeGlmArtifactFixture(path.join(root, 'generation'), { llmPiAi: GLM_FIXTURE_PLUGIN, entry });
  await writeGlmArtifactFixture(path.join(root, 'generation-b'), {
    llmPiAi: { ...GLM_FIXTURE_PLUGIN, sourceHash: 'b'.repeat(64) },
    entry,
  });

  const config = {
    rootDir: root,
    deepseekBin: path.join(root, 'generation', 'deepseek'),
    deepseekRuntimeMode: 'binary',
    glmRuntimeHome: path.join(root, 'glm-home'),
  };
  const identities = ['generation', 'generation-b'].map((name) => glmCompatibilityIdentity(
    describeGlmGeneration({ ...config, deepseekBin: path.join(root, name, 'deepseek') }).runtime, 'api'));
  const env = {
    PATH: process.env.PATH,
    GRIGDESK_GLM_API_MODE: 'api',
    ZAI_API_KEY: 'synthetic-key-a',
  };
  const spawned = [];
  const adapter = createGlmAdapter({
    env,
    admission: identities.map((compatibility) => ({ mode: 'api', compatibility })),
    spawn: (...args) => {
      spawned.push(args);

      return spawn(...args);
    },
  });

  return {
    root,
    project,
    other,
    config,
    identities,
    env,
    spawned,
    adapter,
    scenario: (value) => fs.writeFile(scenarioFile, JSON.stringify(value)),
    log: async () => (await fs.readFile(logFile, 'utf8')).split('\n').filter(Boolean).map(JSON.parse),
    /**
     * Журнал сессии в home чата, как его пишет DSH: каталог проекта по cwd и файл сессии.
     * Фейковый web журналов не пишет, поэтому resume-тесты создают его сами.
     */
    async journal(chatKey, cwd, sessionId, identity = identities[0]) {
      const directory = glmSessionJournalDir(glmChatHome(config.glmRuntimeHome, chatKey), cwd,
        sessionId);

      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, 'session.v3.jsonl.zstd'), 'journal');
    },
    run(options = {}) {
      return adapter.run({
        config,
        cwd: project,
        chatKey: 'chat-a',
        message: 'fixture-prompt',
        model: MODEL,
        onSessionCreated: async () => {},
        ...options,
      });
    },
  };
}

test('ключ, режим, права и cwd меняют binding, а identity сборки не меняет профиль', async (t) => {
  const f = await fixture(t);
  const binding = f.adapter.sessionBinding;
  const auth = await binding.authProfileId(f.config);
  const security = await binding.securityProfile(f.config, {});

  f.env.ZAI_API_KEY = 'synthetic-key-b';
  assert.notEqual(await binding.authProfileId(f.config), auth, 'ключ');
  f.env.GRIGDESK_GLM_API_MODE = 'coding-plan';
  f.env.ZAI_CODING_API_KEY = 'synthetic-key-a';
  assert.notEqual(await binding.authProfileId(f.config), auth, 'режим');
  f.env.GRIGDESK_GLM_API_MODE = 'api';
  f.env.ZAI_API_KEY = 'synthetic-key-a';
  assert.equal(await binding.authProfileId(f.config), auth);
  assert.equal(auth.includes('synthetic-key-a'), false);

  assert.equal(await binding.securityProfile({
    ...f.config,
    deepseekBin: path.join(f.root, 'generation-b', 'deepseek'),
  }, {}), security, 'identity сборки не входит в профиль прав');
  assert.notEqual(await binding.securityProfile(f.config, { blockDirectSsh: false }), security, 'SSH');
  assert.notEqual(await binding.securityProfile(f.config, { blockDirectDb: true }), security, 'БД');

  // cwd входит в identity привязки ядра; DSH ищет журнал по cwd — сессию из другой папки
  // GLM не продолжает молча новой.
  await f.journal('chat-a', f.project, 'session-moved');
  await assert.rejects(f.run({ cwd: f.other, sessionId: 'session-moved' }), { code: 'glm_session_missing' });
  assert.equal(f.spawned.length, 0);
  assert.equal((await f.run({ sessionId: 'session-moved' })).sessionId, 'session-moved');
});

test('чужие sessionId или chatKey отклоняются', async (t) => {
  const f = await fixture(t);

  await f.journal('chat-a', f.project, 'session-of-a');

  for (const options of [
    { chatKey: 'chat-b', sessionId: 'session-of-a' },
    { sessionId: 'session-unknown' },
    { sessionId: '../session-of-a' },
  ]) {
    await assert.rejects(f.run(options), { code: 'glm_session_missing' }, JSON.stringify(options));
  }

  assert.equal(f.spawned.length, 0);
});

/**
 * Модуль чата с DI-адаптером GLM на фейковом DSH web: тот же путь привязки, что у ядра.
 * Возвращает приложение и хранилище привязок.
 */
async function chatFixture(t, f) {
  const app = Fastify({ logger: false });
  const config = {
    ...f.config,
    chatsDir: path.join(f.root, 'chats'),
    chatStoreLegacyPath: path.join(f.root, 'legacy.json'),
    chatBindingsDir: path.join(f.root, 'bindings'),
    factoryHome: f.root,
    agentsDir: path.join(f.root, 'agents'),
    port: 18143,
  };

  app.decorate('sse', { broadcast() {} });
  await app.register(chatModule, {
    config,
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

  assert.equal(saved.statusCode, 200, saved.body);

  return {
    app,
    bindings: new ChatSessionBindingStore({ dir: config.chatBindingsDir }),
    run: () => app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: {
        chatKey: 'glm-chat',
        modelRef: { provider: 'glm', model: MODEL },
        message: 'synthetic',
      },
    }),
  };
}

test('поздний onSessionCreated после сброса не оживляет старый binding', async (t) => {
  const f = await fixture(t, { ...TEXT, delay: { 'session/selectModel': 1500 } });
  const chat = await chatFixture(t, f);
  const running = chat.run();

  for (let attempt = 0; attempt < 300; attempt += 1) {
    if ((await f.log()).some((entry) => entry.message?.method === 'session/selectModel')) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const reset = () => chat.app.inject({
    method: 'POST',
    url: '/api/chat/session/reset',
    payload: { chatKey: 'glm-chat', modelRef: { provider: 'glm', model: MODEL } },
  });
  // Факт G9: ядро не сбрасывает память во время активного хода — поздний onSessionCreated
  // этого хода не может «оживить» уже сброшенную привязку.
  const during = await reset();
  const response = await running;
  const created = await chat.bindings.read('glm-chat');
  const after = await reset();
  const cleared = await chat.bindings.read('glm-chat');

  assert.equal(during.statusCode, 409, during.body);
  assert.equal(response.statusCode, 200, response.body);
  assert.ok(created.sessionId);
  assert.equal(after.statusCode, 200, after.body);
  assert.equal(cleared.sessionId, null);
  assert.ok(cleared.generation > created.generation);
});

test('вложения и дополнительные каталоги не расширяют запись, в ленте предупреждение', async (t) => {
  const f = await fixture(t);
  const steps = [];
  const result = await f.run({
    attachmentPaths: [path.join(f.root, 'attachment.png')],
    extraDirs: [f.other],
    onStep: (step) => steps.push(step),
  });
  const overlay = (await f.log()).length;

  assert.equal(result.reply, 'ok');
  assert.ok(overlay > 0);
  assert.ok(steps.some((step) => step.k === 'note' && step.level === 'warn'
    && /вложения/u.test(step.text) && /дополнительные каталоги/u.test(step.text)));
});

test('capability binding GLM видна чату', async (t) => {
  const f = await fixture(t);
  const chat = await chatFixture(t, f);
  const response = await chat.run();
  const binding = await chat.bindings.read('glm-chat');

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(f.adapter.workdir, { switch: 'reseed', roots: 'single' });
  assert.ok(binding.sessionId);
  assert.match(binding.authProfileId, /^glm-env-key:[a-f0-9]{16}$/u);
  assert.match(binding.securityProfile, /^grigdesk-glm-profile-v2:[a-f0-9]{64}$/u);
  assert.equal(binding.cwdRealpath, await fs.realpath(f.root));
});
