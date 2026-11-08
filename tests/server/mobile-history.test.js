import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ChatHistoryStore } from '../../server/src/lib/chat/historyStore.ts';
import { ChatTurnLedger } from '../../server/src/lib/chat/turnLedger.ts';
import {
  chatAppFixture,
  controlledExecutor,
  saveChat,
  turnBody,
  waitFor,
} from './helpers/chat-turns.js';
import { temporary } from '../relay/helpers.js';

const owner = {
  deviceId: 'd12345678',
  clientId: 'client-message-1',
  contentHash: 'a'.repeat(64),
};

/**
 * Доверенный порт принадлежит серверному адаптеру, а не телу обычного HTTP-запроса.
 * История читается с диска без Pinia, открытого браузера и клиентского PUT.
 */
test('MC-34: принятый мобильный ход сохраняет user, финал, steps и метаданные без браузера', async (t) => {
  const { executor, runs, waitForRuns } = controlledExecutor();
  const { app, root, config } = await chatAppFixture(t, { executor });

  await saveChat(app, 'mobile-history');

  const accepted = await app.mobileChat.send({
    ...turnBody('mobile-history', 'mobile-history-turn'),
    owner,
  });

  assert.equal(accepted.status, 202);
  await waitForRuns(1);

  const before = (await app.inject('/api/chat/store/chat/mobile-history')).json().chat;

  assert.equal(before.messages.filter((message) => message.role === 'user').length, 1);
  assert.equal(before.messages[0].turnId, 'mobile-history-turn');
  assert.equal(before.messages[0].clientId, owner.clientId);
  runs[0].release('Устойчивый ответ', {
    contextTokens: 27,
    contextWindow: 123,
    cost: 0.2,
  });
  await waitFor(async () => {
    const chat = (await app.inject('/api/chat/store/chat/mobile-history')).json().chat;

    return chat.messages.some((message) => message.text === 'Устойчивый ответ');
  });
  await app.mobileChat.reconcile('mobile-history');
  await app.mobileChat.reconcile('mobile-history');

  const reader = new ChatHistoryStore({
    chatsDir: config.chatsDir,
    legacyPath: path.join(root, 'legacy.json'),
  });
  const stored = await reader.readOne('mobile-history');
  const final = stored.messages.find((message) => message.role === 'assistant');

  assert.equal(stored.messages.length, 2);
  assert.equal(final.text, 'Устойчивый ответ');
  assert.equal(final.steps.length, 1);
  assert.equal(final.cost, 0.2);
  assert.equal(stored.sessionId, 'sess-mobile-history');
  assert.equal(stored.contextTokens, 27);
  assert.equal(stored.unread, true);
  await app.mobileChat.controls.read('mobile-history', stored.revision);
  await app.mobileChat.reconcile('mobile-history');
  assert.equal((await reader.readOne('mobile-history')).unread, false);
  assert.equal((await fs.readdir(path.join(config.chatsDir, 'pending'))).length, 0);
});

test('MC-35: stale PUT не стирает серверный финал; I/O failure оставляет pending для сверки', async (t) => {
  const { executor, runs, waitForRuns } = controlledExecutor();
  const { app, config } = await chatAppFixture(t, { executor });

  await saveChat(app, 'mobile-io');
  await app.mobileChat.send({
    ...turnBody('mobile-io', 'mobile-io-turn'),
    owner,
  });
  await waitForRuns(1);

  const stale = (await app.inject('/api/chat/store/chat/mobile-io')).json().chat;
  const original = ChatHistoryStore.prototype.writeAtomic;
  let broken = true;

  ChatHistoryStore.prototype.writeAtomic = async function (file, data, ...args) {
    if (broken && file.startsWith(config.chatsDir) && data.includes('Итог после сбоя')) {
      throw new Error('synthetic history disk failure');
    }

    return original.call(this, file, data, ...args);
  };
  t.after(() => {
    ChatHistoryStore.prototype.writeAtomic = original;
  });
  runs[0].release('Итог после сбоя');
  await waitFor(async () => {
    try {
      return (await fs.readdir(path.join(config.chatsDir, 'pending'))).length === 1;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return false;
      }

      throw error;
    }
  });
  await assert.rejects(() => app.mobileChat.reconcile('mobile-io'));
  assert.equal((await fs.readdir(path.join(config.chatsDir, 'pending'))).length, 1);
  broken = false;
  await app.mobileChat.reconcile('mobile-io');
  await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: { chat: stale },
  });

  const result = (await app.inject('/api/chat/store/chat/mobile-io')).json().chat;

  assert.equal(result.messages.filter((message) => message.text === 'Итог после сбоя').length, 1);
  assert.equal(result.sessionId, 'sess-mobile-io');
  assert.equal((await fs.readdir(path.join(config.chatsDir, 'pending'))).length, 0);
});

