import assert from 'node:assert/strict';
import test from 'node:test';

import { MobileChatTurns } from '../../server/src/lib/mobile/chatTurns.ts';
import { registerMessageRoutes } from '../../server/src/lib/mobile/facade/chats.ts';
import {
  chatAppFixture,
  controlledExecutor,
  saveChat,
  turnBody,
  waitFor,
} from './helpers/chat-turns.js';
import { mobileFacadeFixture, mutation, testDevice } from './helpers/mobile-facade.js';

/**
 * API принимает ход через настоящий admission и тот же executor, что вебовый маршрут.
 * Второй Fastify представляет только мобильную границу, без своей очереди выполнения.
 */
async function setup(t, options = {}) {
  const controlled = controlledExecutor();
  const server = await chatAppFixture(t, {
    executor: controlled.executor,
    ...options,
  });

  await saveChat(server.app, 'mobile-turns');

  const deps = { chat: server.app.mobileChat };
  const mobile = await mobileFacadeFixture(t, (app) => registerMessageRoutes(app, deps));

  return {
    ...server,
    ...controlled,
    mobile: mobile.app,
    turns: new MobileChatTurns(server.app.mobileChat),
  };
}

test('MC-08/09/10/13: общий порядок, duplicate, конфликт текста и deliveries своего устройства',
  async (t) => {
  const { app, mobile, runs, waitForRuns, turns } = await setup(t);
  const input = {
    deviceId: testDevice.id,
    chatId: 'mobile-turns',
    clientId: 'client-first-001',
    text: 'Первый',
  };
  const first = await turns.send(input);

  assert.equal(first.status, 202);
  assert.equal(first.body.state, 'started');
  await waitForRuns(1);

  const repeated = await turns.send(input);

  assert.equal(repeated.body.duplicate, true);
  assert.equal(repeated.body.state, 'running');
  await assert.rejects(
    () =>
      turns.send({
        ...input,
        text: 'Другой',
      }),
    { code: 'delivery_conflict' },
  );
  await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('mobile-turns', 'web-middle', 'Веб'),
  });

  const accepted = await mutation(mobile, '/api/mobile/v1/chats/mobile-turns/messages', {
    text: 'Третий',
    clientId: 'client-third-001',
  });

  assert.equal(accepted.statusCode, 202);
  assert.equal(accepted.json().state, 'queued');
  runs[0].release('Первый итог');
  await waitForRuns(2);
  assert.ok(runs[1].options.message.startsWith('Веб\n'));
  runs[1].release('Веб итог');
  await waitForRuns(3);
  assert.ok(runs[2].options.message.startsWith('Третий\n'));
  runs[2].release('Третий итог');
  await waitFor(async () => (await app.inject('/api/chat/active')).json().active.length === 0);

  const delivery = (
    await mobile.inject(
      '/api/mobile/v1/chats/mobile-turns/deliveries' +
        '?ids=client-first-001,client-third-001,unknown-client-1',
    )
  ).json();

  assert.deepEqual(
    delivery.deliveries.map((entry) => entry.state),
    ['done', 'done', 'unknown'],
  );
  assert.equal(delivery.deliveries[0].outcome, 'reply');

  const stranger = await app.mobileChat.deliveries('d87654321', 'mobile-turns', [
    'client-first-001',
  ]);

  assert.equal(stranger[0].state, 'unknown');

  const done = await turns.send(input);

  assert.equal(done.body.state, 'done');
  assert.equal(runs.length, 3);
});

test('MC-08/11: ошибки preflight и стабильные id старой истории без PUT браузера', async (t) => {
  const { app, turns, runs } = await setup(t);

  await assert.rejects(
    () =>
      turns.send({
        deviceId: testDevice.id,
        chatId: 'mobile-turns',
        clientId: 'invalid-text-1',
        text: ' ',
      }),
    { code: 'bad_text' },
  );
  await assert.rejects(
    () =>
      turns.send({
        deviceId: testDevice.id,
        chatId: 'missing',
        clientId: 'missing-chat-1',
        text: 'Привет',
      }),
    { code: 'chat_not_found' },
  );
  await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        id: 'old-history',
        messages: [
          {
            role: 'user',
            text: 'Старое',
            mobileId: 'forged-id',
          },
        ],
      },
    },
  });

  const first = await app.mobileChat.read('old-history');
  const second = await app.mobileChat.read('old-history');

  assert.notEqual(first.messages[0].mobileId, 'forged-id');
  assert.equal(first.messages[0].mobileId, second.messages[0].mobileId);
  assert.equal(runs.length, 0);
});

