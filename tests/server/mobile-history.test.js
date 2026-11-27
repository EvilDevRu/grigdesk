import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ChatHistoryStore } from '../../server/src/lib/chat/historyStore.ts';
import { ChatTurnLedger } from '../../server/src/lib/chat/turnLedger.ts';
import { temporary } from '../relay/helpers.js';
import { chatAppFixture, controlledExecutor, saveChat, turnBody } from './helpers/chat-turns.js';
import {
  mobileHistoryPort,
  seedAssistantBlock,
  seedMobileTurn,
  setExecutionRunId,
} from './helpers/mobileHistoryPort.js';

const owner = {
  deviceId: 'd12345678',
  clientId: 'client-message-1',
  contentHash: 'a'.repeat(64),
};

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
 * Каждый сценарий получает отдельные историю, ledger и pending.
 * Пустая папка соответствует свежему процессу без открытого окна.
 */
async function fixture(t) {
  const root = await temporary(t);
  const chatsDir = path.join(root, 'chats');

  return mobileHistoryPort({ chatsDir, root });
}

test('MC-34: принятый ход материализует user и финал, повтор сверки даёт тот же итог', async (t) => {
  const port = await fixture(t);
  const chatKey = 'mobile-history';
  const turnId = 'mobile-history-turn';

  await seedMobileTurn(port, {
    chatKey,
    turnId,
    text: 'Вопрос',
    owner,
    reply: 'Устойчивый ответ',
    extra: { contextTokens: 27, contextWindow: 123 },
  });

  const accepted = await port.history.readOne(chatKey);

  assert.equal(accepted.messages.length, 1);
  assert.equal(accepted.messages[0].turnId, turnId);
  await port.mobileHistory.reconcile(chatKey);
  await port.mobileHistory.reconcile(chatKey);

  const stored = await port.history.readOne(chatKey);
  const [user, final] = stored.messages;

  assert.equal(stored.messages.length, 2);
  assert.equal(user.role, 'user');
  assert.equal(user.clientId, owner.clientId);
  assert.equal(final.role, 'assistant');
  assert.equal(final.turnId, turnId);
  assert.equal(final.text, 'Устойчивый ответ');
  assert.equal(final.cost, 0.2);
  assert.equal(final.steps[0].text, 'работаю');
  assert.equal(stored.sessionId, 'sess-mobile-history');
  assert.equal(stored.contextTokens, 27);
  assert.equal(stored.contextWindow, 123);
  assert.deepEqual(await fs.readdir(port.pendingDir), []);
});

test('MC-35: при сбое записи pending остаётся, устаревший PUT сохраняет итог и контекст', async (t) => {
  const port = await fixture(t);
  const chatKey = 'mobile-io';
  const turnId = 'mobile-io-turn';
  const reply = 'Итог после сбоя';

  await seedMobileTurn(port, {
    chatKey,
    turnId,
    text: 'Вопрос',
    owner,
    reply,
    extra: { at: Date.now() + 1000, contextTokens: 77 },
  });

  const stale = await port.history.readOne(chatKey);
  const original = ChatHistoryStore.prototype.writeAtomic;
  let broken = true;

  t.mock.method(port.history, 'writeAtomic', async function (file, data, ...args) {
    if (broken && data.includes(reply)) {
      throw new Error('Синтетический отказ записи истории');
    }

    return original.call(this, file, data, ...args);
  });

  await assert.rejects(() => port.mobileHistory.reconcile(chatKey), /Синтетический отказ записи/);
  assert.deepEqual(await fs.readdir(port.pendingDir), [`${turnId}.json`]);
  assert.equal((await port.history.readOne(chatKey)).messages.length, 1);

  broken = false;
  await port.mobileHistory.reconcile(chatKey);

  const saved = await port.history.saveOne(stale);
  const stored = await port.history.readOne(chatKey);
  const finals = stored.messages.filter((message) => message.role === 'assistant');

  assert.equal(saved.stale, true);
  assert.equal(finals.length, 1);
  assert.equal(finals[0].text, reply);
  assert.equal(finals[0].serverCanonical, true);
  assert.equal(stored.sessionId, 'sess-mobile-io');
  assert.equal(stored.contextTokens, 77);
  assert.deepEqual(await fs.readdir(port.pendingDir), []);
});