test('MC-36: восстановление running после падения даёт один interrupted без запуска исполнителя',
  async (t) => {
  const root = await temporary(t);

  await t.test('серверы закрываются до удаления общей истории', async (scenario) => {
    const { executor, runs } = controlledExecutor();
    const first = await chatAppFixture(scenario, {
      executor,
      root,
    });

    await saveChat(first.app, 'mobile-crash');
    await first.app.close();

    const ledger = new ChatTurnLedger({ dir: path.join(root, 'chats/turns') });

    await ledger.put({
      turnId: 'mobile-crash-turn',
      chatKey: 'mobile-crash',
      state: 'running',
      acceptedAt: Date.now(),
      userText: 'Не повторять',
      mobileOwner: owner,
    });

    const recovered = await chatAppFixture(scenario, {
      executor,
      root,
    });

    await recovered.app.ready();
    await recovered.app.mobileChat.reconcile('mobile-crash');

    const result = (await recovered.app.inject('/api/chat/store/chat/mobile-crash')).json().chat;

    assert.equal(result.messages.filter((message) => message.role === 'user').length, 1);
    assert.equal(
      result.messages.filter((message) => message.interruptedBy === 'server_shutdown').length,
      1,
    );
    assert.equal(runs.length, 0);
  });
});

/**
 * Сверка мобильной истории на старте запускает разовую миграцию чатов, а та — сборку реестра
 * моделей с пробами всех исполнителей. Старт модуля не ждёт этого: иначе он не укладывался
 * в лимит Fastify, и сервер падал по кругу. Сверка доходит до конца в фоне.
 */
test('MC-36: старт модуля чата не ждёт фоновую сверку мобильной истории', async (t) => {
  const root = await temporary(t);

  await t.test('серверы закрываются до удаления общей истории', async (scenario) => {
    const { executor } = controlledExecutor();
    const first = await chatAppFixture(scenario, {
      executor,
      root,
    });

    await saveChat(first.app, 'mobile-slow-start');
    await first.app.close();

    const ledger = new ChatTurnLedger({ dir: path.join(root, 'chats/turns') });

    await ledger.put({
      turnId: 'mobile-slow-start-turn',
      chatKey: 'mobile-slow-start',
      state: 'done',
      acceptedAt: Date.now(),
      userText: 'Принято с телефона',
      mobileOwner: owner,
    });

    let releaseRegistry = () => {};
    const registryGate = new Promise((resolve) => {
      releaseRegistry = resolve;
    });
    const recovered = await chatAppFixture(scenario, {
      executor,
      root,
      modelsRegistry: async () => {
        await registryGate;

        return { 'test-provider': [{ id: 'test-model', efforts: [] }] };
      },
    });
    const started = await Promise.race([
      recovered.app.ready().then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);

    releaseRegistry();
    assert.equal(started, true);
    await recovered.app.mobileChat.reconcile();

    const result = (await recovered.app.inject('/api/chat/store/chat/mobile-slow-start')).json().chat;

    assert.equal(
      result.messages.filter((message) => message.turnId === 'mobile-slow-start-turn').length,
      1,
    );
  });
});

test('MC-34: обычное тело запроса не назначает server-owned history', async (t) => {
  const { executor, runs, waitForRuns } = controlledExecutor();
  const { app } = await chatAppFixture(t, { executor });

  await saveChat(app, 'mobile-untrusted');
  await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('mobile-untrusted', 'ordinary-web-turn', 'Веб', {
      mobileOwner: owner,
      owner,
    }),
  });
  await waitForRuns(1);

  const chat = (await app.inject('/api/chat/store/chat/mobile-untrusted')).json().chat;

  assert.equal(chat.messages.length, 0);
  runs[0].release();
});

