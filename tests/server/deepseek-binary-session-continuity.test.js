import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import test from 'node:test';

import deepseek from '../../server/src/lib/executors/deepseek.ts';
import { ensureTestDeepSeekBinaryPair } from '../helpers/deepseekBinary.mts';
import { deepSeekProductionChatFixture } from '../helpers/deepseekChatParity.mjs';
import { chatAppFixture } from './helpers/chat-turns.js';
import { ChatSessionBindingStore } from '../../server/src/lib/chat/sessionBindingStore.ts';
import { sessionJournalDirectory } from '../../server/src/lib/deepseek/journal.ts';
import { chatHomeFor } from '../../server/src/lib/deepseek/env.ts';
import { ChatHistoryStore } from '../../server/src/lib/chat/historyStore.ts';

test('DeepSeek A→B→A сохраняет home, security profile, sessionId и память в model requests', {
  timeout: 900000,
}, async (t) => {
  const { a, b } = await ensureTestDeepSeekBinaryPair();
  const f = await deepSeekProductionChatFixture(t, undefined, { mode: 'binary', candidate: a });
  const profileA = await deepseek.sessionBinding.securityProfile(f.config);
  const first = await f.run({ message: 'continuity-first-on-a' });

  f.config.deepseekBin = b.binary;

  const profileB = await deepseek.sessionBinding.securityProfile(f.config);
  const second = await f.run({ sessionId: first.sessionId, message: 'continuity-second-on-b' });

  f.config.deepseekBin = a.binary;

  const third = await f.run({ sessionId: second.sessionId, message: 'continuity-third-on-a' });
  const home = path.join(f.config.deepseekRuntimeHome, 'chats',
    createHash('sha256').update('fixture-chat').digest('hex'));

  assert.equal(profileB, profileA, 'Версия поставки не меняет профиль прав');
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(third.sessionId, first.sessionId);
  assert.deepEqual(f.launches.map((launch) => launch.home), [home, home, home]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(home, '.grigdesk-runtime.json'), 'utf8')), {
    format: 1,
    provider: 'deepseek',
  });
  assert.equal(f.mock.payloads.length, 3);
  assert.match(JSON.stringify(f.mock.payloads[1].messages), /continuity-first-on-a/u);
  assert.match(JSON.stringify(f.mock.payloads[2].messages), /continuity-first-on-a/u);
  assert.match(JSON.stringify(f.mock.payloads[2].messages), /continuity-second-on-b/u);

  const directory = sessionJournalDirectory(home, f.cwd, third.sessionId);

  await fs.rename(directory, `${directory}.saved`);
  await assert.rejects(f.run({ sessionId: third.sessionId, message: 'Не теряй память молча' }), {
    code: 'deepseek_session_missing',
  });
  assert.equal(f.mock.payloads.length, 3, 'Отсутствующий журнал не начинает новый model call');
});

test('журнал v99 ротирует настоящую сессию через CAS до model call, сохраняя ленту и pendingSeed', {
  timeout: 900000,
}, async (t) => {
  const { a } = await ensureTestDeepSeekBinaryPair();
  const runtime = await deepSeekProductionChatFixture(t, undefined, { mode: 'binary', candidate: a });
  const model = '["deepseek-official","deepseek-v4-flash"]';
  let atModel;
  const executor = {
    ...deepseek,
    id: 'test-provider',
    run: (options) => deepseek.run({
      ...options,
      env: {
        PATH: process.env.PATH,
        HOME: runtime.root,
        DEEPSEEK_API_KEY: 'synthetic-loopback-key',
      },
      startServer: runtime.startServer,
    }),
  };
  const f = await chatAppFixture(t, {
    root: runtime.cwd,
    executor,
    modelsRegistry: async () => ({ 'test-provider': [{ id: model, efforts: ['off'] }] }),
  });

  Object.assign(f.config, runtime.config, { rootDir: runtime.cwd });

  const bindings = new ChatSessionBindingStore({ dir: f.config.chatBindingsDir });
  const firstMessage = { role: 'user', text: 'Лента должна остаться' };
  const saved = await f.app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: { chat: {
      id: 'journal-chat',
      modelRef: { provider: 'test-provider', model },
      messages: [firstMessage],
      revision: 0,
    } },
  });

  assert.equal(saved.statusCode, 200, saved.body);

  const turn = async (message) => {
    const preview = await f.app.inject({
      method: 'POST',
      url: '/api/chat/workdir/preview',
      payload: { chatKey: 'journal-chat' },
    });

    assert.equal(preview.statusCode, 200, preview.body);

    return f.app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: {
        chatKey: 'journal-chat',
        modelRef: { provider: 'test-provider', model },
        effort: 'off',
        workspaceKey: preview.json().workspaceKey,
        message,
      },
    });
  };
  const first = await turn('journal-first-turn');

  assert.equal(first.statusCode, 200, first.body);

  const before = await bindings.read('journal-chat');
  const history = new ChatHistoryStore({
    chatsDir: f.config.chatsDir,
    registryProvider: async () => ({ 'test-provider': [{ id: model, efforts: ['off'] }] }),
  });

  await history.patchExecution('journal-chat', () => ({ pendingSeed: 'pending-journal-seed' }));
  assert.equal((await f.app.inject('/api/chat/store/chat/journal-chat')).json().chat.pendingSeed,
    'pending-journal-seed');

  const home = chatHomeFor(f.config.deepseekRuntimeHome, 'journal-chat', 'stable');
  const directory = sessionJournalDirectory(home, runtime.cwd, before.sessionId);
  const current = (await fs.readdir(directory)).find((name) => /^session\.v3\.jsonl(?:\.zstd)?$/u.test(name));

  assert.ok(current, 'Fixture создала настоящий текущий журнал');

  const future = path.join(directory, `session.v99.jsonl${current.endsWith('.zstd') ? '.zstd' : ''}`);
  const futureBytes = await fs.readFile(path.join(directory, current));

  await fs.writeFile(future, futureBytes);

  const previousStart = runtime.startServer;

  // На втором запуске callback модели наблюдает sidecar после раннего onSessionCreated.
  // Реальный loopback сохраняет payload; факт CAS дополнительно проверяется перед prompt.
  executor.run = (options) => deepseek.run({
    ...options,
    env: {
      PATH: process.env.PATH,
      HOME: runtime.root,
      DEEPSEEK_API_KEY: 'synthetic-loopback-key',
    },
    startServer: previousStart,
    onSessionCreated: async (id) => {
      await options.onSessionCreated(id);
      atModel = await bindings.read('journal-chat');
      assert.notEqual(atModel.sessionId, before.sessionId);
      assert.equal(runtime.mock.payloads.length, 1, 'CAS предшествует второму model call');
    },
  });

  const second = await turn('journal-second-turn');

  assert.equal(second.statusCode, 200, second.body);
  assert.equal(runtime.mock.payloads.length, 2);
  assert.notEqual(second.json().sessionId, first.json().sessionId);
  assert.equal(atModel.sessionId, second.json().sessionId);
  assert.ok(atModel.generation > before.generation);
  assert.deepEqual(await fs.readFile(future), futureBytes);
  assert.match(JSON.stringify(runtime.mock.payloads[1].messages), /pending-journal-seed/u);
  assert.match(JSON.stringify([second.json(), f.events]), /формат журнала несовместим/iu);

  const after = (await f.app.inject('/api/chat/store/chat/journal-chat')).json().chat;

  assert.ok(after.messages.some((message) => message.text === firstMessage.text));
});
