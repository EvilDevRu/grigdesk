import assert from 'node:assert/strict';
import test from 'node:test';

import { HELP_TEXT, parseArgs } from '../../tracker/src/args.ts';
import type { Command } from '../../tracker/src/args.ts';

const RUSSIAN = /[А-Яа-яЁё]/;

/**
 * Проверяет, что разбор отвергает argv с русской причиной.
 * Справку к причине добавляет app, поэтому здесь сверяется только message.
 */
function rejects(argv: readonly string[]): void {
  assert.throws(() => parseArgs(argv), (error: unknown) => {
    assert.ok(error instanceof Error, `ожидалась ошибка для ${JSON.stringify(argv)}`);
    assert.match(error.message, RUSSIAN, JSON.stringify(argv));

    return true;
  });
}

test('BA-01: все команды разбираются без потери аргументов', () => {
  const cases: Array<[string[], Command]> = [
    [['dashboard'], { kind: 'dashboard' }],
    [['task', '42'], { kind: 'task', id: '42' }],
    [['task', '007'], { kind: 'task', id: '007' }],
    [['comment', '42', 'текст'], {
      kind: 'comment',
      id: '42',
      text: 'текст',
    }],
    [['timer', '42', 'start'], {
      kind: 'timer',
      id: '42',
      action: 'start',
    }],
    [['timer', '42', 'pause'], {
      kind: 'timer',
      id: '42',
      action: 'pause',
    }],
    [['timer', '42', 'stop'], {
      kind: 'timer',
      id: '42',
      action: 'stop',
    }],
    [['start', '42'], { kind: 'start', id: '42' }],
    [['complete', '42'], { kind: 'complete', id: '42' }],
    [['renew', '0042'], { kind: 'renew', id: '0042' }],
    [['create'], { kind: 'create' }],
    [['users'], { kind: 'users', query: '' }],
    [['users', 'Иван Петров'], { kind: 'users', query: 'Иван Петров' }],
  ];

  for (const [argv, expected] of cases) {
    assert.deepEqual(parseArgs(argv), expected, argv.join(' '));
  }
});

test('BA-02: comment объединяет аргументы одним пробелом', () => {
  const words = ['Привет, мир 🌍', 'два  пробела', '', '', '"кавычки" и \'апостроф\'', 'C:\\путь\\',
    'строка\nперенос', '$(rm -rf /)', '`id`', '--help'];
  const parsed = parseArgs(['comment', '42', ...words]);

  assert.deepEqual(parsed, {
    kind: 'comment',
    id: '42',
    text: words.join(' '),
  });
  assert.deepEqual(parseArgs(['comment', '42', '']), {
    kind: 'comment',
    id: '42',
    text: '',
  });
});

test('BA-03: неверный argv даёт русскую причину и справку', () => {
  const invalid: string[][] = [
    [],
    ['frobnicate'],
    ['task'],
    ['task', ''],
    ['comment'],
    ['comment', '42'],
    ['comment', '', 'текст'],
    ['timer', '42'],
    ['timer', '42', 'resume'],
    ['timer', '', 'start'],
    ['dashboard', 'extra'],
    ['task', '42', 'extra'],
    ['start', '42', 'extra'],
    ['complete', '42', 'extra'],
    ['renew', '42', 'extra'],
    ['create', 'extra'],
    ['users', 'Иван', 'Петров'],
    ['timer', '42', 'start', 'extra'],
    ['--help', 'extra'],
    ['-h', 'extra'],
    ['--version', 'extra'],
    ['--license', 'extra'],
  ];

  for (const argv of invalid) {
    rejects(argv);
  }

  for (const command of ['dashboard', 'task', 'comment', 'timer', 'start', 'complete', 'renew', 'create',
    'users']) {
    assert.ok(HELP_TEXT.includes(`tracker ${command}`), command);
  }

  assert.match(HELP_TEXT, RUSSIAN);
  assert.ok(HELP_TEXT.endsWith('\n'));
});

test('BA-04: локальные флаги допустимы только отдельно', () => {
  assert.deepEqual(parseArgs(['--help']), { kind: 'help' });
  assert.deepEqual(parseArgs(['-h']), { kind: 'help' });
  assert.deepEqual(parseArgs(['--version']), { kind: 'version' });
  assert.deepEqual(parseArgs(['--license']), { kind: 'license' });
  assert.deepEqual(parseArgs(['comment', '42', '--help']), {
    kind: 'comment',
    id: '42',
    text: '--help',
  });
});

test('MD-CLI-ARGS: boards, цель до и после команды, буквальный хвост после --', () => {
  assert.deepEqual(parseArgs(['boards']), { kind: 'boards' });

  for (const argv of [['--board', 'fixture-a', 'task', '42'], ['task', '42', '--board', 'fixture-a']]) {
    assert.deepEqual(parseArgs(argv), {
      kind: 'task',
      id: '42',
      board: 'fixture-a',
    });
  }

  assert.deepEqual(parseArgs(['--board', 'fixture-a', 'comment', '42', '--', '--board', 'текст']), {
    kind: 'comment',
    id: '42',
    board: 'fixture-a',
    text: '--board текст',
  });

  for (const argv of [
    ['--board', '', 'create'],
    ['create', '--board'],
    ['--board', 'fixture-a', 'create', '--board', 'fixture-b'],
    ['boards', '--board', 'fixture-a'],
    ['--help', '--board', 'fixture-a'],
    ['--version', '--board', 'fixture-a'],
  ]) {
    rejects(argv);
  }
});

test('SOURCE-CLI-ARGS: analyze, launch-options, launch принимают адресную доску до и после', () => {
  for (const kind of ['analyze', 'launch-options', 'launch']) {
    assert.deepEqual(parseArgs([kind, '0042']), { kind, id: '0042' });

    for (const argv of [
      ['--board', 'fixture-a', kind, '42'],
      [kind, '42', '--board', 'fixture-a'],
    ]) {
      assert.deepEqual(parseArgs(argv), {
        kind,
        id: '42',
        board: 'fixture-a',
      });
    }

    assert.ok(HELP_TEXT.includes(`tracker ${kind}`));

    for (const argv of [[kind], [kind, ''], [kind, '42', 'extra'], [kind, '42', '--board']]) {
      rejects(argv);
    }
  }
});