/**
 * Оставляет готовый итог в pending, имитируя недоступную историю конкретного стенда.
 * Уборка возвращает исходный метод даже после неуспешной проверки.
 */
async function heldResult(t, id, afterRename = false) {
  const controlled = controlledExecutor();
  const fixture = await chatAppFixture(t, { executor: controlled.executor });
  const { app, config } = fixture;
  const original = ChatHistoryStore.prototype.writeAtomic;
  let broken = true;
  let attempts = 0;

  await saveChat(app, id);
  await app.mobileChat.send({
    ...turnBody(id, `${id}-turn`),
    owner,
  });
  await controlled.waitForRuns(1);

  ChatHistoryStore.prototype.writeAtomic = async function (file, data, ...args) {
    if (file.startsWith(config.chatsDir) && data.includes('Удержанный итог')) {
      attempts += 1;

      if (afterRename) {
        await original.call(this, file, data, ...args);
      }
      if (broken) {
        throw new Error('Синтетический отказ записи истории');
      }
      if (afterRename) {
        return;
      }
    }

    return original.call(this, file, data, ...args);
  };
  t.after(() => {
    ChatHistoryStore.prototype.writeAtomic = original;
  });
  controlled.runs[0].release('Удержанный итог', { contextTokens: 77 });
  await waitFor(async () => {
    const pending = await fs.readdir(path.join(config.chatsDir, 'pending')).catch(() => []);
    const active = (await app.inject('/api/chat/active')).json();

    return pending.length === 1 && active.active.length === 0;
  });

  return {
    ...fixture,
    ...controlled,
    restore() {
      broken = false;
    },
    attempts: () => attempts,
  };
}

test('MC-35: поздний pending сохраняет явный reset и серверную identity после PUT', async (t) => {
  const fixture = await heldResult(t, 'mobile-reset');
  const { app } = fixture;
  const before = (await app.inject('/api/chat/store/chat/mobile-reset')).json().chat;

  assert.ok(before.executionRunId);
  await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        ...before,
        draft: 'Новый черновик',
      },
    },
  });

  const updated = (await app.inject('/api/chat/store/chat/mobile-reset')).json().chat;

  assert.equal(updated.executionRunId, before.executionRunId);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/chat/session/reset',
        payload: { chatKey: 'mobile-reset' },
      })
    ).statusCode,
    200,
  );
  fixture.restore();
  await app.mobileChat.reconcile('mobile-reset');

  const result = (await app.inject('/api/chat/store/chat/mobile-reset')).json().chat;

  assert.equal(result.sessionId, null);
  assert.equal(result.contextTokens, 0);
  assert.equal(result.messages.filter((message) => message.text === 'Удержанный итог').length, 1);
});

test('MC-35: повтор после ошибки за rename снова проходит durable барьер', async (t) => {
  const fixture = await heldResult(t, 'mobile-fsync', true);
  const before = fixture.attempts();

  await assert.rejects(() => fixture.app.mobileChat.reconcile('mobile-fsync'));
  assert.ok(fixture.attempts() > before);
  fixture.restore();
  await fixture.app.mobileChat.reconcile('mobile-fsync');
  assert.equal((await fs.readdir(path.join(fixture.config.chatsDir, 'pending'))).length, 0);
});

test('MC-35: удаление с удержанным pending не мешает другим чатам и повторному id', async (t) => {
  const fixture = await heldResult(t, 'mobile-deleted');
  const { app, config } = fixture;

  fixture.restore();
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url: '/api/chat/store/chat/mobile-deleted',
      })
    ).statusCode,
    200,
  );
  await app.mobileChat.reconcile();
  await saveChat(app, 'mobile-deleted');
  await app.mobileChat.reconcile();

  assert.equal(
    (await app.inject('/api/chat/store/chat/mobile-deleted')).json().chat.messages.length,
    0,
  );
  assert.equal((await fs.readdir(path.join(config.chatsDir, 'pending'))).length, 0);
});

