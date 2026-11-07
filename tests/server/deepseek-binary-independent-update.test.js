import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import deepseek from '../../server/src/lib/executors/deepseek.ts';
import { createGlmAdapter } from '../../server/src/lib/executors/glm.ts';
import { preparedDeepSeekRuntime } from '../../server/src/lib/deepseek/preparedRuntime.ts';
import { preparedGlmRuntime } from '../../server/src/lib/glm/preparedRuntime.ts';
import { ChatSessionBindingStore } from '../../server/src/lib/chat/sessionBindingStore.ts';
import { sha256File } from '../../shared/node/hash.ts';
import { ensureTestAdmittedDeepSeekBinaryPair } from '../helpers/deepseekBinary.mts';
import { deepSeekProductionChatFixture } from '../helpers/deepseekChatParity.mjs';
import { glmBinaryFixture } from '../helpers/glmBinary.mts';
import { chatAppFixture } from './helpers/chat-turns.js';

const execute = promisify(execFile);
const repository = path.resolve(import.meta.dirname, '../..');

/**
 * Установка и откат выполняются публичной CLI, без DI установщика и без symlink target.
 * Host contract принадлежит неизменному потребителю; disposable releases не касаются рабочего bin.
 */
async function install(candidate, target, root) {
  const result = await execute(process.execPath, [path.join(repository, 'deepseek/scripts/install.mts'),
    '--binary', candidate.binary,
    '--target', target,
    '--host-contract', path.join(repository, 'server/deepseek-host-contract.json'),
    '--releases-dir', path.join(root, 'releases'),
  ], {
    env: { PATH: process.env.PATH, HOME: root },
    timeout: 180000,
    maxBuffer: 65536,
  });

  assert.equal(result.stderr, '');

  const receipt = JSON.parse(result.stdout);

  assert.equal(receipt.packageId, candidate.info.packageId);
  assert.notEqual(receipt.memory, 'resets');

  return receipt;
}

/**
 * Снимок реального server source и lock доказывает, что installer менял только ELF.
 * PID и start marker проверяются на том же Fastify instance после всех замен.
 */
async function serverFingerprint() {
  return Promise.all([
    'server/package-lock.json',
    'server/src/modules/chat/index.ts',
    'server/src/lib/executors/deepseek.ts',
    'server/src/lib/executors/glm.ts',
  ].map((file) => sha256File(path.join(repository, file))));
}

