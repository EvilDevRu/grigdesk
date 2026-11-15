import assert from 'node:assert/strict';
import test from 'node:test';

import { HELP_TEXT, parseArgs } from '../../voice/src/args.ts';

test('voice-args-help-text-содержит-команды', () => {
  for (const command of ['engines', 'models', 'voices', 'generate', 'install', 'version']) {
    assert.match(HELP_TEXT, new RegExp(command, 'u'));
  }
});

test('voice-args-parse-generate', () => {
  const parsed = parseArgs([
    'generate', '--engine', 'qwen', '--voice', 'Cherry',
    '--text', 'привет', '--out', '/tmp/a.wav',
  ]);

  assert.ok(!('error' in parsed));
  assert.equal(parsed.command, 'generate');
  assert.equal(parsed.engine, 'qwen');
  assert.equal(parsed.voice, 'Cherry');
  assert.equal(parsed.text, 'привет');
  assert.equal(parsed.out, '/tmp/a.wav');
});

test('voice-args-generate-требует-текст-или-файл', () => {
  const parsed = parseArgs(['generate', '--engine', 'qwen']);

  assert.ok('error' in parsed);
  assert.match(parsed.error, /--text или --file/u);
});

test('voice-args-неизвестный-флаг-ошибка', () => {
  const parsed = parseArgs(['generate', '--engine', 'qwen', '--text', 'а', '--нет']);

  assert.ok('error' in parsed);
  assert.match(parsed.error, /неизвестный/u);
});

test('voice-args-текст-и-файл-вместе-ошибка', () => {
  const parsed = parseArgs(['generate', '--text', 'а', '--file', 'b.txt']);

  assert.ok('error' in parsed);
  assert.match(parsed.error, /либо --text, либо --file/u);
});

test('voice-args-пустая-команда-это-help', () => {
  const parsed = parseArgs([]);

  assert.ok(!('error' in parsed));
  assert.equal(parsed.command, 'help');
});
