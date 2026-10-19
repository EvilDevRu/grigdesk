import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { adoptLegacyChatHome } from '../../server/src/lib/deepseek/legacyCutover.ts';
import { ChatSessionBindingStore } from '../../server/src/lib/chat/sessionBindingStore.ts';
import { installedLegacyBuildId } from '../../server/src/lib/deepseek/legacyCutover.ts';
import { createHash } from 'node:crypto';
import deepseek, { deepSeekSecurityProfile } from '../../server/src/lib/executors/deepseek.ts';
import { GLM_PROFILE_REVISION } from '../../server/src/lib/glm/contract.ts';
import { chatHomeFor } from '../../server/src/lib/deepseek/env.ts';
import { glmChatHome } from '../../server/src/lib/glm/launch.ts';
import { ensureTestDeepSeekBinary } from '../helpers/deepseekBinary.mts';
import { ensureTestDeepSeekArtifact } from '../helpers/deepseekRuntimeArtifact.mts';
import { deepSeekProductionChatFixture } from '../helpers/deepseekChatParity.mjs';
import { glmBinaryFixture } from '../helpers/glmBinary.mts';
import { seedLegacySession } from '../helpers/deepseekLegacySession.mjs';
import { chatAppFixture } from './helpers/chat-turns.js';

test('home переносится один раз, соседняя identity и существующий новый home не меняются', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-home-cutover-'));
  const legacyDirectory = path.join(root, 'legacy', 'selected', 'chat-home');
  const neighbor = path.join(root, 'legacy', 'other', 'chat-home');
  const directory = path.join(root, 'chats', 'chat-home');

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(legacyDirectory, { recursive: true });
  await fs.mkdir(neighbor, { recursive: true });
  await fs.writeFile(path.join(legacyDirectory, 'journal'), 'old-session-bytes');
  await fs.writeFile(path.join(neighbor, 'journal'), 'neighbor-session-bytes');

  const inode = (await fs.stat(legacyDirectory)).ino;
  const options = {
    directory,
    legacyDirectory,
    provider: 'deepseek',
    legacyIdentity: 'a'.repeat(64)
  };

  await adoptLegacyChatHome(options);
  assert.equal((await fs.stat(directory)).ino, inode, 'перенос rename, без копирования журнала');
  assert.equal(await fs.readFile(path.join(directory, 'journal'), 'utf8'), 'old-session-bytes');
  assert.equal(await fs.readFile(path.join(neighbor, 'journal'), 'utf8'), 'neighbor-session-bytes');
  await assert.rejects(fs.access(legacyDirectory));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, '.grigdesk-runtime.json'), 'utf8')), {
    format: 1,
    provider: 'deepseek',
  });
  await fs.mkdir(legacyDirectory, { recursive: true });
  await fs.writeFile(path.join(legacyDirectory, 'journal'), 'legacy-remains-untouched');
  await adoptLegacyChatHome(options);
  assert.equal(await fs.readFile(path.join(directory, 'journal'), 'utf8'), 'old-session-bytes');
  assert.equal(await fs.readFile(path.join(legacyDirectory, 'journal'), 'utf8'), 'legacy-remains-untouched');
});
/**
 * Допуск прежней формулы не разрешает перенос сессии между моделями, ключами и папками.
 * CAS также сохраняет прежний контроль generation при одновременном переносе.
 */
test('CAS принимает только смену известного legacy security profile при той же identity', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cutover-binding-'));
  const store = new ChatSessionBindingStore({ dir: root });
  const identity = {
    chatKey: 'chat',
    provider: 'test-provider',
    cwdRealpath: root,
    model: 'model',
    authProfileId: 'key',
    securityProfile: 'legacy-profile',
    sessionId: 'same-session',
  };

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const original = await store.compareAndSwap(identity);
  const wanted = { ...identity, securityProfile: 'stable-profile' };

  for (const [field, changed] of Object.entries({
    provider: 'other',
    cwdRealpath: path.join(root, 'other'),
    model: 'other',
    authProfileId: 'other',
  })) {
    await assert.rejects(store.compareAndSwap({ ...wanted, [field]: changed }, original.generation, {
      legacySecurityProfiles: ['legacy-profile'],
    }), { code: 'binding_identity_changed' });
  }

  await assert.rejects(store.compareAndSwap(wanted, original.generation), {
    code: 'binding_identity_changed',
  });

  const adopted = await store.compareAndSwap(wanted, original.generation, {
    legacySecurityProfiles: ['legacy-profile'],
  });

  assert.equal(adopted.sessionId, original.sessionId);
  assert.equal(adopted.securityProfile, 'stable-profile');
  assert.equal(adopted.generation, original.generation + 1);
  await assert.rejects(store.compareAndSwap(wanted, original.generation, {
    legacySecurityProfiles: ['legacy-profile'],
  }), { code: 'stale_binding_generation' });
});
/**
 * Новый ELF может иметь другой buildId из-за путей компилятора.
 * Источник прежней памяти — только current целевой установки с проверенным заголовком.
 */
