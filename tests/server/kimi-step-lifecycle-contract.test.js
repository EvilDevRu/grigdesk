// Проверяет нормализацию жизненного цикла Kimi и отображение изменений файлов.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createKimiStepNormalizer } from '../../server/src/lib/executors/_kimi-steps.js';
import { lineDiff, unifiedDiff } from '../../web/src/shared/diff.js';

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/kimi-acp-tool-lifecycle.json', import.meta.url),
  'utf8',
));

const CHANGE_FILE_LIMIT = 20;
const DIFF_TEXT_BUDGET = 16 * 1024;
const CHANGE_PATH_LIMIT = 500;

function normalizeEvents(events) {
  const normalize = createKimiStepNormalizer({
    model: 'kimi-code/k3',
    cwd: '/workspace',
    mode: 'default',
  });
  const steps = events.flatMap((params) => normalize(params));
  steps.push(...normalize.flush());
  return steps;
}

function statsOf(diff) {
  return typeof diff === 'string'
    ? unifiedDiff(diff)
    : lineDiff(diff?.old, diff?.new);
}

function visibleSidesOf(diff) {
  if (diff && typeof diff === 'object') {
    return { removed: String(diff.old || ''), added: String(diff.new || '') };
  }
  const parsed = unifiedDiff(diff);
  return {
    removed: parsed.rows.filter((row) => row.t === 'del').map((row) => row.text).join('\n'),
    added: parsed.rows.filter((row) => row.t === 'add').map((row) => row.text).join('\n'),
  };
}

function diffTextBytes(diff) {
  if (typeof diff === 'string') return Buffer.byteLength(diff);
  return Buffer.byteLength(String(diff?.old || '')) + Buffer.byteLength(String(diff?.new || ''));
}

function editLifecycle(id, diffs) {
  return [
    { update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: id,
      status: 'in_progress',
      title: 'Edit files',
      kind: 'edit',
      rawInput: { patch: `edit ${diffs.length} files` },
      locations: diffs.map((diff) => ({ path: diff.path })),
      content: diffs.map((diff) => ({
        type: 'diff', path: diff.path, oldText: diff.old, newText: diff.new,
      })),
    } },
    { update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: id,
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'done' } }],
    } },
  ];
}

test('Kimi собирает sparse ACP lifecycle в один полный Edit и один result', () => {
  const steps = normalizeEvents(fixture.events);

  assert.equal(steps.filter((step) => step.k === 'start').length, 1);
  const actionSteps = steps.filter((step) => step.k === 'tool' || step.k === 'res');
  assert.deepEqual(actionSteps.map(({ k, id }) => ({ k, id })), [
    { k: 'tool', id: fixture.expected.toolCallId },
    { k: 'res', id: fixture.expected.toolCallId },
  ]);

  const [tool, result] = actionSteps;
  assert.equal(tool.name, 'Edit');
  assert.deepEqual(tool.files, fixture.expected.files);
  assert.equal(tool.changes?.length, fixture.expected.changes.length);

  for (const [index, expected] of fixture.expected.changes.entries()) {
    const change = tool.changes[index];
    assert.equal(change.path, expected.path);
    assert.equal(change.kind, expected.kind);
    assert.deepEqual(change.diff, { old: expected.old, new: expected.new });
  }

  assert.equal(result.ok, true);
  assert.equal(result.text, fixture.expected.result);
});

test('Kimi не понижает накопленный Edit последующей sparse-дельтой kind=other', () => {
  const steps = normalizeEvents(fixture.downgradeEvents);
  const actionSteps = steps.filter((step) => step.k === 'tool' || step.k === 'res');
  assert.deepEqual(actionSteps.map(({ k, id }) => ({ k, id })), [
    { k: 'tool', id: fixture.downgradeExpected.toolCallId },
    { k: 'res', id: fixture.downgradeExpected.toolCallId },
  ]);

  const [tool, result] = actionSteps;
  assert.equal(tool.name, 'Edit');
  assert.deepEqual(tool.files, [fixture.downgradeExpected.file]);
  assert.deepEqual(tool.changes, [{
    path: fixture.downgradeExpected.file,
    kind: 'update',
    diff: {
      old: fixture.downgradeExpected.old,
      new: fixture.downgradeExpected.new,
    },
  }]);
  assert.equal(result.text, fixture.downgradeExpected.result);
});