test('MC-36: смена эпохи подавляет прежний pending, удаление пишет tombstone', async (t) => {
  const port = await fixture(t);
  const chatKey = 'mobile-epoch';
  const turnId = 'mobile-epoch-turn';

  await seedMobileTurn(port, {
    chatKey,
    turnId,
    text: 'Вопрос',
    owner,
    reply: 'Старый итог',
  });
  await port.history.patchExecution(chatKey, (current) => ({
    mobileHistoryEpoch: Number(current.mobileHistoryEpoch || 0) + 1,
  }), { durable: true });
  await port.mobileHistory.reconcile(chatKey);

  const stored = await port.history.readOne(chatKey);

  assert.equal(stored.messages.some((message) => message.text === 'Старый итог'), false);
  assert.deepEqual(await fs.readdir(port.pendingDir), []);

  const removed = await port.mobileHistory.remove(chatKey, async () => {
    await port.history.remove(chatKey);

    return true;
  });

  assert.equal(removed, true);
  assert.equal(port.ledger.get(turnId).historySuppressed, true);
  await port.mobileHistory.reconcile(chatKey);
  assert.equal(await port.history.readOne(chatKey), null);
});

test('MC-34: очистка с текущей ревизией поднимает эпоху и не возвращает прежние реплики', async (t) => {
  const port = await fixture(t);
  const chatKey = 'mobile-clear';

  await seedMobileTurn(port, {
    chatKey,
    turnId: 'mobile-clear-turn',
    text: 'Вопрос',
    owner,
    reply: 'Удаляемый итог',
  });
  await port.mobileHistory.reconcile(chatKey);

  const before = await port.history.readOne(chatKey);

  assert.equal(before.messages.length, 2);

  const cleared = await port.history.saveOne({ ...before, messages: [] });

  assert.equal(cleared.stale, false);
  await port.mobileHistory.reconcile(chatKey);

  const after = await port.history.readOne(chatKey);

  assert.equal(after.mobileHistoryEpoch, Number(before.mobileHistoryEpoch || 0) + 1);
  assert.deepEqual(after.messages, []);
});

test('MC-34: accepted исправляет прежнюю реплику по turnId без дубля', async (t) => {
  const port = await fixture(t);
  const chatKey = 'mobile-user-patch';
  const turnId = 'mobile-user-patch-turn';
  const updatedAt = Date.now() + 100000;
  const previous = {
    role: 'user',
    text: 'Старая копия',
    turnId,
  };

  const entry = await seedMobileTurn(port, {
    chatKey,
    turnId,
    text: 'Верный текст',
    owner,
    reply: 'Итог',
    updatedAt,
    messages: [previous],
  });

  await port.mobileHistory.accepted(entry);

  const stored = await port.history.readOne(chatKey);

  assert.equal(previous.text, 'Старая копия');
  assert.equal(stored.updatedAt, updatedAt);
  assert.equal(stored.messages.length, 1);
  assert.equal(stored.messages[0].turnId, turnId);
  assert.equal(stored.messages[0].text, 'Верный текст');
  assert.equal(stored.messages[0].serverCanonical, true);
});