test('MC-34: явная очистка с revision не восстанавливает законченные мобильные реплики', async (t) => {
  const controlled = controlledExecutor();
  const { app } = await chatAppFixture(t, { executor: controlled.executor });

  await saveChat(app, 'mobile-clear');
  await app.mobileChat.send({
    ...turnBody('mobile-clear', 'mobile-clear-turn'),
    owner,
  });
  await controlled.waitForRuns(1);
  controlled.runs[0].release('Ответ до очистки');
  await waitFor(
    async () =>
      (await app.inject('/api/chat/store/chat/mobile-clear')).json().chat.messages.length === 2,
  );

  const chat = (await app.inject('/api/chat/store/chat/mobile-clear')).json().chat;
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        ...chat,
        messages: [],
      },
    },
  });

  assert.equal(saved.json().stale, false);
  await app.mobileChat.reconcile();
  assert.equal(
    (await app.inject('/api/chat/store/chat/mobile-clear')).json().chat.messages.length,
    0,
  );
});

test('MC-34: mobile не присваивает обычный turnId и исправляет user до executor', async (t) => {
  const controlled = controlledExecutor();
  const { app } = await chatAppFixture(t, { executor: controlled.executor });

  await saveChat(app, 'mobile-collision', {
    messages: [
      {
        role: 'user',
        text: 'Старая копия',
        turnId: 'mobile-canonical-turn',
      },
    ],
  });
  await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('mobile-collision', 'ordinary-collision-turn'),
  });
  await controlled.waitForRuns(1);

  const collision = await app.mobileChat.send({
    ...turnBody('mobile-collision', 'ordinary-collision-turn', 'Другой текст'),
    owner,
  });

  assert.equal(collision.status, 409);
  controlled.runs[0].release();
  await app.mobileChat.send({
    ...turnBody('mobile-collision', 'mobile-canonical-turn', 'Верный текст'),
    owner,
  });
  await controlled.waitForRuns(2);

  const chat = (await app.inject('/api/chat/store/chat/mobile-collision')).json().chat;

  assert.equal(
    chat.messages.find((message) => message.turnId === 'mobile-canonical-turn').text,
    'Верный текст',
  );
  controlled.runs[1].release();
});

test('MC-35: done всегда durable до ACK, даже если предыдущая запись ledger упала', async (t) => {
  const controlled = controlledExecutor();
  const fixture = await chatAppFixture(t, { executor: controlled.executor });
  const { app, root } = fixture;
  const original = ChatTurnLedger.prototype.persist;
  let failed = false;

  await saveChat(app, 'mobile-ledger');
  await app.mobileChat.send({
    ...turnBody('mobile-ledger', 'mobile-ledger-turn'),
    owner,
  });
  await controlled.waitForRuns(1);

  ChatTurnLedger.prototype.persist = function (id) {
    if (this.dir.startsWith(root) && this.get(id)?.state === 'done' && !failed) {
      failed = true;

      return Promise.reject(new Error('Синтетический отказ ledger'));
    }

    return original.call(this, id);
  };
  t.after(() => {
    ChatTurnLedger.prototype.persist = original;
  });
  controlled.runs[0].release('Устойчивый готовый ответ');
  await waitFor(async () =>
    (await app.inject('/api/chat/store/chat/mobile-ledger'))
      .json()
      .chat.messages.some((message) => message.text === 'Устойчивый готовый ответ'),
  );
  await app.mobileChat.reconcile();

  const onDisk = JSON.parse(
    await fs.readFile(path.join(root, 'chats/turns/mobile-ledger-turn.json'), 'utf8'),
  );

  assert.equal(failed, true);
  assert.equal(onDisk.state, 'done');
  assert.equal((await fs.readdir(path.join(root, 'chats/pending'))).length, 0);
});