test('legacy current: identity, чужая ссылка и повреждённый header', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cutover-current-'));
  const generationRoot = path.join(root, 'runtime');
  const buildId = 'c'.repeat(64);
  const generation = path.join(generationRoot, 'builds', buildId);
  const config = { deepseekGenerationRoot: generationRoot };

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal(await installedLegacyBuildId(config), null);
  await fs.mkdir(generation, { recursive: true });
  await fs.writeFile(path.join(generation, 'runtime.json'), JSON.stringify({ format: 1, buildId }));
  await fs.symlink(`builds/${buildId}`, path.join(generationRoot, 'current'));
  assert.equal(await installedLegacyBuildId(config), buildId);
  await fs.writeFile(path.join(generation, 'runtime.json'), JSON.stringify({
    format: 1, buildId: 'd'.repeat(64),
  }));
  await assert.rejects(installedLegacyBuildId(config));
  await fs.rm(path.join(generationRoot, 'current'));
  await fs.symlink(root, path.join(generationRoot, 'current'));
  await assert.rejects(installedLegacyBuildId(config));
});
/**
 * Сохранённые legacy формулы взяты из последнего embedded адаптера до cutover.
 * Они не содержат новых endpoint/policy полей, иначе старый binding не был бы найден.
 */
function legacyGlmProfile(identity, settings = {}) {
  const fingerprint = createHash('sha256').update(JSON.stringify({
    profile: GLM_PROFILE_REVISION,
    identity,
    mode: 'api',
    ssh: settings.blockDirectSsh !== false,
    db: settings.blockDirectDb === true,
    strictDb: settings.strictUnknownDbClient === true,
  })).digest('hex');

  return `${GLM_PROFILE_REVISION}:${fingerprint}`;
}

