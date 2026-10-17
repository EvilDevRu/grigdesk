// Сквозная проверка этапа 4: НАСТОЯЩИЙ сборщик Claude и настоящая петля автопродолжения.
// Подменяются только запуск следующего потока событий и ожидание паузы — иначе регрессию
// synthetic-сообщения (сбой сам себе подтверждает продвижение) здесь не увидеть.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTO_CONTINUE_PROMPT,
  continueAfterFailures,
} from '../../server/src/lib/chat/autoContinue.ts';
import {
  buildClaudeTurnResult,
  createClaudeTurnCollector,
} from '../../server/src/lib/executors/_claudeStream.ts';
import { CLAUDE_TURN_FAILURE_RULES } from '../../server/src/lib/executors/_claudeTurnFailures.ts';

const API_ERROR = 'API Error: Connection error.';

function initEvent() {
  return {
    type: 'system',
    subtype: 'init',
    model: 'claude-opus-5',
    session_id: 's1',
  };
}

// Сообщение, которое CLI сочинил сам: до модели запрос не дошёл.
function syntheticEvent(error) {
  return {
    type: 'assistant',
    session_id: 's1',
    message: {
      model: '<synthetic>',
      usage: { input_tokens: 0, output_tokens: 0 },
      content: [{ type: 'text', text: API_ERROR }],
    },
    ...(error ? { error } : {}),
  };
}

function resultEvent(text) {
  return {
    type: 'result',
    subtype: 'success',
    session_id: 's1',
    result: text,
    num_turns: 1,
  };
}

// Один настоящий ход: события собираются тем же сборщиком, что и в продукте.
function realTurn(events, fallbackSessionId = null) {
  const collector = createClaudeTurnCollector();

  for (const event of events) {
    collector.push(event);
  }

  return buildClaudeTurnResult(collector, { fallbackSessionId });
}

test('четыре synthetic-сбоя подряд дают три продолжения и exhausted', async () => {
  const script = [
    [initEvent(), syntheticEvent('unknown'), resultEvent(API_ERROR)],
    [initEvent(), syntheticEvent('unknown'), resultEvent(API_ERROR)],
    [initEvent(), syntheticEvent('unknown'), resultEvent(API_ERROR)],
    [initEvent(), syntheticEvent('unknown'), resultEvent(API_ERROR)],
  ];
  const delays = [];
  const messages = [];
  let attempt = 0;

  const first = realTurn(script[0]);

  assert.equal(first.deliveryFailure, true, 'первый ход — настоящий сбой доставки');
  assert.deepEqual(first.turnFailure, { code: 'unknown', message: API_ERROR });
  assert.equal(first.turnRecovery.canContinue, true);
  assert.equal(first.turnRecovery.madeProgress, false, 'synthetic работой не является');

  const out = await continueAfterFailures(first, {
    isEnabled: () => true,
    rules: CLAUDE_TURN_FAILURE_RULES,
    continueMessage: AUTO_CONTINUE_PROMPT,
    openWait: () => ({
      wait: async (ms) => {
        delays.push(ms);

        return 'elapsed';
      },
      status: () => null,
      cancel: () => {},
      dispose: () => {},
    }),
    hasQueued: () => false,
    beforeWait: async () => {},
    publishNote: () => {},
    onSummary: () => {},
    run: async (input) => {
      attempt += 1;
      messages.push(input.message);

      const events = script[attempt];

      return realTurn(events, input.sessionId);
    },
    attemptSteps: () => [],
  });

  assert.equal(attempt, 3, 'ровно три продолжения');
  assert.deepEqual(delays, [10_000, 60_000, 180_000], 'паузы сети по колонкам таблицы');
  assert.equal(out.autoContinued, 3);
  assert.equal(out.autoContinueOutcome, 'exhausted');
  assert.deepEqual(messages, [AUTO_CONTINUE_PROMPT, AUTO_CONTINUE_PROMPT, AUTO_CONTINUE_PROMPT]);
});

test('настоящий ответ после сбоя заканчивает ход без лишнего продолжения', async () => {
  const first = realTurn([initEvent(), syntheticEvent('overloaded'), resultEvent(API_ERROR)]);
  const messages = [];

  assert.equal(first.turnFailure.code, 'overloaded');

  const out = await continueAfterFailures(first, {
    isEnabled: () => true,
    rules: CLAUDE_TURN_FAILURE_RULES,
    continueMessage: AUTO_CONTINUE_PROMPT,
    openWait: () => ({
      wait: async () => 'elapsed',
      status: () => null,
      cancel: () => {},
      dispose: () => {},
    }),
    hasQueued: () => false,
    beforeWait: async () => {},
    publishNote: () => {},
    onSummary: () => {},
    run: async (input) => {
      messages.push(input.message);

      return realTurn([
        initEvent(),
        {
          type: 'assistant',
          session_id: 's1',
          message: {
            model: 'claude-opus-5',
            usage: { input_tokens: 10, output_tokens: 4 },
            content: [{ type: 'text', text: 'доделал' }],
          },
        },
        resultEvent('доделал'),
      ], input.sessionId);
    },
    attemptSteps: () => [],
  });

  assert.deepEqual(messages, [AUTO_CONTINUE_PROMPT]);
  assert.equal(out.autoContinueOutcome, 'recovered');
  assert.equal(out.autoContinued, 1);
  assert.equal(out.reply, 'доделал');
  assert.notEqual(out.deliveryFailure, true, 'метка сбоя не перенесена в успех');
  assert.equal(out.turnRecovery, undefined, 'подтверждение сбоя тоже не перенесено');
});