test('Kimi сохраняет pending kind=edit через sparse kind=other даже без structured diff', () => {
  const steps = normalizeEvents(fixture.kindDowngradeEvents);
  const actionSteps = steps.filter((step) => step.k === 'tool' || step.k === 'res');
  assert.deepEqual(actionSteps.map(({ k, id }) => ({ k, id })), [
    { k: 'tool', id: fixture.kindDowngradeExpected.toolCallId },
    { k: 'res', id: fixture.kindDowngradeExpected.toolCallId },
  ]);

  const [tool, result] = actionSteps;
  assert.equal(tool.name, 'Edit');
  assert.deepEqual(tool.files, [fixture.kindDowngradeExpected.file]);
  assert.equal(result.text, fixture.kindDowngradeExpected.result);
});

test('Kimi ждёт поздний structured diff после canonical edit upgrade', () => {
  const file = 'src/late-diff.js';
  const steps = normalizeEvents([
    { update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'kimi-late-diff',
      status: 'in_progress',
      title: 'Edit file',
      kind: 'edit',
      rawInput: { path: file },
      locations: [{ path: file }],
    } },
    { update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'kimi-late-diff',
      status: 'in_progress',
      content: [{
        type: 'diff', path: file,
        oldText: 'export const ready = false;\n',
        newText: 'export const ready = true;\n',
      }],
    } },
    { update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'kimi-late-diff',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'done' } }],
    } },
  ]);

  const tools = steps.filter((step) => step.k === 'tool');
  assert.equal(tools.length, 1);
  assert.deepEqual(tools[0].changes, [{
    path: file,
    kind: 'update',
    diff: {
      old: 'export const ready = false;\n',
      new: 'export const ready = true;\n',
    },
  }]);
});

test('Kimi diff сохраняет общую строку контекстом и считает только реальную замену', () => {
  const tool = normalizeEvents(fixture.downgradeEvents).find((step) => step.k === 'tool');
  const stat = statsOf(tool.changes[0].diff);
  assert.deepEqual({ added: stat.added, removed: stat.removed }, { added: 1, removed: 1 });
});

test('Kimi сокращает большой diff сбалансированно и оставляет видимыми обе стороны', () => {
  const old = [
    'OLD-BEGIN',
    ...Array.from({ length: 500 }, (_, index) => `old-${index}-${'x'.repeat(24)}`),
    'OLD-END',
  ].join('\n');
  const next = [
    'NEW-BEGIN',
    ...Array.from({ length: 500 }, (_, index) => `new-${index}-${'y'.repeat(24)}`),
    'NEW-END',
  ].join('\n');
  const tool = normalizeEvents(editLifecycle('kimi-large-edit', [{
    path: 'src/large.js', old, new: next,
  }])).find((step) => step.k === 'tool');
  const diff = tool.changes[0].diff;
  const visible = visibleSidesOf(diff);

  assert.ok(diffTextBytes(diff) <= DIFF_TEXT_BUDGET);
  assert.match(visible.removed, /OLD-BEGIN/);
  assert.match(visible.removed, /OLD-END/);
  assert.match(visible.added, /NEW-BEGIN/);
  assert.match(visible.added, /NEW-END/);
  const stat = statsOf(diff);
  assert.ok(stat.removed > 0, 'после сокращения должны остаться удалённые строки');
  assert.ok(stat.added > 0, 'после сокращения должны остаться добавленные строки');
});

test('Kimi ограничивает число файлов и общий объём diff одного tool-step', () => {
  const total = 75;
  const diffs = Array.from({ length: total }, (_, index) => ({
    path: `src/generated/file-${String(index).padStart(2, '0')}.js`,
    old: `export const value = ${index};\n`,
    new: `export const value = ${index + 1};\n`,
  }));
  const tool = normalizeEvents(editLifecycle('kimi-many-files', diffs))
    .find((step) => step.k === 'tool');

  assert.equal(tool.changes.length, CHANGE_FILE_LIMIT);
  assert.equal(tool.files.length, CHANGE_FILE_LIMIT);
  assert.equal(tool.omittedChanges, total - CHANGE_FILE_LIMIT);
  assert.match(tool.preview, new RegExp(`ещё ${total - CHANGE_FILE_LIMIT} файлов`));
  assert.ok(
    tool.changes.reduce((sum, change) => sum + diffTextBytes(change.diff), 0) <= DIFF_TEXT_BUDGET,
    'суммарный diff-text одного шага обязан быть bounded',
  );
});

test('Kimi ограничивает аномально длинные пути в rich step', () => {
  const path = `src/${'очень-длинный-путь-'.repeat(2_000)}file.js`;
  const tool = normalizeEvents(editLifecycle('kimi-long-path', [{
    path,
    old: 'old\n',
    new: 'new\n',
  }])).find((step) => step.k === 'tool');

  assert.ok(tool.files[0].length <= CHANGE_PATH_LIMIT);
  assert.ok(tool.changes[0].path.length <= CHANGE_PATH_LIMIT);
  assert.ok(tool.sub.length <= CHANGE_PATH_LIMIT);
});