for (const provider of ['deepseek', 'glm']) {
  test(`настоящий ${provider}: legacy Node22 → ELF сохраняет sessionId, CAS и память модели`, {
    timeout: 900000,
  }, async (t) => {
    const candidate = await ensureTestDeepSeekBinary();
    const artifact = await ensureTestDeepSeekArtifact();
    const metadata = JSON.parse(await fs.readFile(path.join(artifact, 'runtime.json'), 'utf8'));
    const runtime = provider === 'deepseek'
      ? await deepSeekProductionChatFixture(t, undefined, { mode: 'binary', candidate })
      : await glmBinaryFixture(t, { pair: { a: candidate, b: candidate } });
    const chatKey = 'cutover-chat';
    const model = provider === 'deepseek' ? '["deepseek-official","deepseek-v4-flash"]' : runtime.model;
    const compatibility = runtime.deps?.admission[0].compatibility;
    const runtimeHome = provider === 'deepseek' ? runtime.config.deepseekRuntimeHome
      : runtime.config.glmRuntimeHome;
    const oldHome = provider === 'deepseek'
      ? chatHomeFor(path.join(runtimeHome, 'generations', metadata.buildId), chatKey)
      : glmChatHome(runtimeHome, compatibility, chatKey);
    const newHome = chatHomeFor(runtimeHome, chatKey, 'stable');
    const neighbor = provider === 'deepseek'
      ? chatHomeFor(path.join(runtimeHome, 'generations', candidate.info.buildId), chatKey)
      : glmChatHome(runtimeHome, 'f'.repeat(64), chatKey);

    assert.notEqual(metadata.buildId, candidate.info.buildId, 'Fixture различает legacy и binary buildId');
    await fs.mkdir(neighbor, { recursive: true });
    await fs.writeFile(path.join(neighbor, 'sentinel'), 'other-identity');

    const seed = await seedLegacySession({
      root: runtime.root,
      cwd: runtime.cwd,
      home: oldHome,
      endpoint: runtime.mock.endpoint,
      provider,
      model,
      env: runtime.deps?.env ?? {
        PATH: process.env.PATH,
        HOME: runtime.root,
        DEEPSEEK_API_KEY: 'synthetic-loopback-key',
      },
    });
    const inode = (await fs.stat(oldHome)).ino;
    const generationRoot = path.join(runtime.root, 'installed-runtime');
    const installed = path.join(generationRoot, 'builds', metadata.buildId);

    await fs.mkdir(installed, { recursive: true });
    await fs.writeFile(path.join(installed, 'runtime.json'), JSON.stringify(metadata));
    await fs.symlink(`builds/${metadata.buildId}`, path.join(generationRoot, 'current'));
    runtime.config.deepseekGenerationRoot = generationRoot;

    const adapter = provider === 'deepseek' ? deepseek : runtime.adapter;
    const executor = {
      ...adapter,
      id: 'test-provider',
      run: (input) => provider === 'deepseek' ? deepseek.run({
        ...input,
        env: {
          PATH: process.env.PATH,
          HOME: runtime.root,
          DEEPSEEK_API_KEY: 'synthetic-loopback-key'
        },
        startServer: runtime.startServer,
      }) : adapter.run(input),
    };
    const f = await chatAppFixture(t, {
      root: runtime.cwd,
      executor,
      modelsRegistry: async () => ({ 'test-provider': [{ id: model, efforts: ['off', 'high'] }] }),
    });

    Object.assign(f.config, runtime.config, { rootDir: runtime.cwd });

    const saved = await f.app.inject({
      method: 'PUT',
      url: '/api/chat/store/chat',
      payload: {
        chat: {
          id: chatKey,
          modelRef: { provider: 'test-provider', model },
          messages: [{ role: 'user', text: `legacy-${provider}-first-prompt` }],
          revision: 0,
        }
      },
    });

    assert.equal(saved.statusCode, 200, saved.body);

    const bindings = new ChatSessionBindingStore({ dir: f.config.chatBindingsDir });
    const original = await bindings.compareAndSwap({
      chatKey,
      provider: 'test-provider',
      cwdRealpath: await fs.realpath(runtime.cwd),
      model,
      authProfileId: await adapter.sessionBinding.authProfileId(f.config),
      securityProfile: provider === 'deepseek'
        ? deepSeekSecurityProfile({}, `deepseek-build:${metadata.buildId}`)
        : legacyGlmProfile(compatibility),
      sessionId: seed.sessionId,
    });
    const preview = await f.app.inject({
      method: 'POST',
      url: '/api/chat/workdir/preview',
      payload: { chatKey },
    });

    assert.equal(preview.statusCode, 200, preview.body);

    const turn = (message) => f.app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: {
        chatKey,
        modelRef: { provider: 'test-provider', model },
        workspaceKey: preview.json().workspaceKey,
        message,
        effort: provider === 'glm' ? 'high' : 'off',
      },
    });
    const payloads = () => provider === 'deepseek' ? runtime.mock.payloads
      : runtime.mock.requests.map((request) => request.payload);
    const response = await turn('first-on-binary');

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().sessionId, seed.sessionId);
    assert.equal((await bindings.read(chatKey)).sessionId, original.sessionId);
    assert.equal((await bindings.read(chatKey)).securityProfile,
      await adapter.sessionBinding.securityProfile(f.config));
    assert.equal((await fs.stat(newHome)).ino, inode);
    await assert.rejects(fs.access(oldHome));
    assert.equal(await fs.readFile(path.join(neighbor, 'sentinel'), 'utf8'), 'other-identity');
    assert.equal(payloads().length, 2);

    assert.match(JSON.stringify(payloads()[1].messages), new RegExp(`legacy-${provider}-first-prompt`));

    assert.doesNotMatch(JSON.stringify(f.events), /профиль исполнителя изменился|память.*заново/iu);

    const repeated = await turn('second-on-binary');

    assert.equal(repeated.statusCode, 200, repeated.body);
    assert.equal(repeated.json().sessionId, seed.sessionId);
    assert.equal((await fs.stat(newHome)).ino, inode);
    assert.match(JSON.stringify(payloads()[2].messages), /first-on-binary/u);
  });
}

