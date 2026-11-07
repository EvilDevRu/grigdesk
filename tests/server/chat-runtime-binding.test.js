import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createNativeSettingsCapability } from '../../server/src/lib/executorSettings/capability.ts';
import { nativeSettingsContext } from '../../server/src/lib/executorSettings/context.ts';
import { ChatSessionBindingStore } from '../../server/src/lib/chat/sessionBindingStore.ts';
import { syntheticProvider } from '../fixtures/executor-settings/syntheticProvider.js';
import { chatAppFixture, saveChat } from './helpers/chat-turns.js';
import deepseek from '../../server/src/lib/executors/deepseek.ts';
import { resolveDeepSeekRuntimeAsync } from '../../server/src/lib/deepseek/runtimeProcess.ts';
import { startDeepSeekServer } from '../../server/src/lib/deepseek/serverRuntime.ts';
import { ensureTestDeepSeekBinaryPair } from '../helpers/deepseekBinary.mts';
import { startDeepSeekLoopback, writeDeepSeekLoopbackOverlay } from '../helpers/deepseekLoopback.mts';

test('optional runtime hook передаёт server-only handle в native context; старый адаптер работает',
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prepared-runtime-'));

    t.after(() => fs.rm(root, { recursive: true, force: true }));

    const handle = Object.freeze({ privateToken: Symbol('runtime') });
    const seen = [];
    const nativeSettings = createNativeSettingsCapability({
      id: 'runtime-test',
      bin: () => process.execPath,
      profile: () => ({
        transport: 'test',
        mode: 'default',
        identity: 'test',
      }),
      context: async (_config, cwd, _consumer, prepared) => {
        seen.push(prepared);

        return {
          providerId: 'runtime-test',
          binaryIdentity: 'fixture',
          profileFingerprint: 'fixture',
          transport: 'test',
          mode: 'default',
          cwdRealpath: cwd,
        };
      },
      discover: async () => {
        throw new Error('В этом тесте discovery не вызывается');
      },
    });
    const adapter = {
      id: 'runtime-test',
      bin: () => process.execPath,
      prepareRuntime: async (_config, { signal }) => {
        signal.throwIfAborted();

        return handle;
      },
      nativeSettings,
    };
    const prepared = await adapter.prepareRuntime({}, { signal: AbortSignal.timeout(1000) });

    await nativeSettingsContext(adapter, {}, root, 'chat', prepared);
    await nativeSettingsContext({ ...adapter, prepareRuntime: undefined }, {}, root, 'chat');

    assert.equal(seen[0], handle);
    assert.equal(seen[1], undefined);
  });

/**
 * Generic адаптер владеет opaque handles и проверяет их на каждой границе хода.
 * Настройки проходят настоящий prepare, HTTP, CAS binding и общий запуск без вендорной ветки.
 */
async function runtimeFixture(t, { native = true } = {}) {
  const handles = new WeakSet();
  const seen = [];
  const source = syntheticProvider();
  let prepares = 0;
  let replacement;
  let failure;
  const check = (handle, boundary) => {
    assert.ok(handle && handles.has(handle), `Чужой handle на границе ${boundary}`);
    seen.push({ boundary, handle });
  };
  const executor = {
    ...source,
    id: 'test-provider',
    /**
     * Создаёт принадлежащий этому адаптеру handle либо воспроизводит отказ подготовки.
     * Счётчик доказывает, что общий путь не готовит runtime повторно после settings.
     */
    async prepareRuntime(_config, { signal }) {
      signal.throwIfAborted();
      prepares += 1;

      if (failure) {
        throw failure;
      }
      if (replacement !== undefined) {
        return replacement;
      }

      const handle = Object.freeze({ serverSecret: 'runtime-secret-for-test' });

      handles.add(handle);

      return handle;
    },
    nativeSettings: {
      ...source.nativeSettings,
      async context(_config, cwd, _consumer, handle) {
        check(handle, 'context');

        return {
          providerId: 'test-provider',
          binaryIdentity: 'fixture',
          profileFingerprint: 'fixture',
          transport: 'test',
          mode: 'default',
          cwdRealpath: cwd,
        };
      },
    },
    sessionBinding: {
      authProfileId: () => 'test-account',
      securityProfile(_config, _settings, handle) {
        check(handle, 'security');

        return 'test-profile';
      },
    },
    /**
     * Запуск принимает только ранее подготовленный сервером объект своего адаптера.
     * Ранний session callback проходит настоящий CAS sidecar общего чата.
     */
    async run(options) {
      check(options.preparedRuntime, 'run');

      const sessionId = options.sessionId || 'test-session';

      await options.onSessionCreated?.(sessionId);

      return {
        reply: 'fixture-ok',
        sessionId,
        steps: [],
      };
    },
  };
  const saved = {
    'test-provider': {
      nativeSettings: {
        format: 1,
        revision: 1,
        overrides: { '["enabled"]': { path: ['enabled'], value: false } },
      },
    },
  };
  const fixture = await chatAppFixture(t, {
    executor,
    prefs: { providerSettings: native ? saved : {} },
  });

  await saveChat(fixture.app, 'runtime-chat');

  return {
    ...fixture,
    executor,
    seen,
    prepares: () => prepares,
    replace: (value) => {
      replacement = value;
    },
    fail: (value) => {
      failure = value;
    },
    turn: (_id, extra = {}) => fixture.app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: {
        chatKey: 'runtime-chat',
        modelRef: { provider: 'test-provider', model: 'test-model' },
        message: 'fixture-message',
        ...extra,
      },
    }),
  };
}

