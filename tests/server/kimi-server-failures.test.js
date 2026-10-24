// Причина завершения Kimi сохраняется отдельно от нажатия человеком «Стоп».
// Искусственный поток повторяет отказ пятичасового окна без обращения к модели.
import assert from 'node:assert/strict';
import test from 'node:test';

import { runKimiServerTurn } from '../../server/src/lib/kimi/serverTurn.ts';
import { kimiUsageWire } from '../helpers/kimiUsageWire.mjs';
import { chatAppFixture, saveChat, turnBody, waitFor } from './helpers/chat-turns.js';

const QUOTA_MESSAGE = "429 You've reached your 5-hour usage limit. "
  + 'Your quota will reset when the current 5-hour window ends.';
const QUOTA_ERROR = {
  code: 'provider.api_error',
  name: 'APIProviderQuotaExhaustedError',
  message: QUOTA_MESSAGE,
  details: { statusCode: 429 },
  retryable: false,
};

/**
 * Один искусственный ход с контекстом и действием до отказа поставщика.
 * Возвращает ошибку драйвера, сохраняя доступ ко всем её служебным полям.
 */
async function failedTurn(t, terminal) {
  const wire = await kimiUsageWire(t, [(send) => {
    send({ type: 'agent.status.updated', contextTokens: 12345 });
    send({ type: 'tool.call.started', name: 'Read' });
    terminal.forEach(send);
  }]);

  try {
    await runKimiServerTurn({
      bin: '/bin/true',
      home: '/tmp',
      message: 'Проверь файл',
      ...wire,
    });
  } catch (error) {
    return error;
  }

  assert.fail('отказ поставщика должен завершить ход ошибкой');
}

test('Kimi: interrupted с ошибкой квоты не выдаётся за остановку', async (t) => {
  const error = await failedTurn(t, [{
    type: 'turn.step.interrupted',
    reason: 'error',
    message: `[provider.api_error] ${QUOTA_MESSAGE}`,
  }]);

  assert.notEqual(error.stopped, true);
  assert.match(error.message, /исчерпан лимит использования/u);
  assert.match(error.message, /5-hour usage limit/u);
  assert.equal(error.failureKind, 'usage_limit');
  assert.equal(error.sessionId, 'usage-session');
  assert.equal(error.contextTokens, 12345);
  assert.ok(error.steps.some((step) => step.k === 'tool'));
});

test('Kimi: failed сохраняет структурированную причину и статус 429', async (t) => {
  const error = await failedTurn(t, [{
    type: 'turn.ended',
    reason: 'failed',
    error: QUOTA_ERROR,
  }]);

  assert.notEqual(error.stopped, true);
  assert.equal(error.failureKind, 'usage_limit');
  assert.deepEqual(error.turnFailure, {
    code: 'provider.api_error',
    status: 429,
    message: QUOTA_MESSAGE,
  });
  assert.match(error.message, /5-hour usage limit/u);
});

test('Kimi: обычный 429 и лимит шагов не превращаются в исчерпание квоты или стоп', async (t) => {
  const scenarios = [
    {
      terminal: {
        type: 'turn.ended',
        reason: 'failed',
        error: {
          message: 'Too many requests',
          details: { statusCode: 429 },
        },
      },
      kind: 'rate_limited',
      message: 'Too many requests',
    },
    {
      terminal: {
        type: 'turn.step.interrupted',
        reason: 'max_steps',
        message: 'Maximum steps reached',
      },
      kind: 'unknown',
      message: 'Maximum steps reached',
    },
  ];

  for (const scenario of scenarios) {
    const error = await failedTurn(t, [scenario.terminal]);

    assert.notEqual(error.stopped, true);
    assert.equal(error.failureKind, scenario.kind);
    assert.equal(error.message, scenario.message);
  }
});

test('Kimi: родная отмена сохраняет признак остановки', async (t) => {
  for (const terminal of [
    { type: 'turn.step.interrupted', reason: 'aborted' },
    { type: 'turn.ended', reason: 'cancelled' },
    { type: 'prompt.aborted' },
  ]) {
    const error = await failedTurn(t, [terminal]);

    assert.equal(error.stopped, true);
  }
});

test('Kimi: отмена субагента не останавливает основной ход', async (t) => {
  const wire = await kimiUsageWire(t, [(send) => {
    send({
      type: 'error',
      agentId: 'critic',
      ...QUOTA_ERROR,
    });
    send({ type: 'prompt.aborted', agentId: 'critic' });
    send({
      type: 'turn.step.interrupted',
      agentId: 'critic',
      reason: 'error',
      message: QUOTA_MESSAGE,
    });
    send({ type: 'assistant.delta', delta: 'Основной агент продолжил работу.' });
    send({ type: 'turn.ended', reason: 'completed' });
  }]);
  const result = await runKimiServerTurn({
    bin: '/bin/true',
    home: '/tmp',
    message: 'Проверь файл',
    ...wire,
  });

  assert.equal(result.reply, 'Основной агент продолжил работу.');
});

test('Kimi: отдельное событие error распознаёт тип квоты без знакомого текста', async (t) => {
  const error = await failedTurn(t, [{
    type: 'error',
    ...QUOTA_ERROR,
    message: 'Subscription exhausted',
  }]);

  assert.notEqual(error.stopped, true);
  assert.equal(error.failureKind, 'usage_limit');
  assert.match(error.message, /исчерпан лимит использования/u);
  assert.equal(error.turnFailure.code, 'provider.api_error');
});

test('Kimi: квота попадает в pending как ошибка, единственный запуск без автоповтора', async (t) => {
  let runs = 0;
  const wire = await kimiUsageWire(t, [(send) => {
    send({
      type: 'turn.step.interrupted',
      reason: 'error',
      message: `[provider.api_error] ${QUOTA_MESSAGE}`,
    });
  }]);
  const f = await chatAppFixture(t, {
    executor: {
      id: 'test-provider',
      run(options) {
        runs += 1;

        return runKimiServerTurn({
          ...options,
          ...wire,
          bin: '/bin/true',
          home: '/tmp',
        });
      },
    },
  });

  await saveChat(f.app, 'quota-chat');

  const response = await f.app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('quota-chat', 'quota-turn-0001', 'Проверь файл'),
  });

  assert.equal(response.statusCode, 202);

  const pending = await waitFor(async () => {
    const result = await f.app.inject({ method: 'GET', url: '/api/chat/pending?chatKey=quota-chat' });

    return result.json().pending?.[0];
  }, { what: 'ошибка квоты в pending' });

  assert.equal(pending.role, 'error');
  assert.notEqual(pending.stopped, true);
  assert.match(pending.reply, /исчерпан лимит использования/u);
  assert.match(pending.reply, /5-hour usage limit/u);
  assert.equal(runs, 1);
});