test('MC-35: финал старого run получает canonical поля и сохраняет сброс сессии', async (t) => {
  const port = await fixture(t);
  const chatKey = 'mobile-reset';
  const turnId = 'mobile-reset-turn';
  const previousRun = 'run-reset-previous';
  const currentRun = 'run-reset-current';
  const reply = 'Поздний итог';

  await seedMobileTurn(port, {
    chatKey,
    turnId,
    text: 'Вопрос',
    owner,
    reply,
    extra: { runId: previousRun, contextTokens: 77 },
  });
  await setExecutionRunId(port, chatKey, currentRun);
  await port.history.patchExecution(chatKey, () => ({
    sessionId: null,
    contextTokens: 0,
  }), { durable: true });

  const before = await port.history.readOne(chatKey);
  const browserCopy = {
    role: 'assistant',
    text: reply,
    turnId,
    pid: turnId,
    runId: previousRun,
    assistantMessageId: `m-${turnId}`,
    steps: [],
    cost: null,
  };

  await port.history.saveOne({
    ...before,
    draft: 'Новый черновик',
    messages: [...before.messages, browserCopy],
  });
  assert.equal((await port.history.readOne(chatKey)).executionRunId, currentRun);
  await port.mobileHistory.reconcile(chatKey);

  const stored = await port.history.readOne(chatKey);
  const finals = stored.messages.filter((message) => message.role === 'assistant');

  assert.equal(stored.executionRunId, currentRun);
  assert.equal(stored.sessionId, null);
  assert.equal(stored.contextTokens, 0);
  assert.equal(stored.draft, 'Новый черновик');
  assert.equal(finals.length, 1);
  assert.equal(finals[0].text, reply);
  assert.equal(finals[0].serverCanonical, true);
  assert.equal(finals[0].clientId, owner.clientId);
  assert.equal(finals[0].cost, 0.2);
  assert.deepEqual(finals[0].steps, []);
});

test('MC-35: durable done предшествует материализации и ACK, повтор не дублирует итог', async (t) => {
  const port = await fixture(t);
  const chatKey = 'mobile-ledger';
  const turnId = 'mobile-ledger-turn';
  const reply = 'Готовый ответ';
  const ledgerFile = path.join(port.ledger.dir, `${turnId}.json`);

  await seedMobileTurn(port, {
    chatKey,
    turnId,
    text: 'Вопрос',
    owner,
    reply,
  });

  const original = ChatTurnLedger.prototype.persist;
  let broken = true;

  t.mock.method(port.ledger, 'persist', function (id) {
    if (broken && id === turnId && this.get(id)?.state === 'done') {
      return Promise.reject(new Error('Синтетический отказ ledger'));
    }

    return original.call(this, id);
  });

  await assert.rejects(() => port.mobileHistory.reconcile(chatKey), /Синтетический отказ ledger/);
  assert.deepEqual(await fs.readdir(port.pendingDir), [`${turnId}.json`]);
  assert.equal(JSON.parse(await fs.readFile(ledgerFile, 'utf8')).state, 'queued');
  assert.equal((await port.history.readOne(chatKey)).messages.length, 1);

  broken = false;
  await port.mobileHistory.reconcile(chatKey);
  await port.mobileHistory.reconcile(chatKey);

  const stored = await port.history.readOne(chatKey);

  assert.equal(JSON.parse(await fs.readFile(ledgerFile, 'utf8')).state, 'done');
  assert.equal(stored.messages.filter((message) => message.text === reply).length, 1);
  assert.deepEqual(await fs.readdir(port.pendingDir), []);
});

test('MC-34: завершённые блоки одного run проецируются перед финалом без in-turn receipt', async (t) => {
  const port = await fixture(t);
  const chatKey = 'mobile-blocks';
  const turnId = 'mobile-blocks-turn';
  const runId = 'run-mobile-blocks';

  await seedMobileTurn(port, {
    chatKey,
    turnId,
    text: 'Вопрос',
    owner,
    reply: 'Итог',
    extra: { runId },
  });
  await seedAssistantBlock(port, {
    runId,
    chatKey,
    assistantMessageId: 'block-mobile-1',
    text: 'Первый блок',
    sequence: 1,
  });
  await seedAssistantBlock(port, {
    runId,
    chatKey,
    assistantMessageId: 'block-mobile-2',
    text: 'Второй блок',
    sequence: 2,
  });
  await port.mobileHistory.reconcile(chatKey);
  await port.mobileHistory.reconcile(chatKey);

  const stored = await port.history.readOne(chatKey);
  const [first, second, final] = stored.messages.filter((message) => message.role === 'assistant');

  assert.equal(stored.messages.length, 4);
  assert.equal(first.assistantMessageId, 'block-mobile-1');
  assert.equal(second.assistantMessageId, 'block-mobile-2');
  assert.equal(first.text, 'Первый блок');
  assert.equal(second.text, 'Второй блок');
  assert.equal(first.parentTurnId, turnId);
  assert.equal(final.assistantMessageId, `m-${turnId}`);
  assert.equal(final.text, 'Итог');
});