test('чат один раз готовит runtime и передаёт тот же handle в settings/security/run без HTTP утечки',
  async (t) => {
    const f = await runtimeFixture(t);
    const response = await f.turn('runtime-turn-1', { preparedRuntime: { forged: true } });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(f.prepares(), 1);
    assert.ok(f.seen.some((item) => item.boundary === 'context'));
    assert.deepEqual(f.seen.slice(-2).map((item) => item.boundary), ['security', 'run']);
    assert.equal(new Set(f.seen.map((item) => item.handle)).size, 1);

    const stored = await f.app.inject('/api/chat/store/chat/runtime-chat');
    const serialized = JSON.stringify([response.json(), stored.json(), f.events]);

    assert.equal(serialized.includes('runtime-secret-for-test'), false);
    assert.equal(serialized.includes('preparedRuntime'), false);
  });

test('без overrides prepareRuntime нужен до security; отказ и чужой handle не меняют binding', async (t) => {
  const f = await runtimeFixture(t, { native: false });

  assert.equal((await f.turn('runtime-empty-1')).statusCode, 200);
  assert.deepEqual(f.seen.map((item) => item.boundary), ['security', 'run']);

  const bindings = new ChatSessionBindingStore({ dir: f.config.chatBindingsDir });
  const before = await bindings.read('runtime-chat');

  f.fail(Object.assign(new Error('Runtime недоступен'), { code: 'test-provider_unavailable' }));

  const failed = await f.turn('runtime-empty-2');

  assert.equal(failed.statusCode, 503, failed.body);
  assert.deepEqual(await bindings.read('runtime-chat'), before);
  assert.equal(f.seen.filter((item) => item.boundary === 'run').length, 1);

  f.fail(undefined);
  f.replace(Object.freeze({ serverSecret: 'foreign' }));

  const foreign = await f.turn('runtime-empty-3');

  assert.equal(foreign.statusCode, 503, foreign.body);
  assert.deepEqual(await bindings.read('runtime-chat'), before);
  assert.equal(f.seen.filter((item) => item.boundary === 'run').length, 1);

  f.replace(null);

  const malformed = await f.turn('runtime-empty-4');

  assert.equal(malformed.statusCode, 503, malformed.body);
  assert.deepEqual(await bindings.read('runtime-chat'), before);
  assert.equal(f.seen.filter((item) => item.boundary === 'run').length, 1);
});

