import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import deepseek from '../../server/src/lib/executors/deepseek.ts';
import { ensureTestDeepSeekBinaryPair } from '../helpers/deepseekBinary.mts';
import { glmBinaryFixture } from '../helpers/glmBinary.mts';
import { chatAppFixture } from './helpers/chat-turns.js';
import { ChatHistoryStore } from '../../server/src/lib/chat/historyStore.ts';
import { ChatSessionBindingStore } from '../../server/src/lib/chat/sessionBindingStore.ts';
import { inspectSessionJournal, sessionJournalDirectory } from '../../server/src/lib/deepseek/journal.ts';
import { glmChatHome } from '../../server/src/lib/glm/launch.ts';

/**
 * Общий HTTP-чат использует настоящий GLM adapter, binding sidecar и только loopback модель.
 * Barrier работает на входе run после security/CAS, не добавляя ветку по вендору в ядро.
 */
async function boundGlmChat(t, pair) {
  const f = await glmBinaryFixture(t, { pair });
  const selected = path.join(f.root, 'selected-binary');
  const modelRef = { provider: 'test-provider', model: f.model };
  const initialMessage = { role: 'user', text: 'Лента GLM остаётся на месте' };
  let beforeRun;
  let runs = 0;
  const executor = {
    ...f.adapter,
    id: 'test-provider',
    async run(input) {
      runs += 1;

      const prepared = await beforeRun?.(input);

      return f.adapter.run(prepared ?? input);
    },
  };

  await fs.symlink(pair.a.binary, selected);
  f.config.deepseekBin = selected;

  const g = await chatAppFixture(t, {
    root: f.cwd,
    executor,
    modelsRegistry: async () => ({ 'test-provider': [{ id: f.model, efforts: ['high'] }] }),
  });

  Object.assign(g.config, f.config, { rootDir: f.cwd });

  const saved = await g.app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: { chat: {
      id: 'bound-chat',
      modelRef,
      messages: [initialMessage],
      revision: 0,
    } },
  });

  assert.equal(saved.statusCode, 200, saved.body);

  return {
    ...f,
    app: g.app,
    config: g.config,
    events: g.events,
    selected,
    initialMessage,
    bindings: new ChatSessionBindingStore({ dir: g.config.chatBindingsDir }),
    history: new ChatHistoryStore({
      chatsDir: g.config.chatsDir,
      registryProvider: async () => ({ 'test-provider': [{ id: f.model, efforts: ['high'] }] }),
    }),
    barrier: (callback) => {
      beforeRun = callback;
    },
    runs: () => runs,
    turn: async (message) => {
      const preview = await g.app.inject({
        method: 'POST',
        url: '/api/chat/workdir/preview',
        payload: { chatKey: 'bound-chat' },
      });

      assert.equal(preview.statusCode, 200, preview.body);

      return g.app.inject({
        method: 'POST',
        url: '/api/chat',
        payload: {
          chatKey: 'bound-chat',
          modelRef,
          message,
          workspaceKey: preview.json().workspaceKey,
        },
      });
    },
  };
}

