import assert from 'node:assert/strict';
import test from 'node:test';

import { createClaudeTokenMeter } from '../../server/src/lib/executors/_claudeTokenMeter.ts';

const stream = (event, extra = {}) => ({
  type: 'stream_event',
  event,
  ...extra
});
const start = (id) => stream({ type: 'message_start', message: { id } });
const measure = (output_tokens) => stream({ type: 'message_delta', usage: { output_tokens } });
const stop = () => stream({ type: 'message_stop' });
const text = (id, value) => ({
  type: 'assistant',
  message: {
    id,
    model: 'fixture-model',
    usage: { input_tokens: 500, output_tokens: 1 },
    content: [{ type: 'text', text: value }],
  },
});
const thinking = (delta) => ({
  type: 'system',
  subtype: 'thinking_tokens',
  estimated_tokens_delta: delta,
});

test('R8: queued-обращение после result добавляет свой исправленный сегмент', () => {
  const meter = createClaudeTokenMeter();

  meter.push(start('first-segment'));
  meter.push(measure(120));
  meter.push(stop());
  meter.push({ type: 'result', usage: { output_tokens: 100 } });
  assert.deepEqual(meter.total(), { tokens: 100, tokensIsEstimate: false });

  meter.push(start('queued-segment'));
  meter.push(measure(80));
  assert.deepEqual(meter.total(), { tokens: 180, tokensIsEstimate: false });
  meter.push(stop());
  meter.push({ type: 'result', usage: { output_tokens: 50 } });
  assert.deepEqual(meter.total(), { tokens: 150, tokensIsEstimate: false });
});

test('R8: поправка result меняет только свой сегмент, включая точный ноль', () => {
  const meter = createClaudeTokenMeter();

  meter.push(start('first-segment'));
  meter.push(measure(120));
  meter.push({ type: 'result', usage: { output_tokens: 100 } });
  meter.push(start('queued-segment'));
  meter.push(text('queued-segment', 'abcdef'));
  assert.deepEqual(meter.total(), { tokens: 102, tokensIsEstimate: true });
  meter.push({ type: 'result', usage: { output_tokens: 50 } });
  meter.push({ type: 'result', usage: { output_tokens: 0 } });
  assert.deepEqual(meter.total(), { tokens: 100, tokensIsEstimate: false });
});

test('накопительные снимки 20 и 120 дают 120 без суммы дельт', () => {
  const meter = createClaudeTokenMeter();

  meter.push(start('a'));
  meter.push(measure(20));
  meter.push(measure(120));
  assert.deepEqual(meter.total(), { tokens: 120, tokensIsEstimate: false });
});

test('завершённые обращения 120 и 80 складываются, повторы снимков не прибавляются', () => {
  const meter = createClaudeTokenMeter();

  meter.push(start('a'));
  meter.push(measure(120));
  meter.push(measure(120));
  meter.push(stop());
  meter.push(start('b'));
  meter.push(measure(80));
  meter.push(measure(80));
  meter.push(stop());
  assert.equal(meter.total().tokens, 200);
});

test('полный assistant-блок не дублирует текст partial-потока', () => {
  const meter = createClaudeTokenMeter();

  meter.push(start('a'));
  meter.push(stream({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' }
  }));
  meter.push(stream({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'abcdef' }
  }));
  meter.push(text('a', 'abcdef'));
  assert.deepEqual(meter.total(), { tokens: 2, tokensIsEstimate: true });
});

test('аргументы инструмента считаются один раз при delta и полном блоке', () => {
  const meter = createClaudeTokenMeter();
  const input = { x: 'abcdef' };

  meter.push(start('a'));
  meter.push(stream({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use' }
  }));
  meter.push(stream({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
  }));
  meter.push({
    type: 'assistant',
    message: {
      id: 'a',
      model: 'fixture-model',
      content: [{ type: 'tool_use', input }]
    },
  });
  assert.equal(meter.total().tokens, Math.round(JSON.stringify(input).length / 3));
});

test('точный output уже включает system/thinking_tokens той же генерации', () => {
  const meter = createClaudeTokenMeter();

  meter.push(start('a'));
  meter.push(thinking(100));
  meter.push(text('a', 'abcdef'));
  meter.push(measure(120));
  meter.push(thinking(50));
  assert.deepEqual(meter.total(), { tokens: 120, tokensIsEstimate: false });
});

test('измеренный и оценённый вклады дают общую оценку', () => {
  const meter = createClaudeTokenMeter();

  meter.push(start('a'));
  meter.push(measure(120));
  meter.push(stop());
  meter.push(start('b'));
  meter.push(text('b', 'abcdef'));
  assert.deepEqual(meter.total(), { tokens: 122, tokensIsEstimate: true });
});

test('result заменяет 200 на 188 и снимает знак оценки', () => {
  const meter = createClaudeTokenMeter();

  meter.push(thinking(200));
  meter.push({ type: 'result', usage: { output_tokens: 188 } });
  meter.push(text('late', 'abcdef'));
  assert.deepEqual(meter.total(), { tokens: 188, tokensIsEstimate: false });
});

test('следующий пользовательский ход получает новый счётчик', () => {
  const previous = createClaudeTokenMeter();
  const next = createClaudeTokenMeter();

  previous.push({ type: 'result', usage: { output_tokens: 188 } });
  next.push(start('next'));
  next.push(measure(7));
  assert.equal(next.total().tokens, 7);
});

test('субагент и явный replay не меняют вклад основного агента', () => {
  const meter = createClaudeTokenMeter();

  meter.push(start('a'));
  meter.push(measure(20));
  meter.push({ ...start('sub'), parent_tool_use_id: 'tool-sub' });
  meter.push({ ...measure(999), parent_tool_use_id: 'tool-sub' });
  meter.push({ ...text('a', 'повтор'), isReplay: true });
  meter.push({ ...measure(999), isReplay: true });
  assert.equal(meter.total().tokens, 20);
});

test('повтор message_start с тем же id и меньшим output открывает отдельный ответ', () => {
  const meter = createClaudeTokenMeter();

  meter.push(start('same'));
  meter.push(measure(120));
  meter.push(stop());
  meter.push(start('same'));
  meter.push(measure(80));
  meter.push(measure(70));
  assert.equal(meter.total().tokens, 200);
});

test('отсутствующий usage не обнуляет измерение, подтверждённый 0 принимается', () => {
  const meter = createClaudeTokenMeter();

  meter.push(start('a'));
  meter.push(measure(120));
  meter.push(measure(undefined));
  meter.push(measure(null));
  assert.equal(meter.total().tokens, 120);
  meter.push(stop());
  meter.push(start('b'));
  meter.push(measure(0));
  assert.deepEqual(meter.total(), { tokens: 120, tokensIsEstimate: false });
});

test('синтетический message_stop сохраняет оценку оборванного ответа', () => {
  const meter = createClaudeTokenMeter();

  meter.push(start('a'));
  meter.push(text('a', 'abcdef'));
  meter.push(stream({ type: 'message_stop' }, {
    abandoned_blocks: { api_message_id: 'a', from_block_index: 0 },
  }));
  assert.deepEqual(meter.total(), { tokens: 2, tokensIsEstimate: true });
});
