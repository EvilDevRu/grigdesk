import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { parseArgs } from '../../cli/args.ts';
import { completed, createSandbox } from './helpers/sandbox.mts';

test('CE-1 пустой argv и force', () => {
  assert.equal(parseArgs([]).kind, 'open');
  assert.equal(parseArgs([]).force, false);
  assert.equal(parseArgs(['open', '--force']).force, true);
});

test('CE-2 сервер, посредник и журнал', () => {
  for (const group of ['server', 'relay']) {
    for (const action of ['start', 'stop', 'restart', 'status', 'logs']) {
      const args = parseArgs([group, action]);

      assert.equal(args.kind, group);
      assert.equal(args.action, action);
    }
  }

  const args = parseArgs(['server', 'logs', '-n', '5', '-f']);

  assert.equal(args.lines, 5);
  assert.equal(args.follow, true);
  assert.equal(parseArgs(['relay', 'logs']).lines, 100);
});

test('CE-3 ошибки аргументов', () => {
  const cases: [string[], RegExp][] = [
    [['frobnicate'], /Неизвестная команда: frobnicate\. Справка: cockpit --help/],
    [['server'], /Не указано действие: cockpit server start \| stop \| restart \| status \| logs/],
    [['server', 'start', '--json'], /Неизвестный флаг/],
    [['relay', 'start', '--force'], /Неизвестный флаг/],
    [['server', 'status', '--wait'], /Неизвестный флаг/],
    [['status', 'extra'], /Неизвестная команда/],
  ];

  for (const [argv, fragment] of cases) {
    assert.throws(() => parseArgs(argv), fragment);
  }

  for (const tail of [['0'], ['abc'], [], ['10001'], ['1.5'], ['-f']]) {
    assert.throws(() => parseArgs(['server', 'logs', '-n', ...tail]), /Число строк/);
  }
});

test('CE-4 справка и версия', () => {
  for (const argv of [['--help'], ['-h'], ['help'], ['server', '--help'], ['relay', '--help']]) {
    assert.equal(parseArgs(argv).kind, 'help');
  }

  // Справку просят и после подкоманды: это не ошибка аргументов.
  for (const argv of [['status', '--help'], ['server', 'start', '-h'], ['relay', 'logs', '-n', '5', '--help'],
    ['open', '--help'], ['server', '-h']]) {
    assert.equal(parseArgs(argv).kind, 'help');
  }

  assert.equal(parseArgs(['--version']).kind, 'version');
  assert.throws(() => parseArgs(['--version', 'x']), /Неизвестная команда/);
});

test('CE-5 справка без эффектов', async (t) => {
  const box = await createSandbox(t);
  const result = await box.run(['--help']);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /cockpit server start/);
  assert.match(result.stdout, /cockpit relay logs/);
  assert.deepEqual(box.calls(), []);
});

test('CE-6 версия из своего корня', async (t) => {
  const box = await createSandbox(t);

  writeFileSync(path.join(box.root, 'VERSION'), '9.8.7\n');

  const result = await box.run(['--version']);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'Кокпит 9.8.7\n');
  assert.deepEqual(box.calls(), []);
});

test('CE-7 неизвестная команда не делает эффектов', async (t) => {
  const box = await createSandbox(t);
  const result = await box.run(['frobnicate']);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /Неизвестная команда/);
  assert.deepEqual(box.calls(), []);
});

test('CE-8 ссылка из каталога с пробелами, cwd /', async (t) => {
  const box = await createSandbox(t);
  const directory = path.join(box.home, 'ссылки с пробелами');
  const link = path.join(directory, 'cockpit');

  mkdirSync(directory);
  symlinkSync(path.join(box.root, 'bin/cockpit'), link);
  writeFileSync(path.join(box.root, 'VERSION'), '9.8.7\n');

  const result = await completed(spawn('bash', [link, '--version'], {
    cwd: '/',
    env: box.environment,
  }));

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'Кокпит 9.8.7\n');
});

test('CE-9 старые скрипты получают argv и возвращают код', async (t) => {
  const box = await createSandbox(t);

  for (const command of ['desktop', 'b24', 'mobile', 'release']) {
    const result = await box.run([command, 'example', 'two words']);

    assert.equal(result.code, 7, result.stderr);
    assert.ok(box.calls().includes(`${command} example two words`));
  }
});

