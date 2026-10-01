import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyCodexFailure,
  inspectCodexFailure,
  runnerFailureDetail,
} from '../../server/src/lib/runnerFailure.ts';

const capacity = 'Selected model is at capacity. Please try a different model.';
const failed = (message) => JSON.stringify({ type: 'turn.failed', error: { message } });
const stream = (...events) => events.map((event) => JSON.stringify(event)).join('\n');

test('перегрузка после работы остаётся transient и получает понятное пояснение', () => {
  const raw = stream(
    { type: 'item.completed', item: { type: 'command_execution', exit_code: 0 } },
    { type: 'error', message: capacity },
    { type: 'turn.failed', error: { message: capacity } },
  );
  const evidence = inspectCodexFailure(raw);

  assert.equal(classifyCodexFailure(raw, 1, true), 'transient');
  assert.equal(evidence.failure.code, 'capacity');
  assert.equal(evidence.failure.message, capacity);
  assert.match(runnerFailureDetail(evidence.failure, 'example-sol'), /модель «example-sol» перегружена/);
});

test('неизвестный отказ сохраняет текст, не разрешая смену исполнителя', () => {
  const raw = failed('Unexpected provider failure E_CUSTOM');
  const evidence = inspectCodexFailure(raw);

  assert.equal(classifyCodexFailure(raw, 1, true), 'unknown');
  assert.match(runnerFailureDetail(evidence.failure), /Unexpected provider failure E_CUSTOM/);
});

test('ошибки в командах и сообщениях агента не становятся ошибками провайдера', () => {
  const raw = stream({
    type: 'item.completed',
    item: { type: 'command_execution', aggregated_output: failed(capacity) },
  });

  assert.equal(inspectCodexFailure(raw).failure, null);
  assert.equal(classifyCodexFailure(raw, 1, true), 'unknown');
});

test('восстановившийся ход не наследует предыдущий отказ', () => {
  for (const event of [
    { type: 'turn.completed', usage: {} },
    { type: 'turn.started' },
    { type: 'thread.started' },
    { type: 'item.started', item: { type: 'command_execution' } },
  ]) {
    const raw = `${failed(capacity)}\n${JSON.stringify(event)}`;

    assert.equal(inspectCodexFailure(raw).failure, null);
  }
});

test('auth после работы или повреждения потока не разрешает переключение', () => {
  const auth = JSON.stringify({ type: 'turn.failed', error: { type: 'authentication_error', status: 401 } });

  assert.equal(classifyCodexFailure(auth, 1, true), 'provider_unavailable');
  assert.equal(classifyCodexFailure(`bad json\n${auth}`, 1, true), 'unknown');
  assert.equal(classifyCodexFailure(`{"type":"new.unknown.event"}\n${auth}`, 1, true), 'unknown');
  assert.equal(classifyCodexFailure(`{"type":"item.started"}\n${auth}`, 1, true), 'unknown');
  assert.equal(classifyCodexFailure(auth, 1, false), 'unknown');
});

test('код завершения важнее текста прошлой ошибки', () => {
  assert.equal(classifyCodexFailure(failed(capacity), 0, true), 'ok');
  assert.equal(classifyCodexFailure(failed(capacity), 124, true), 'timeout');
});

test('сообщение ограничено одной строкой и не раскрывает типичные секреты', () => {
  const raw = failed('Bearer secret-value token=another-secret https://host.invalid/?key=hidden\n'
    + '\u001b[31mFAIL\u001b[0m\u202e' + 'x'.repeat(1500));
  const message = inspectCodexFailure(raw).failure.message;

  assert.doesNotMatch(message, /secret-value|another-secret|hidden|\n|\u001b|\u202e/);
  assert.ok(message.length <= 500);
  assert.match(message, /FAIL/);
});