test('MC-10/12: restart восстанавливает intent по owned ledger и не выполняет прерванный ход', async (t) => {
  const { app, root, config, turns, runs } = await setup(t);
  const { OperationJournal } = await import('../../server/src/lib/mobile/idempotency.ts');
  const { chatOperationProof, recoverChatOperation } =
    await import('../../server/src/lib/mobile/chatTurns.ts');
  const { ChatTurnLedger } = await import('../../server/src/lib/chat/turnLedger.ts');
  const { default: path } = await import('node:path');
  const clientId = 'crash-client-001';
  const deviceId = testDevice.id;
  const url = '/api/mobile/v1/chats/mobile-turns/messages';
  const body = {
    text: 'Принято до падения',
    clientId,
  };
  const directory = path.join(root, 'mobile-journal');
  const input = {
    method: 'POST',
    path: url,
    body,
    createdAt: Date.now(),
    proof: chatOperationProof(deviceId, url, body),
  };
  const first = new OperationJournal(directory);

  await assert.rejects(() =>
    first.run(deviceId, 'lost-http-result-1', input, async () => {
      await turns.send({
        deviceId,
        chatId: 'mobile-turns',
        ...body,
      });

      throw new Error('synthetic crash before operation result');
    }),
  );
  await app.close();

  const ledger = new ChatTurnLedger({ dir: path.join(config.chatsDir, 'turns') });

  await ledger.load();
  await ledger.update(input.proof.turnId, { state: 'running' });

  const recovered = await chatAppFixture(t, {
    root,
    executor: controlledExecutor().executor,
  });
  const restarted = new OperationJournal(directory, {
    recover: (device, proof) => recoverChatOperation(recovered.app.mobileChat, device, proof),
  });
  const result = await restarted.get(deviceId, 'lost-http-result-1');

  assert.equal(result.state, 'done');
  assert.equal(result.result.body.turnId, input.proof.turnId);
  assert.equal(result.result.body.state, 'done');
  assert.equal(result.result.body.duplicate, true);

  const delivery = await recovered.app.mobileChat.deliveries(deviceId, 'mobile-turns', [clientId]);

  assert.equal(delivery[0].outcome, 'interrupted');

  const chat = await recovered.app.mobileChat.read('mobile-turns');

  assert.equal(chat.messages.filter((message) => message.role === 'user').length, 1);
  assert.ok(chat.messages.some((message) => message.interruptedBy));
  assert.ok(runs.length <= 1);

  const mismatch = await recoverChatOperation(recovered.app.mobileChat, deviceId, {
    ...input.proof,
    contentHash: '0'.repeat(64),
  });

  assert.equal(mismatch, null);
});

test('MC-08: задачный чат использует свежий server-owned scope, отказ модели не пишет user', async (t) => {
  const { app, turns, waitForRuns, runs } = await setup(t, {
    taskEnv: { WORKSPACE_MODE: 'shared' },
  });
  const original = (await app.inject('/api/chat/store/chat/mobile-turns')).json().chat;

  await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        ...original,
        id: 'mobile-task',
        taskId: '101',
        revision: 0,
      },
    },
  });

  const accepted = await turns.send({
    deviceId: testDevice.id,
    chatId: 'mobile-task',
    text: 'По задаче',
    clientId: 'task-message-001',
  });

  assert.equal(accepted.status, 202);
  await waitForRuns(1);

  const { ChatTurnLedger } = await import('../../server/src/lib/chat/turnLedger.ts');
  const { default: path } = await import('node:path');
  const ledger = new ChatTurnLedger({ dir: path.join(runs[0].options.config.chatsDir, 'turns') });

  await ledger.load();
  assert.equal(ledger.get(accepted.body.turnId).workspace.taskId, '101');
  assert.equal(runs[0].options.cwd, ledger.get(accepted.body.turnId).workspace.cwd);
  runs[0].release('Задачный итог');
  await waitFor(async () => (await app.inject('/api/chat/active')).json().active.length === 0);

  const current = (await app.inject('/api/chat/store/chat/mobile-task')).json().chat;

  await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        ...current,
        modelRef: {
          provider: 'test-provider',
          model: 'unknown-model',
        },
        model: 'unknown-model',
      },
    },
  });

  const before = (await app.mobileChat.read('mobile-task')).messages.length;

  await assert.rejects(
    () =>
      turns.send({
        deviceId: testDevice.id,
        chatId: 'mobile-task',
        text: 'Не запускать',
        clientId: 'unavailable-model',
      }),
    {
      code: 'model_unavailable',
      status: 409,
    },
  );
  assert.equal((await app.mobileChat.read('mobile-task')).messages.length, before);
  assert.equal(runs.length, 1);
});