test('CE-10 старый Node отвергается до TypeScript', async (t) => {
  const box = await createSandbox(t);

  writeFileSync(path.join(box.home, 'stubs/node'), '#!/bin/bash\necho 20.0.0\n', { mode: 0o755 });

  const result = await box.run(['--help']);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Cockpit требует Node/);
  assert.deepEqual(box.calls(), []);
});

test('CE-11 справка команд разработчика ничего не собирает и не запускает', async (t) => {
  const box = await createSandbox(t);

  // dev в проверку не входит: на прежнем коде он оставил бы сиротский node --watch.
  for (const argv of [['build', '--help'], ['run', '-h'], ['deps', '--help']]) {
    const result = await box.run(argv);

    assert.equal(result.code, 0, `${argv.join(' ')}: ${result.stderr}`);
    assert.match(result.stdout, /cockpit dev \| build \| deps \| run/, argv.join(' '));
    assert.doesNotMatch(result.stdout + result.stderr, /Сборка web|npm i|уже слушает/, argv.join(' '));
  }

  assert.deepEqual(box.calls(), []);
});

/**
 * Минимальный TS-вход b24 в корне песочницы: печатает argv JSON и выходит с кодом 7.
 * Маркер запуска позволяет доказать, что fallback не исполнялся.
 */
function installB24Source(root: string, marker: string): void {
  mkdirSync(path.join(root, 'b24/src'), { recursive: true });
  writeFileSync(path.join(root, 'b24/package.json'), '{"private": true, "type": "module"}\n');
  writeFileSync(path.join(root, 'b24/src/main.ts'), [
    "import { writeFileSync } from 'node:fs';",
    '',
    `writeFileSync(${JSON.stringify(marker)}, 'source');`,
    "process.stdout.write(`${JSON.stringify(process.argv.slice(2))}\\n`);",
    'process.exitCode = 7;',
    '',
  ].join('\n'));
}

/**
 * Песочница CLI с исходником b24 и путём маркера fallback.
 * Заглушка bin/b24 песочницы остаётся, пока тест сам её не уберёт.
 */
async function b24Sandbox(t: TestContext) {
  const box = await createSandbox(t);
  const marker = path.join(box.home, 'source-started');

  installB24Source(box.root, marker);

  return {
    box,
    marker,
  };
}

test('CE-B24-1: без бинарника cockpit запускает source и передаёт argv', async (t) => {
  const { box, marker } = await b24Sandbox(t);

  rmSync(path.join(box.root, 'bin/b24'));

  const result = await box.run(['b24', 'comment', '42', 'два слова', '']);

  assert.equal(result.code, 7, result.stderr);
  assert.equal(result.stdout, `${JSON.stringify(['comment', '42', 'два слова', ''])}\n`);
  assert.equal(result.stderr, '');
  assert.equal(existsSync(marker), true);
});

test('CE-B24-2: готовый b24 не требует Node', async (t) => {
  const { box, marker } = await b24Sandbox(t);

  // Заглушка готового файла печатает каждый аргумент отдельной строкой: так видно точный argv.
  writeFileSync(path.join(box.root, 'bin/b24'), '#!/bin/bash\nprintf \'<%s>\\n\' "$@"\nexit 5\n', {
    mode: 0o755,
  });
  writeFileSync(path.join(box.home, 'stubs/node'), [
    '#!/bin/bash',
    'echo node >> "$STUB_HOME/calls.log"',
    'exit 99',
    '',
  ].join('\n'), { mode: 0o755 });

  const result = await box.run(['b24', 'users', 'Иван Петров']);

  assert.equal(result.code, 5, result.stderr);
  assert.equal(result.stdout, '<users>\n<Иван Петров>\n');
  assert.deepEqual(box.calls(), []);
  assert.equal(existsSync(marker), false);
});

test('CE-B24-3: ошибка готового b24 не запускает fallback', async (t) => {
  const { box, marker } = await b24Sandbox(t);

  writeFileSync(path.join(box.root, 'bin/b24'), '#!/bin/bash\necho "Запрос к Cockpit" >&2\nexit 22\n',
    { mode: 0o755 });

  const result = await box.run(['b24', 'start', '42']);

  assert.equal(result.code, 22);
  assert.equal(result.stdout, '');
  assert.equal(existsSync(marker), false);
});