/**
 * Прерывание после rename восстанавливает только marker, не переписывая журнал.
 * Чужие marker и ссылки отвергаются до перемещения исходной памяти.
 */
test('cutover recovery завершает receipt; ссылки и marker другой identity закрыты', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cutover-recovery-'));
  const directory = path.join(root, 'new');
  const legacyDirectory = path.join(root, 'old');
  const options = {
    directory,
    legacyDirectory,
    provider: 'deepseek',
    legacyIdentity: 'a'.repeat(64),
  };
  const receipt = `${directory}.cutover.json`;

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(legacyDirectory);
  await fs.writeFile(path.join(legacyDirectory, 'journal'), 'memory');
  await fs.writeFile(path.join(legacyDirectory, '.grigdesk-runtime.json'), JSON.stringify({
    buildId: 'b'.repeat(64),
    journalFormat: 1,
  }));
  await assert.rejects(adoptLegacyChatHome(options), /другой identity/u);
  assert.equal(await fs.readFile(path.join(legacyDirectory, 'journal'), 'utf8'), 'memory');
  await fs.rm(path.join(legacyDirectory, '.grigdesk-runtime.json'));
  await fs.symlink(path.join(legacyDirectory, 'journal'),
    path.join(legacyDirectory, '.grigdesk-runtime.json'));
  await assert.rejects(adoptLegacyChatHome(options), /ссылкой/u);
  await fs.rm(path.join(legacyDirectory, '.grigdesk-runtime.json'));
  await fs.writeFile(receipt, JSON.stringify(options), { mode: 0o600 });
  await fs.rename(legacyDirectory, directory);
  await adoptLegacyChatHome(options);
  await assert.rejects(fs.access(receipt));
  assert.equal(await fs.readFile(path.join(directory, 'journal'), 'utf8'), 'memory');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, '.grigdesk-runtime.json'), 'utf8')), {
    format: 1,
    provider: 'deepseek',
  });
});

/**
 * Контракт ядра общий: ни смена модели, ни новых прав не принимают старый sessionId.
 * Отсутствие hook сохраняет обычную ротацию существующих адаптеров.
 */
test('HTTP cutover сохраняет только прежнюю формулу: модель и права ротируют сессию', async (t) => {
  for (const scenario of ['same', 'model', 'rights', 'no-hook']) {
    await t.test(scenario, async (subtest) => {
      const changedRights = scenario === 'rights';
      const executor = {
        id: 'test-provider',
        workdir: { switch: 'reseed', roots: 'single' },
        sessionBinding: {
          authProfileId: () => 'same-auth',
          securityProfile: () => changedRights ? 'new-rights' : 'stable',
          ...(scenario !== 'no-hook' ? {
            legacySecurityProfiles: () => changedRights ? ['legacy-new-rights'] : ['legacy'],
          } : {}),
        },
        async run(input) {
          const sessionId = input.sessionId || 'rotated-session';

          await input.onSessionCreated(sessionId);

          return {
            reply: 'ok',
            sessionId,
            steps: [],
          };
        },
      };
      const f = await chatAppFixture(subtest, {
        executor,
        modelsRegistry: async () => ({ 'test-provider': [
          { id: 'model-a', efforts: [] },
          { id: 'model-b', efforts: [] },
        ] }),
      });
      const bindings = new ChatSessionBindingStore({ dir: f.config.chatBindingsDir });
      const model = scenario === 'model' ? 'model-b' : 'model-a';

      await f.app.inject({
        method: 'PUT',
        url: '/api/chat/store/chat',
        payload: { chat: {
          id: 'generic-cutover',
          modelRef: { provider: 'test-provider', model },
          messages: [],
          revision: 0,
        } },
      });
      await bindings.compareAndSwap({
        chatKey: 'generic-cutover',
        provider: 'test-provider',
        cwdRealpath: await fs.realpath(f.root),
        model: 'model-a',
        authProfileId: 'same-auth',
        securityProfile: 'legacy',
        sessionId: 'legacy-session',
      });

      const response = await f.app.inject({
        method: 'POST',
        url: '/api/chat',
        payload: {
          chatKey: 'generic-cutover',
          modelRef: { provider: 'test-provider', model },
          message: 'continue',
        },
      });

      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().sessionId, scenario === 'same' ? 'legacy-session' : 'rotated-session');
      assert.equal((await bindings.read('generic-cutover')).sessionId, response.json().sessionId);
    });
  }
});