for (const provider of ['deepseek', 'glm']) {
  test(`независимая установка ${provider}: один сервер, реальный ELF и совместимая память`, {
    timeout: 900000,
  }, async (t) => {
    const pair = await ensureTestAdmittedDeepSeekBinaryPair();
    const arrived = Promise.withResolvers();
    const release = Promise.withResolvers();
    const runtime = provider === 'deepseek'
      ? await deepSeekProductionChatFixture(t, { respond: async (_payload, index) => {
        if (index === 0) {
          arrived.resolve();
          await release.promise;
        }

        return { deltas: [{ role: 'assistant', content: 'installed-binary-ok' }] };
      } }, { mode: 'binary', candidate: pair.a })
      : await glmBinaryFixture(t, { pair });
    const target = path.join(runtime.root, 'bin', 'deepseek');
    const model = provider === 'deepseek' ? '["deepseek-official","deepseek-v4-flash"]' : runtime.model;
    const descriptors = [];
    const originalSources = await serverFingerprint();
    const serverPid = process.pid;
    const startMarker = `${process.pid}:${process.uptime()}`;
    const adapter = provider === 'deepseek' ? deepseek
      : createGlmAdapter({ ...runtime.deps, admission: undefined });
    const executor = {
      ...adapter,
      id: 'test-provider',
      /**
       * Наблюдается тот же закреплённый descriptor, который получает реальный adapter.
       * Запись packageId не заменяет запуск процесса и не меняет выбор runtime.
       */
      async run(input) {
        const descriptor = await (provider === 'deepseek' ? preparedDeepSeekRuntime : preparedGlmRuntime)(
          input.config, input.preparedRuntime,
        );

        descriptors.push({ packageId: descriptor.metadata.packageId, chatKey: input.chatKey });

        return provider === 'deepseek' ? deepseek.run({
          ...input,
          env: {
            PATH: process.env.PATH,
            HOME: runtime.root,
            DEEPSEEK_API_KEY: 'synthetic-loopback-key',
          },
          startServer: runtime.startServer,
        }) : adapter.run(input);
      },
    };

    t.after(() => release.resolve());
    assert.notEqual(pair.a.info.packageId, pair.b.info.packageId);
    assert.deepEqual(pair.a.info.glm, pair.b.info.glm);
    await fs.mkdir(path.dirname(target), { mode: 0o700 });
    await install(pair.a, target, runtime.root);
    runtime.config.deepseekBin = target;

    const f = await chatAppFixture(t, {
      root: runtime.cwd,
      executor,
      modelsRegistry: async () => ({ 'test-provider': [{ id: model, efforts: ['off', 'high'] }] }),
    });
    const serverInstance = f.app;

    Object.assign(f.config, runtime.config, { rootDir: runtime.cwd });
    f.app.independentStartMarker = startMarker;

    const bindings = new ChatSessionBindingStore({ dir: f.config.chatBindingsDir });
    const payloads = () => provider === 'deepseek' ? runtime.mock.payloads
      : runtime.mock.requests.map((request) => request.payload);

    for (const chatKey of ['main-chat', 'parallel-chat']) {
      const saved = await f.app.inject({
        method: 'PUT',
        url: '/api/chat/store/chat',
        payload: { chat: {
          id: chatKey,
          modelRef: { provider: 'test-provider', model },
          messages: [],
          revision: 0,
        } },
      });

      assert.equal(saved.statusCode, 200, saved.body);
    }

    const turn = (chatKey, message) => f.app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: {
        chatKey,
        modelRef: { provider: 'test-provider', model },
        message,
        effort: provider === 'deepseek' ? 'off' : 'high',
      },
    });
    const firstRun = turn('main-chat', 'first-on-installed-a');
    let first;
    let parallel;

    if (provider === 'deepseek') {
      firstRun.catch(arrived.reject);
      await arrived.promise;
      await install(pair.b, target, runtime.root);
      parallel = await turn('parallel-chat', 'parallel-on-installed-b');
      assert.equal(parallel.statusCode, 200, parallel.body);
      assert.equal(descriptors[0].packageId, pair.a.info.packageId);
      assert.equal(descriptors[1].packageId, pair.b.info.packageId);
      release.resolve();
      first = await firstRun;
    } else {
      first = await firstRun;
      await install(pair.b, target, runtime.root);
    }

    assert.equal(first.statusCode, 200, first.body);

    const second = await turn('main-chat', 'second-on-installed-b');

    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().sessionId, first.json().sessionId);
    assert.equal(descriptors.at(-1).packageId, pair.b.info.packageId);
    assert.match(JSON.stringify(payloads().at(-1).messages), /first-on-installed-a/u);
    await install(pair.a, target, runtime.root);

    const third = await turn('main-chat', 'third-on-installed-a');

    assert.equal(third.statusCode, 200, third.body);
    assert.equal(third.json().sessionId, first.json().sessionId);
    assert.equal(descriptors.at(-1).packageId, pair.a.info.packageId);
    assert.match(JSON.stringify(payloads().at(-1).messages), /second-on-installed-b/u);

    if (parallel) {
      const resumed = await turn('parallel-chat', 'parallel-back-on-a');

      assert.equal(resumed.statusCode, 200, resumed.body);
      assert.equal(resumed.json().sessionId, parallel.json().sessionId);
      assert.match(JSON.stringify(payloads().at(-1).messages), /parallel-on-installed-b/u);
    }

    const away = `${target}.temporary-away`;
    const callsBefore = payloads().length;

    await fs.rename(target, away);

    const missing = await turn('main-chat', 'must-not-reach-model');

    assert.notEqual(missing.statusCode, 200);
    assert.equal(payloads().length, callsBefore);
    await fs.rename(away, target);

    const recovered = await turn('main-chat', 'restored-without-restart');

    assert.equal(recovered.statusCode, 200, recovered.body);
    assert.equal(recovered.json().sessionId, first.json().sessionId);
    assert.equal((await bindings.read('main-chat')).sessionId, first.json().sessionId);
    assert.equal(f.app, serverInstance);
    assert.equal(process.pid, serverPid);
    assert.equal(f.app.independentStartMarker, startMarker);
    assert.deepEqual(await serverFingerprint(), originalSources);
    assert.deepEqual(new Set(descriptors.map((entry) => entry.packageId)),
      new Set([pair.a.info.packageId, pair.b.info.packageId]));

    console.log(JSON.stringify({
      scenario: provider,
      packageIds: [pair.a.info.packageId, pair.b.info.packageId],
      sameServer: true,
      sameSession: true,
      sourcesUnchanged: true,
    }));
  });
}