test('MC-34: все законченные блоки без in-turn receipt сохраняются и уведомляют веб', async (t) => {
  const controlled = controlledExecutor();
  const { app, events } = await chatAppFixture(t, { executor: controlled.executor });

  await saveChat(app, 'mobile-blocks');
  await app.mobileChat.send({
    ...turnBody('mobile-blocks', 'mobile-blocks-turn'),
    owner,
  });
  await controlled.waitForRuns(1);
  await controlled.runs[0].options.onAssistantMessage({
    assistantMessageId: 'mobile-block-one',
    text: 'Первый промежуточный ответ',
    sourceRevision: 1,
    complete: true,
  });
  await controlled.runs[0].options.onAssistantMessage({
    assistantMessageId: 'mobile-block-two',
    text: 'Второй промежуточный ответ',
    sourceRevision: 1,
    complete: true,
  });
  controlled.runs[0].release('Финал после двух блоков');
  await waitFor(async () =>
    (await app.inject('/api/chat/store/chat/mobile-blocks'))
      .json()
      .chat.messages.some((message) => message.text === 'Финал после двух блоков'),
  );

  const chat = (await app.inject('/api/chat/store/chat/mobile-blocks')).json().chat;

  assert.ok(chat.messages.some((message) => message.text === 'Первый промежуточный ответ'));
  assert.ok(chat.messages.some((message) => message.text === 'Второй промежуточный ответ'));
  assert.ok(
    events.some((event) => event.event === 'chat-store' && event.data.id === 'mobile-blocks'),
  );
});

test('MC-34: исходный snapshot user не мутируется, даже с будущим updatedAt', async (t) => {
  const controlled = controlledExecutor();
  const { app } = await chatAppFixture(t, { executor: controlled.executor });

  await saveChat(app, 'mobile-user-patch');

  const previous = (await app.inject('/api/chat/store/chat/mobile-user-patch')).json().chat;

  await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        ...previous,
        updatedAt: Date.now() + 100000,
        messages: [
          {
            role: 'user',
            text: 'Старая копия',
            turnId: 'mobile-user-patch-turn',
          },
        ],
      },
    },
  });
  await app.mobileChat.send({
    ...turnBody('mobile-user-patch', 'mobile-user-patch-turn', 'Верный текст'),
    owner,
  });
  await controlled.waitForRuns(1);

  const chat = (await app.inject('/api/chat/store/chat/mobile-user-patch')).json().chat;

  assert.equal(chat.messages[0].text, 'Верный текст');
  controlled.runs[0].release();
});

test('MC-34: queued ход остаётся после всех блоков и финала предыдущего', async (t) => {
  const controlled = controlledExecutor();
  const { app } = await chatAppFixture(t, { executor: controlled.executor });

  await saveChat(app, 'mobile-order');
  await app.mobileChat.send({
    ...turnBody('mobile-order', 'mobile-order-first', 'Вопрос A'),
    owner,
  });
  await controlled.waitForRuns(1);
  await controlled.runs[0].options.onAssistantMessage({
    assistantMessageId: 'mobile-order-block',
    text: 'Промежуточный A',
    sourceRevision: 1,
    complete: true,
  });
  await app.mobileChat.send({
    ...turnBody('mobile-order', 'mobile-order-second', 'Вопрос B'),
    owner: {
      ...owner,
      clientId: 'client-message-2',
    },
  });
  controlled.runs[0].release('Финал A');
  await controlled.waitForRuns(2);

  const chat = (await app.inject('/api/chat/store/chat/mobile-order')).json().chat;

  assert.deepEqual(
    chat.messages.map((message) => message.text),
    ['Вопрос A', 'Промежуточный A', 'Финал A', 'Вопрос B'],
  );
  controlled.runs[1].release('Финал B');
});

test('MC-34: отказ preflight без ledger сохраняет собственный код', async (t) => {
  const controlled = controlledExecutor();
  const { app } = await chatAppFixture(t, { executor: controlled.executor });

  await saveChat(app, 'mobile-preflight');

  const before = (await app.inject('/api/chat/store/chat/mobile-preflight')).json().chat;

  await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        ...before,
        model: 'unavailable-model',
        modelRef: {
          provider: 'test-provider',
          model: 'unavailable-model',
        },
      },
    },
  });

  const result = await app.mobileChat.send({
    ...turnBody('mobile-preflight', 'mobile-preflight-turn'),
    owner,
  });

  assert.equal(result.status, 400);
  assert.notEqual(result.body.error, 'turn_conflict');
});

