import assert from 'node:assert/strict';
import test from 'node:test';

import { acpToolStep } from '../../server/src/lib/chat/acpSteps.ts';

const state = (over = {}) => ({
  id: 't1',
  kind: '',
  title: '',
  rawInput: {},
  locations: [],
  text: '',
  diffs: [],
  ...over,
});

test('ACP строка: execute показывает команду и Bash', () => {
  const step = acpToolStep(state({
    kind: 'execute',
    title: 'run_shell_command',
    rawInput: { command: 'git status\nnpm test' },
  }));

  assert.equal(step.name, 'Bash');
  assert.equal(step.title, 'git status');
  assert.equal(step.command, 'git status\nnpm test');
});

test('ACP строка: read показывает путь и базу имени', () => {
  const step = acpToolStep(state({
    kind: 'read',
    title: 'read_file',
    rawInput: { file_path: '/w/src/main.ts' },
  }));

  assert.equal(step.name, 'Read');
  assert.equal(step.title, 'main.ts');
  assert.equal(step.sub, '/w/src/main.ts');
});

test('ACP строка: edit собирает дифф из rawInput и files', () => {
  const step = acpToolStep(state({
    kind: 'edit',
    title: 'edit',
    rawInput: {
      file_path: '/w/a.ts',
      old_string: 'было',
      new_string: 'стало',
    },
  }));

  assert.equal(step.name, 'Edit');
  assert.deepEqual(step.files, ['/w/a.ts']);
  assert.deepEqual(step.changes, [{
    path: '/w/a.ts',
    kind: 'update',
    diff: { old: 'было', new: 'стало' },
  }]);
  assert.equal(step.preview, '');
});

test('ACP строка: незнакомый инструмент сохраняет имя и превью аргументов', () => {
  const step = acpToolStep(state({
    kind: 'other',
    title: 'mcp__srv__lookup',
    rawInput: { query: 'baseline' },
  }));

  assert.equal(step.name, 'mcp__srv__lookup');
  assert.equal(step.preview, JSON.stringify({ query: 'baseline' }));
});

test('ACP строка: двадцать файлов и бюджет диффа сохранены', () => {
  const diffs = Array.from({ length: 25 }, (_, index) => ({
    path: `/w/f${index}.ts`,
    old: 'x'.repeat(2000),
    new: 'y'.repeat(2000),
  }));
  const step = acpToolStep(state({
    kind: 'edit',
    title: 'Edit',
    diffs,
  }));

  assert.equal(step.files.length, 20);
  assert.equal(step.changes.length, 20);
  assert.ok(step.omittedChanges >= 5);

  const bytes = step.changes.reduce((sum, change) => (
    sum + Buffer.byteLength(change.diff.old) + Buffer.byteLength(change.diff.new)
  ), 0);

  assert.ok(bytes <= 16 * 1024);
});
