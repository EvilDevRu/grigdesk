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

// Настоящий вызов инструмента: модель работает, даже если текст ответа пуст.
function toolCall() {
  return {
    type: 'assistant',
    session_id: 's1',
    message: {
      model: 'claude-opus-5',
      usage: { input_tokens: 12, output_tokens: 3 },
      content: [{
        type: 'tool_use',
        id: 'tool-1',
        name: 'Bash',
        input: { command: 'ls' },
      }],
    },
  };
}

function runTurn(events) {
  const collector = createClaudeTurnCollector();
  for (const event of events) collector.push(event);
  return buildClaudeTurnResult(collector, {});
}

test('ход, оборванный сбоем доставки, не выдаётся за ответ агента', () => {
  const out = runTurn([
    {
      type: 'system',
      subtype: 'init',
      model: 'claude-opus-5',
      session_id: 's1',
    },
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
    {
      type: 'system',
      subtype: 'init',
      model: 'claude-opus-5',
      session_id: 's1',
    },
    cliSaid(API_ERROR),
    modelReply('связь вернулась, готово'),
    resultEvent('связь вернулась, готово'),
  ]);

  assert.equal(out.deliveryFailure, false);
});

test('обычный ответ агента про ошибку API не превращается в сбой хода', () => {
  const out = runTurn([
    {
      type: 'system',
      subtype: 'init',
      model: 'claude-opus-5',
      session_id: 's1',
    },
    modelReply(API_ERROR),
    resultEvent(API_ERROR),
  ]);

  assert.equal(out.deliveryFailure, false);
});

test('нулевой usage сочинённого сообщения не подменяет контекст хода', () => {
  const out = runTurn([
    {
      type: 'system',
      subtype: 'init',
      model: 'claude-opus-5',
      session_id: 's1',
    },
    modelReply('работаю'),
    cliSaid(API_ERROR),
    resultEvent(API_ERROR),
  ]);

  assert.equal(out.contextTokens, 112);
});

// ── Сигнал сбоя и признак реальной работы (редакция 2 плана) ──
// Ход, закончившийся synthetic-сообщением, обязан назвать вид сбоя реестру и
// подтвердить, работала ли модель на самом деле. Лента шагов для этого не годится:
// она усечена и не отличает настоящий вывод от служебного.

// Synthetic-сообщение с корневым полем error — код причины от самого CLI.
function cliSaidWithCode(text, error) {
  return {
    type: 'assistant',
    session_id: 's1',
    message: {
      model: '<synthetic>',
      usage: { input_tokens: 0, output_tokens: 0 },
      content: [{ type: 'text', text }],
    },
    ...(error ? { error } : {}),
  };
}

test('код и статус synthetic-сообщения доходят в сигнал сбоя', () => {
  const text = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}';
  const out = runTurn([
    {
      type: 'system',
      subtype: 'init',
      model: 'claude-opus-5',
      session_id: 's1',
    },
    cliSaidWithCode(text, 'overloaded'),
    resultEvent(text),
  ]);

  assert.equal(out.deliveryFailure, true);
  assert.deepEqual(out.turnFailure, {
    code: 'overloaded',
    status: 529,
    message: text,
  });
  assert.equal(out.turnRecovery.canContinue, true);
  assert.equal(out.turnRecovery.madeProgress, false);
});

test('без кода сигнал несёт только текст, а восстановившийся ход сигнала не несёт', () => {
  const silent = runTurn([
    {
      type: 'system',
      subtype: 'init',
      model: 'claude-opus-5',
      session_id: 's1',
    },
    cliSaid(API_ERROR),
    resultEvent(API_ERROR),
  ]);

  assert.deepEqual(silent.turnFailure, { message: API_ERROR });

  const recovered = runTurn([
    {
      type: 'system',
      subtype: 'init',
      model: 'claude-opus-5',
      session_id: 's1',
    },
    cliSaid(API_ERROR),
    modelReply('связь вернулась, готово'),
    resultEvent('связь вернулась, готово'),
  ]);

  assert.equal(recovered.deliveryFailure, false);
  assert.equal(recovered.turnFailure, undefined);
});

test('synthetic-текст в ленте не считается работой модели', () => {
  const out = runTurn([
    {
      type: 'system',
      subtype: 'init',
      model: 'claude-opus-5',
      session_id: 's1',
    },
    cliSaidWithCode('API Error: Connection error.', 'unknown'),
    resultEvent('API Error: Connection error.'),
  ]);

  assert.ok(out.steps.length > 0, 'в ленте есть synthetic-текст');
  assert.equal(out.turnRecovery.madeProgress, false, 'synthetic работой не является');
  assert.equal(out.turnRecovery.canContinue, true);
  assert.equal(out.sessionId, 's1');
});