test('настоящая замена A→B после security/CAS до run сохраняет binding без prompt и retry', {
  timeout: 900000,
}, async (t) => {
  const { a, b } = await ensureTestDeepSeekBinaryPair();
  const mock = await startDeepSeekLoopback();

  t.after(() => mock.stop());
  assert.notEqual(a.info.packageId, b.info.packageId);

  await t.test('чужой handle/snapshot и изменённые bytes при прежнем packageId отвергаются',
    async (subtest) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-snapshot-'));

      subtest.after(() => fs.rm(root, { recursive: true, force: true }));

      const config = {
        deepseekRuntimeMode: 'binary',
        deepseekBin: path.join(root, 'binary'),
        deepseekCacheDir: a.cacheDir,
        deepseekRuntimeHome: path.join(root, 'home'),
      };

      await fs.copyFile(a.binary, config.deepseekBin);

      const handle = await deepseek.prepareRuntime(config, { signal: AbortSignal.timeout(30000) });
      const contextB = await deepseek.nativeSettings.context({ ...config, deepseekBin: b.binary }, root);

      assert.deepEqual(Object.keys(handle), []);
      await assert.rejects(deepseek.sessionBinding.securityProfile(config, {}, {}), {
        code: 'deepseek_runtime_changed',
      });
      await assert.rejects(deepseek.sessionBinding.securityProfile(
        { ...config, deepseekBin: b.binary }, {}, handle,
      ), { code: 'deepseek_runtime_changed' });
      await assert.rejects(deepseek.run({
        config,
        cwd: root,
        chatKey: 'snapshot-chat',
        preparedRuntime: handle,
        nativeSettings: { runtimeIdentity: contextB.runtimeIdentity, accepted: [] },
      }), { code: 'deepseek_runtime_changed' });
      await assert.rejects(fs.access(config.deepseekRuntimeHome), { code: 'ENOENT' });

      await fs.appendFile(config.deepseekBin, Buffer.from([0]));

      const changed = await resolveDeepSeekRuntimeAsync(config);

      assert.equal(changed.metadata.packageId, a.info.packageId, 'Публичная identity не изменилась');
      await assert.rejects(deepseek.sessionBinding.securityProfile(config, {}, handle), {
        code: 'deepseek_runtime_changed',
      });
    });

  for (const native of [false, true]) {
    await t.test(native ? 'после settings discovery' : 'без native overrides', async (subtest) => {
      let runs = 0;
      let starts = 0;
      let caught;
      let chosen;
      let testRoot;
      const executor = {
        ...deepseek,
        id: 'test-provider',
        /**
         * Barrier меняет выбранный ELF после общего security/CAS, прямо на входе run.
         * Настоящий web transport остаётся доступным только с loopback model endpoint.
         */
        async run(options) {
          runs += 1;
          await fs.symlink(b.binary, `${chosen}.next`);
          await fs.rename(`${chosen}.next`, chosen);

          try {
            return await deepseek.run({
              ...options,
              env: { PATH: process.env.PATH, DEEPSEEK_API_KEY: 'synthetic-loopback-key' },
              startServer: async (spec) => {
                starts += 1;

                const document = path.join(testRoot, 'loopback-settings.yaml');
                const generation = path.join(a.cacheDir, 'packages', a.info.packageId, 'generation');

                await fs.writeFile(document, '{}\n');

                const overlayPath = await writeDeepSeekLoopbackOverlay({
                  root: testRoot,
                  artifact: generation,
                  endpoint: mock.endpoint,
                  document,
                });

                return startDeepSeekServer({ ...spec, overlayPath });
              },
            });
          } catch (error) {
            caught = error;

            throw error;
          }
        },
      };
      const prefs = native ? {
        providerSettings: {
          'test-provider': {
            nativeSettings: {
              format: 1,
              revision: 1,
              overrides: { '["llm-deepseek","maxTokens"]': {
                path: ['llm-deepseek', 'maxTokens'],
                value: 64,
              } },
            },
          },
        },
      } : {};
      const f = await chatAppFixture(subtest, { executor, prefs });

      testRoot = f.root;
      chosen = path.join(f.root, 'chosen-binary');
      await fs.symlink(a.binary, chosen);
      Object.assign(f.config, {
        deepseekRuntimeMode: 'binary',
        deepseekBin: chosen,
        deepseekCacheDir: a.cacheDir,
        deepseekRuntimeHome: path.join(f.root, 'runtime-home'),
      });
      await saveChat(f.app, 'runtime-chat');

      const bindings = new ChatSessionBindingStore({ dir: f.config.chatBindingsDir });
      const before = await bindings.compareAndSwap({
        chatKey: 'runtime-chat',
        provider: 'test-provider',
        cwdRealpath: await fs.realpath(f.root),
        model: 'test-model',
        authProfileId: await deepseek.sessionBinding.authProfileId(f.config),
        securityProfile: await deepseek.sessionBinding.securityProfile(f.config, {
          blockDirectDb: false,
          strictUnknownDbClient: false,
        }),
        sessionId: 'previous-session',
      }, null);
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/chat',
        payload: {
          chatKey: 'runtime-chat',
          modelRef: { provider: 'test-provider', model: 'test-model' },
          message: 'fixture-message',
        },
      });

      assert.notEqual(response.statusCode, 200, response.body);
      assert.equal(runs, 1, 'Нет автоматического повторного запуска');
      assert.equal(caught?.code, 'deepseek_runtime_changed');
      assert.equal(starts, 0, 'Подмена отвергается до открытия web-процесса');
      assert.equal(mock.payloads.length, 0);
      assert.deepEqual(await bindings.read('runtime-chat'), before);
    });
  }
});