test('GLM binary сохраняет память при A→B→A и отвергает чужие prepared handles', {
  timeout: 900000,
}, async (t) => {
  const pair = await ensureTestDeepSeekBinaryPair();

  await t.test('A→B→A: та же sessionId, стабильный home и предыдущие сообщения на HTTP', async (subtest) => {
    const f = await glmBinaryFixture(subtest, { pair });
    const profileA = await f.adapter.sessionBinding.securityProfile(f.config);
    const first = await f.run({ message: 'glm-first-on-a' });

    f.config.deepseekBin = pair.b.binary;

    const profileB = await f.adapter.sessionBinding.securityProfile(f.config);
    const second = await f.run({ sessionId: first.sessionId, message: 'glm-second-on-b' });

    f.config.deepseekBin = pair.a.binary;

    const third = await f.run({ sessionId: second.sessionId, message: 'glm-third-on-a' });
    const home = path.join(f.config.glmRuntimeHome, 'chats',
      createHash('sha256').update('fixture-chat').digest('hex'));

    assert.equal(profileB, profileA);
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(third.sessionId, first.sessionId);
    assert.deepEqual(f.launches.map((launch) => launch.home), [home, home, home]);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(home, '.grigdesk-runtime.json'), 'utf8')), {
      format: 1,
      provider: 'glm',
    });
    assert.equal(f.mock.requests.length, 3);
    assert.match(JSON.stringify(f.mock.requests[1].payload.messages), /glm-first-on-a/u);
    assert.match(JSON.stringify(f.mock.requests[2].payload.messages), /glm-first-on-a/u);
    assert.match(JSON.stringify(f.mock.requests[2].payload.messages), /glm-second-on-b/u);

    const directory = sessionJournalDirectory(home, f.cwd, third.sessionId);

    await fs.rename(directory, `${directory}.saved`);
    await assert.rejects(f.run({ sessionId: third.sessionId }), { code: 'glm_session_missing' });
    assert.equal(f.mock.requests.length, 3);
  });

  await t.test('handle DeepSeek не принадлежит GLM, handle GLM не принадлежит DeepSeek', async (subtest) => {
    const f = await glmBinaryFixture(subtest, { pair });
    const foreign = await deepseek.prepareRuntime(f.config, { signal: AbortSignal.timeout(30000) });

    await assert.rejects(f.adapter.sessionBinding.securityProfile(f.config, {}, foreign), {
      code: 'glm_runtime_changed',
    });

    const own = await f.adapter.prepareRuntime(f.config, { signal: AbortSignal.timeout(30000) });

    assert.deepEqual(Object.keys(own), []);
    await assert.rejects(deepseek.sessionBinding.securityProfile(f.config, {}, own), {
      code: 'deepseek_runtime_changed',
    });
    assert.equal(f.mock.requests.length, 0);
  });

  await t.test('A→B после security/CAS до run: нет prompt/retry и изменений binding', async (subtest) => {
    const f = await boundGlmChat(subtest, pair);
    const first = await f.turn('glm-before-barrier');

    assert.equal(first.statusCode, 200, first.body);

    const before = await f.bindings.read('bound-chat');

    f.barrier(async () => {
      assert.deepEqual(await f.bindings.read('bound-chat'), before,
        'Barrier стоит после неизменившегося CAS');
      await fs.symlink(pair.b.binary, `${f.selected}.next`);
      await fs.rename(`${f.selected}.next`, f.selected);
    });

    const second = await f.turn('glm-must-not-send');

    assert.equal(second.statusCode, 500, second.body);
    assert.equal(second.json().error, 'glm_runtime_changed');
    assert.equal(f.runs(), 2, 'Два пользовательских хода, без автоматического повтора');
    assert.equal(f.mock.requests.length, 1);
    assert.deepEqual(await f.bindings.read('bound-chat'), before);

    f.barrier(undefined);

    const explicitNext = await f.turn('glm-explicit-next-on-b');

    assert.equal(explicitNext.statusCode, 200, explicitNext.body);
    assert.equal(explicitNext.json().sessionId, first.json().sessionId);
    assert.equal(f.mock.requests.length, 2);
    assert.match(JSON.stringify(f.mock.requests[1].payload.messages), /glm-before-barrier/u);
  });

  await t.test('v99: новая session через CAS, прежний файл/лента/seed сохранены', async (subtest) => {
    const f = await boundGlmChat(subtest, pair);
    const first = await f.turn('glm-before-v99');

    assert.equal(first.statusCode, 200, first.body);

    const before = await f.bindings.read('bound-chat');
    const home = glmChatHome(f.config.glmRuntimeHome, 'bound-chat');
    const journal = await inspectSessionJournal(home, f.cwd, before.sessionId, pair.a.info.journal.read);

    assert.equal(journal.state, 'readable');

    const future = path.join(path.dirname(journal.file),
      `session.v99.jsonl${journal.file.endsWith('.zstd') ? '.zstd' : ''}`);
    const bytes = await fs.readFile(journal.file);

    await fs.writeFile(future, bytes);
    await f.history.patchExecution('bound-chat', () => ({ pendingSeed: 'glm-pending-seed' }));
    f.barrier(async (input) => ({
      ...input,
      onSessionCreated: async (id) => {
        await input.onSessionCreated(id);

        const binding = await f.bindings.read('bound-chat');

        assert.notEqual(binding.sessionId, before.sessionId);
        assert.ok(binding.generation > before.generation);
        assert.equal(f.mock.requests.length, 1, 'Новая session записана до второго model call');
      },
    }));

    const second = await f.turn('glm-after-v99');

    assert.equal(second.statusCode, 200, second.body);
    assert.notEqual(second.json().sessionId, first.json().sessionId);
    assert.equal(f.mock.requests.length, 2);
    assert.deepEqual(await fs.readFile(future), bytes);
    assert.match(JSON.stringify(f.mock.requests[1].payload.messages), /glm-pending-seed/u);
    assert.match(JSON.stringify([second.json(), f.events]), /формат журнала несовместим/iu);

    const stored = (await f.app.inject('/api/chat/store/chat/bound-chat')).json().chat;

    assert.ok(stored.messages.some((message) => message.text === f.initialMessage.text));
  });
});