test('MC-35: финал веба получает canonical metadata после reset, сохраняя steps', async (t) => {
  const fixture = await heldResult(t, 'mobile-mutated');
  const { app } = fixture;

  await app.inject({
    method: 'POST',
    url: '/api/chat/session/reset',
    payload: { chatKey: 'mobile-mutated' },
  });
  fixture.restore();

  const before = (await app.inject('/api/chat/store/chat/mobile-mutated')).json().chat;

  await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        ...before,
        messages: [
          ...before.messages,
          {
            role: 'assistant',
            text: 'Удержанный итог',
            pid: 'mobile-mutated-turn',
            turnId: 'mobile-mutated-turn',
            steps: [],
            cost: null,
          },
        ],
      },
    },
  });
  await app.mobileChat.reconcile();

  const chat = (await app.inject('/api/chat/store/chat/mobile-mutated')).json().chat;
  const final = chat.messages.find((message) => message.role === 'assistant');

  assert.equal(final.serverCanonical, true);
  assert.equal(final.clientId, owner.clientId);
  assert.equal(final.cost, 0);
  // Уже durable-массив не меняется при серверном reconcile, даже если он пуст.
  // Метаданные финала по-прежнему дополняются без замены основания refs окна.
  assert.deepEqual(final.steps, []);
  assert.equal(chat.sessionId, null);
});

test('MC-35: веб ACK тоже сохраняет pending при отказе durable ledger', async (t) => {
  const controlled = controlledExecutor();
  const { app, root } = await chatAppFixture(t, { executor: controlled.executor });
  const original = ChatTurnLedger.prototype.persist;
  let broken = true;

  await saveChat(app, 'mobile-web-ack');
  await app.mobileChat.send({
    ...turnBody('mobile-web-ack', 'mobile-web-ack-turn'),
    owner,
  });
  await controlled.waitForRuns(1);

  ChatTurnLedger.prototype.persist = function (id) {
    if (broken && this.dir.startsWith(root) && this.get(id)?.state === 'done') {
      return Promise.reject(new Error('Синтетический отказ ledger'));
    }

    return original.call(this, id);
  };
  t.after(() => {
    ChatTurnLedger.prototype.persist = original;
  });
  controlled.runs[0].release('Ответ с подтверждением веба');
  await waitFor(async () => (await app.inject('/api/chat/pending')).json().pending.length === 1);

  const denied = await app.inject({
    method: 'DELETE',
    url: '/api/chat/pending/mobile-web-ack-turn',
  });

  assert.equal(denied.statusCode, 503);
  assert.equal((await app.inject('/api/chat/pending')).json().pending.length, 1);
  broken = false;
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url: '/api/chat/pending/mobile-web-ack-turn',
      })
    ).statusCode,
    200,
  );

  const saved = JSON.parse(
    await fs.readFile(path.join(root, 'chats/turns/mobile-web-ack-turn.json'), 'utf8'),
  );

  assert.equal(saved.state, 'done');
  assert.equal((await app.inject('/api/chat/pending')).json().pending.length, 0);
});

test('MC-36: поздний настоящий финал заменяет признаки interrupted при drain', async (t) => {
  const controlled = controlledExecutor();
  const executor = {
    ...controlled.executor,
    run: (options) =>
      controlled.executor.run({
        ...options,
        signal: undefined,
      }),
  };
  const { app, drain } = await chatAppFixture(t, {
    executor,
    shutdownGraceMs: 1,
    shutdownInterruptMs: 2,
  });

  await saveChat(app, 'mobile-late');
  await app.mobileChat.send({
    ...turnBody('mobile-late', 'mobile-late-turn'),
    owner,
  });
  await controlled.waitForRuns(1);
  await drain();
  await app.mobileChat.reconcile();
  controlled.runs[0].release('Поздний настоящий ответ');
  await waitFor(async () =>
    (await app.inject('/api/chat/store/chat/mobile-late'))
      .json()
      .chat.messages.some((message) => message.text === 'Поздний настоящий ответ'),
  );

  const chat = (await app.inject('/api/chat/store/chat/mobile-late')).json().chat;
  const final = chat.messages.find((message) => message.role !== 'user');

  assert.equal(chat.messages.length, 2);
  assert.equal(final.role, 'assistant');
  assert.equal(Boolean(final.interruptedBy), false);
  assert.equal(Boolean(final.stopped), false);
});