test('MC-09: задержка fresh history mobile не переставляет следующий web admission', async (t) => {
  const { app, turns, runs, waitForRuns } = await setup(t);
  const { ChatHistoryStore } = await import('../../server/src/lib/chat/historyStore.ts');
  const original = ChatHistoryStore.prototype.readOne;
  let release;
  let entered;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const inside = new Promise((resolve) => {
    entered = resolve;
  });
  let delayed = false;

  ChatHistoryStore.prototype.readOne = async function (id, ...args) {
    if (id === 'mobile-turns' && !delayed) {
      delayed = true;
      entered();
      await hold;
    }

    return original.call(this, id, ...args);
  };
  t.after(() => {
    ChatHistoryStore.prototype.readOne = original;
    release();
  });

  const mobile = turns.send({
    deviceId: testDevice.id,
    chatId: 'mobile-turns',
    clientId: 'ordered-mobile-1',
    text: 'Первый мобильный',
  });

  await inside;

  const web = app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('mobile-turns', 'ordered-web-001', 'Второй вебовый'),
  });

  release();
  assert.equal((await mobile).body.state, 'started');
  assert.equal((await web).json().state, 'queued');
  await waitForRuns(1);
  assert.ok(runs[0].message.startsWith('Первый мобильный'));
  runs[0].release('Первый итог');
  await waitForRuns(2);
  assert.ok(runs[1].message.startsWith('Второй вебовый'));
  runs[1].release('Второй итог');
});

test('MC-04: свежий и старый PUT сохраняют выданные сервером id legacy-сообщений', async (t) => {
  const { app } = await setup(t);

  await saveChat(app, 'legacy-ids', {
    messages: [
      {
        role: 'user',
        text: 'Повтор',
      },
      {
        role: 'assistant',
        text: 'Ответ',
      },
      {
        role: 'user',
        text: 'Повтор',
      },
    ],
  });

  const first = await app.mobileChat.read('legacy-ids');
  const ids = first.messages.map((message) => message.mobileId);

  await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: { chat: first },
  });

  const after = await app.mobileChat.read('legacy-ids');

  assert.deepEqual(
    after.messages.map((message) => message.mobileId),
    ids,
  );
  assert.equal(after.messages.length, 3);
  assert.equal(new Set(ids).size, 3);
  await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        ...first,
        revision: 0,
        messages: first.messages.map((message) => ({
          ...message,
          mobileId: 'forged',
        })),
      },
    },
  });
  assert.deepEqual(
    (await app.mobileChat.read('legacy-ids')).messages.map((message) => message.mobileId),
    ids,
  );
});

test('MC-12: legacy pendingSeed попадает в prompt один раз через общий claim/settle', async (t) => {
  const { app, turns, waitForRuns, runs } = await setup(t);
  const chat = (await app.inject('/api/chat/store/chat/mobile-turns')).json().chat;

  await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        ...chat,
        pendingSeed: 'UNIQUE_LEGACY_SUMMARY',
        sessionId: null,
      },
    },
  });
  await turns.send({
    deviceId: testDevice.id,
    chatId: 'mobile-turns',
    clientId: 'seed-first-001',
    text: 'Продолжение',
  });
  await waitForRuns(1);
  assert.equal(runs[0].message.split('UNIQUE_LEGACY_SUMMARY').length - 1, 1);
  runs[0].release('Первый итог');
  await waitFor(async () => (await app.inject('/api/chat/active')).json().active.length === 0);
  await turns.send({
    deviceId: testDevice.id,
    chatId: 'mobile-turns',
    clientId: 'seed-second-001',
    text: 'Следующий',
  });
  await waitForRuns(2);
  assert.equal(runs[1].message.includes('UNIQUE_LEGACY_SUMMARY'), false);
  runs[1].release('Второй итог');
});

test('MC-11: reset и обновление capabilities используют свежий workspaceKey', async (t) => {
  const { app, turns, runs, waitForRuns, executor } = await setup(t);
  const input = {
    deviceId: testDevice.id,
    chatId: 'mobile-turns',
    clientId: 'caps-first-001',
    text: 'Первый',
  };

  await turns.send(input);
  await waitForRuns(1);
  runs[0].release('Первый итог');
  await waitFor(async () => (await app.inject('/api/chat/active')).json().active.length === 0);
  executor.workdir = {
    switch: 'reseed',
    roots: 'single',
  };

  const reset = await app.inject({
    method: 'POST',
    url: '/api/chat/session/reset',
    payload: { chatKey: 'mobile-turns' },
  });

  assert.equal(reset.statusCode, 200, reset.body);

  const accepted = await turns.send({
    ...input,
    clientId: 'caps-second-001',
    text: 'После reset',
  });

  assert.equal(accepted.status, 202);
  await waitForRuns(2);
  runs[1].release('Свежий итог');
});

test('MC-11: старый durable chat продолжает сохранённую sessionId', async (t) => {
  const { app, turns, runs, waitForRuns } = await setup(t);

  await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        id: 'legacy-resume',
        modelRef: {
          provider: 'test-provider',
          model: 'test-model',
        },
        sessionId: 'previous-mobile',
        createdAt: Date.now(),
        messages: [
          {
            role: 'user',
            text: 'Старый вопрос',
          },
          {
            role: 'assistant',
            text: 'Старый ответ',
          },
        ],
      },
    },
  });
  await turns.send({
    deviceId: testDevice.id,
    chatId: 'legacy-resume',
    clientId: 'legacy-resume-001',
    text: 'Продолжение',
  });
  await waitForRuns(1);
  assert.equal(runs[0].options.sessionId, 'previous-mobile');
  runs[0].release('Продолженный итог');
});
