import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildClaudeTurnResult, createClaudeTurnCollector,
} from '../../server/src/lib/executors/_claudeStream.ts';

const API_ERROR = 'API Error: Unable to connect to API (UNKNOWN_CERTIFICATE_VERIFICATION_ERROR)';

// Обращение к модели: только у него есть usage, и только оно двигает контекст хода.
function modelReply(text) {
  return {
    type: 'assistant',
    session_id: 's1',
    message: {
      model: 'claude-opus-5',
      usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 100 },
      content: [{ type: 'text', text }],
    },
  };
}

// Сообщение, сочинённое самим CLI: модель его не видела, usage нулевой.
function cliSaid(text) {
  return {
    type: 'assistant',
    session_id: 's1',
    message: {
      model: '<synthetic>',
      usage: { input_tokens: 0, output_tokens: 0 },
      content: [{ type: 'text', text }],
    },
  };
}

function resultEvent(text) {
  return {
    type: 'result', subtype: 'success', session_id: 's1', result: text, num_turns: 3,
  };
}

function runTurn(events) {
  const collector = createClaudeTurnCollector();
  for (const event of events) collector.push(event);
  return buildClaudeTurnResult(collector, {});
}

test('ход, оборванный сбоем доставки, не выдаётся за ответ агента', () => {
  const out = runTurn([
    { type: 'system', subtype: 'init', model: 'claude-opus-5', session_id: 's1' },
    modelReply('сейчас посмотрю'),
    cliSaid(API_ERROR),
    resultEvent(API_ERROR),
  ]);

  assert.equal(out.deliveryFailure, true);
  // Продолжение хода возможно только по сохранённому разговору — id обязан доехать.
  assert.equal(out.sessionId, 's1');
  // Работа хода не выбрасывается: лента шагов остаётся при сообщении.
  assert.ok(out.steps.length > 0);
});

test('сбой доставки, который ход пережил, ошибкой не считается', () => {
  const out = runTurn([
    { type: 'system', subtype: 'init', model: 'claude-opus-5', session_id: 's1' },
    cliSaid(API_ERROR),
    modelReply('связь вернулась, готово'),
    resultEvent('связь вернулась, готово'),
  ]);

  assert.equal(out.deliveryFailure, false);
});

test('обычный ответ агента про ошибку API не превращается в сбой хода', () => {
  const out = runTurn([
    { type: 'system', subtype: 'init', model: 'claude-opus-5', session_id: 's1' },
    modelReply(API_ERROR),
    resultEvent(API_ERROR),
  ]);

  assert.equal(out.deliveryFailure, false);
});

test('нулевой usage сочинённого сообщения не подменяет контекст хода', () => {
  const out = runTurn([
    { type: 'system', subtype: 'init', model: 'claude-opus-5', session_id: 's1' },
    modelReply('работаю'),
    cliSaid(API_ERROR),
    resultEvent(API_ERROR),
  ]);

  assert.equal(out.contextTokens, 112);
});