test('настоящие текст, инструмент и положительная дельта рассуждений — работа модели', () => {
  const cases = [
    { name: 'текст модели', events: [modelReply('сейчас посмотрю')] },
    { name: 'вызов инструмента', events: [toolCall()] },
    {
      name: 'положительная дельта рассуждений',
      events: [{
        type: 'system',
        subtype: 'thinking_tokens',
        session_id: 's1',
        estimated_tokens_delta: 64,
      }],
    },
  ];

  for (const item of cases) {
    const out = runTurn([
      {
      type: 'system',
      subtype: 'init',
      model: 'claude-opus-5',
      session_id: 's1',
    },
      ...item.events,
      cliSaidWithCode('API Error: Connection error.', 'unknown'),
      resultEvent('API Error: Connection error.'),
    ]);

    assert.equal(out.turnRecovery.madeProgress, true, item.name);
  }
});

test('replay старых сообщений и служебные notices работой не считаются', () => {
  const cases = [
    {
      name: 'replay',
      events: [{ ...modelReply('старое'), isReplay: true }],
    },
    {
      name: 'нулевая дельта рассуждений',
      events: [{
        type: 'system',
        subtype: 'thinking_tokens',
        session_id: 's1',
        estimated_tokens_delta: 0,
      }],
    },
    {
      name: 'граница сжатия',
      events: [{
        type: 'system',
        subtype: 'compact_boundary',
        session_id: 's1',
        compactMetadata: {},
      }],
    },
    {
      name: 'init',
      events: [],
    },
  ];

  for (const item of cases) {
    const out = runTurn([
      {
      type: 'system',
      subtype: 'init',
      model: 'claude-opus-5',
      session_id: 's1',
    },
      ...item.events,
      cliSaidWithCode('API Error: Connection error.', 'unknown'),
      resultEvent('API Error: Connection error.'),
    ]);

    assert.equal(out.turnRecovery.madeProgress, false, item.name);
  }
});

test('вытесненный из ленты инструмент не отменяет подтверждённую работу', () => {
  const events = [
    {
      type: 'system',
      subtype: 'init',
      model: 'claude-opus-5',
      session_id: 's1',
    },
    toolCall(),
  ];

  // Лента хранит только хвост: последующие настоящие слова модели вытесняют инструмент
  // из окна хранения, и по ней одной работу уже не восстановить.
  for (let index = 0; index < 450; index += 1) {
    events.push(modelReply(`шаг ${index}`));
  }

  events.push(
    cliSaidWithCode('API Error: Connection error.', 'unknown'),
    resultEvent('API Error: Connection error.'),
  );

  const out = runTurn(events);
  const kinds = out.steps.map((step) => step.k);

  assert.equal(kinds.includes('tool'), false, 'инструмент вытеснен из ленты');
  assert.equal(out.steps[0].truncated, true, 'лента честно помечена усечённой');
  assert.equal(out.turnRecovery.madeProgress, true, 'признак не зависит от ленты');
});

test('без result текущей попытки одного fallback id для продолжения мало', () => {
  const collector = createClaudeTurnCollector();

  collector.push({
    type: 'system',
    subtype: 'init',
    model: 'claude-opus-5',
    session_id: 's1',
  });

  collector.push(cliSaidWithCode('API Error: Connection error.', 'unknown'));

  const out = buildClaudeTurnResult(collector, { fallbackSessionId: 's1' });

  // Прекращённый поток без result попытку не подтверждает: id здесь — запасной,
  // а разрешения продолжать нет вовсе, поэтому автоматика не запустится.
  assert.notEqual(out.deliveryFailure, true, 'окончательного исхода нет');
  assert.equal(out.turnRecovery, undefined, 'Р2 не подтверждён');
  assert.equal(out.turnFailure, undefined);
  assert.equal(out.sessionId, 's1', 'запасной id при этом сохранён');
});

test('новый collector той же сессии начинает признак работы заново', () => {
  const first = runTurn([
    {
      type: 'system',
      subtype: 'init',
      model: 'claude-opus-5',
      session_id: 's1',
    },
    modelReply('работал'),
    cliSaidWithCode('API Error: Connection error.', 'unknown'),
    resultEvent('API Error: Connection error.'),
  ]);

  assert.equal(first.turnRecovery.madeProgress, true);

  const second = runTurn([
    {
      type: 'system',
      subtype: 'init',
      model: 'claude-opus-5',
      session_id: 's1',
    },
    cliSaidWithCode('API Error: Connection error.', 'unknown'),
    resultEvent('API Error: Connection error.'),
  ]);

  assert.equal(second.turnRecovery.madeProgress, false, 'признак не наследуется');
});
