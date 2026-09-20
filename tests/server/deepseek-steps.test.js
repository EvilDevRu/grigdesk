import assert from 'node:assert/strict';
import test from 'node:test';

import { STEP_DIFF_LIMIT } from '../../server/src/lib/chat/streamSteps.ts';
import { createDeepSeekStepNormalizer } from '../../server/src/lib/deepseek/steps.ts';

// Первый tool-шаг одного update: перед ним нормализатор отдаёт ещё и `start`.
function firstTool(normalize, update) {
  return normalize({ update }).find((step) => step.k === 'tool');
}

test('размышление копится из кусков и отдаётся одним шагом перед действием', () => {
  const normalize = createDeepSeekStepNormalizer({ model: 'opaque', cwd: '/work', mode: 'auto' });
  const updates = [
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Сначала ' } },
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'посмотрю файл' } },
    { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'read', rawInput: { file_path: 'a.ts' } },
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Теперь отвечу' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'same' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'same' } },
    { sessionUpdate: 'usage_update', used: 1, size: 2 },
  ];
  const steps = updates.flatMap((update) => normalize({ update }));
  assert.deepEqual(steps.map((step) => step.k), ['start', 'think', 'tool', 'think', 'text', 'text']);
  assert.deepEqual(steps.filter((step) => step.k === 'think').map((step) => step.text), [
    'Сначала посмотрю файл', 'Теперь отвечу',
  ]);
  assert.deepEqual(steps.filter((step) => step.k === 'text').map((step) => step.text), ['same', 'same']);
  assert.equal(steps.some((step) => step.k === 'note'), false);
  assert.deepEqual(normalize.flush(), []);
});

test('хвост размышления без действия отдаётся по flush и ограничен по длине', () => {
  const normalize = createDeepSeekStepNormalizer();
  normalize({ update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'x'.repeat(20_000) } } });
  const tail = normalize.flush();
  assert.equal(tail.length, 1);
  assert.equal(tail[0].k, 'think');
  assert.ok(tail[0].text.length <= 6_100);
  assert.deepEqual(normalize.flush(), []);
});

test('таблица tool names даёт канонические шаги и один terminal result', () => {
  const normalize = createDeepSeekStepNormalizer();
  const calls = [
    ['bash', { command: 'printf ok' }, 'Bash'],
    ['read', { file_path: 'src/a.ts' }, 'Read'],
    ['write', { file_path: 'src/b.ts', content: 'const b = 1;\n' }, 'Write'],
    ['edit', { file_path: 'src/c.ts', old_string: 'a', new_string: 'b' }, 'Edit'],
    ['grep', { pattern: 'needle' }, 'Grep'],
    ['glob', { pattern: '**/*.ts' }, 'Glob'],
    ['mcp__cockpit-work__knowledge_search', { query: 'x' }, 'mcp__cockpit-work__knowledge_search'],
    ['future_tool', {}, 'future_tool'],
  ];
  const steps = calls.flatMap(([title, rawInput], index) => normalize({
    update: { sessionUpdate: 'tool_call', toolCallId: `tool-${index}`, title, rawInput },
  }));
  assert.deepEqual(steps.filter((step) => step.k === 'tool').map((step) => step.name),
    calls.map((entry) => entry[2]));

  const done = normalize({ update: {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tool-0',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
  } });
  const duplicate = normalize({ update: {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tool-0',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'again' } }],
  } });
  assert.equal(done.filter((step) => step.k === 'res').length, 1);
  assert.equal(duplicate.filter((step) => step.k === 'res').length, 0);
});

test('write отдаёт превью содержимого, edit — структурный diff из rawInput', () => {
  const write = firstTool(createDeepSeekStepNormalizer(), {
    sessionUpdate: 'tool_call', toolCallId: 'w1', title: 'write',
    rawInput: { file_path: 'src/b.ts', content: 'первая\nвторая\n' },
  });
  assert.equal(write.name, 'Write');
  assert.equal(write.title, 'b.ts');
  assert.equal(write.sub, 'src/b.ts');
  assert.equal(write.preview, 'первая\nвторая\n');
  assert.equal(write.lines, 3);
  assert.deepEqual(write.files, ['src/b.ts']);

  const edit = firstTool(createDeepSeekStepNormalizer(), {
    sessionUpdate: 'tool_call', toolCallId: 'e1', title: 'edit',
    rawInput: {
      file_path: 'src/c.ts', old_string: 'старое', new_string: 'новое', replace_all: true,
    },
  });
  assert.equal(edit.name, 'Edit');
  assert.deepEqual(edit.diff, { old: 'старое', new: 'новое', all: true });
  assert.deepEqual(edit.files, ['src/c.ts']);

  // Удаление (new_string пуст) остаётся диффом, а не пропадает.
  const removed = firstTool(createDeepSeekStepNormalizer(), {
    sessionUpdate: 'tool_call', toolCallId: 'e2', title: 'edit',
    rawInput: { file_path: 'src/d.ts', old_string: 'лишнее', new_string: '' },
  });
  assert.deepEqual(removed.diff, { old: 'лишнее', new: '', all: false });

  // Незнакомая форма правки без пары строк не рисует пустую рамку «было/стало».
  const bare = firstTool(createDeepSeekStepNormalizer(), {
    sessionUpdate: 'tool_call', toolCallId: 'e3', title: 'edit',
    rawInput: { file_path: 'src/e.ts' },
  });
  assert.equal('diff' in bare, false);
});

test('превью и diff правки ограничены STEP_DIFF_LIMIT и не раздувают ленту', () => {
  const big = 'x'.repeat(5_000);
  const write = firstTool(createDeepSeekStepNormalizer(), {
    sessionUpdate: 'tool_call', toolCallId: 'w2', title: 'write',
    rawInput: { file_path: 'big.ts', content: big },
  });
  assert.ok(write.preview.length <= STEP_DIFF_LIMIT + 1, 'превью обрезано');
  assert.equal(write.lines, 1);

  const edit = firstTool(createDeepSeekStepNormalizer(), {
    sessionUpdate: 'tool_call', toolCallId: 'e4', title: 'edit',
    rawInput: { file_path: 'big.ts', old_string: big, new_string: big },
  });
  assert.ok(edit.diff.old.length <= STEP_DIFF_LIMIT + 1, 'старое обрезано');
  assert.ok(edit.diff.new.length <= STEP_DIFF_LIMIT + 1, 'новое обрезано');
});
