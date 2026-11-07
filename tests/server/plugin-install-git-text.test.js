import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parsePluginTags,
  parseGitProgress,
  classifyGitFailure,
  completeGitStdout,
  parsePluginCommits,
  parsePluginChangedFiles,
} from '../../server/src/lib/packageInstall/gitText.ts';

import { runCommand } from '../../server/src/lib/packageInstall/runCommand.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

test('T1: peeled SHA аннотированного тега побеждает при любом порядке', () => {
  for (const lines of [
    [`${A}\trefs/tags/v1.0.0`, `${B}\trefs/tags/v1.0.0^{}`],
    [`${B}\trefs/tags/v1.0.0^{}`, `${A}\trefs/tags/v1.0.0`],
  ]) {
    assert.deepEqual(parsePluginTags(lines.join('\n')), [{
      version: '1.0.0',
      tag: 'v1.0.0',
      sha: B,
    }]);
  }
});

test('T2: простой тег использует единственный SHA', () => {
  assert.deepEqual(parsePluginTags(`${A}\trefs/tags/v1.0.0`), [{
    version: '1.0.0',
    tag: 'v1.0.0',
    sha: A,
  }]);
});

test('T3: stable tag фильтрует latest, неполные и prerelease версии', () => {
  const lines = ['latest', 'v1.0', '1.0.0', 'v1.0.0-rc1']
    .map((tag) => `${A}\trefs/tags/${tag}`);

  assert.deepEqual(parsePluginTags(lines.join('\n')), []);
});

test('T4: числовая SemVer сортировка и нижний регистр SHA', () => {
  const lines = ['v1.9.0', 'v1.2.3', 'v1.10.0'].map((tag) => `${A.toUpperCase()}\trefs/tags/${tag}`);
  const result = parsePluginTags(lines.join('\n'));

  assert.deepEqual(result.map((entry) => entry.version), ['1.10.0', '1.9.0', '1.2.3']);
  assert.ok(result.every((entry) => entry.sha === A));
});

test('T5: SHA только 40/64 hex, мусор и неизвестный тип не образуют refs', () => {
  const lines = [
    '', 'мусор', `${'c'.repeat(64)}\trefs/tags/v2.0.0`,
    `${'x'.repeat(40)}\trefs/tags/v3.0.0`, `${'d'.repeat(41)}\trefs/tags/v4.0.0`,
    `${'d'.repeat(63)}\trefs/tags/v5.0.0`, `${A}\trefs/tags/v1.0.0`,
  ];

  assert.deepEqual(parsePluginTags(lines.join('\n')).map((entry) => entry.version), ['2.0.0', '1.0.0']);
  assert.deepEqual(parsePluginTags(null), []);
  assert.deepEqual(parsePluginTags({}), []);
});

test('G1: Receiving objects 50% соответствует 45%', () => {
  assert.equal(parseGitProgress('Receiving objects: 50% (10/20)'), 45);
});

test('G2: Resolving deltas 100% заканчивает шкалу', () => {
  assert.equal(parseGitProgress('Resolving deltas: 100% (20/20)'), 100);
});

test('G3: remote строки не становятся прогрессом скачивания', () => {
  assert.equal(parseGitProgress('remote: Counting objects: 100%'), null);
  assert.equal(parseGitProgress('remote: Receiving objects: 100%'), null);
});

test('G4: побеждает последняя подходящая CR/LF строка, пределы зажаты', () => {
  assert.equal(parseGitProgress('Resolving deltas: 20%\rReceiving objects: 60%\nother'), 54);
  assert.equal(parseGitProgress('Receiving objects: 250%'), 100);
  assert.equal(parseGitProgress('Receiving objects: -20%'), 0);
});

test('G5: перевод Git не распознаётся без production English environment', () => {
  assert.equal(parseGitProgress('Получение объектов: 50%'), null);
});

/**
 * Полная форма команды не даёт fixtures забыть обязательные flags.
 * Каждый сценарий меняет только признак отказа, который он проверяет.
 */
function commandResult(overrides = {}) {
  return {
    code: 1,
    signal: null,
    timedOut: false,
    aborted: false,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    workspaceLimitExceeded: false,
    ...overrides,
  };
}

test('C1: workspace/abort/deadline важнее содержимого stderr', () => {
  const stderr = 'Permission denied: fixture-secret';

  const aborted = commandResult({
    aborted: true,
    timedOut: true,
    stderr,
  });

  assert.equal(classifyGitFailure(aborted).code, 'cancelled');
  assert.equal(classifyGitFailure(commandResult({ timedOut: true, stderr })).code, 'source_timeout');
  assert.equal(classifyGitFailure(commandResult({ workspaceLimitExceeded: true, aborted: true })).code,
    'workspace_limit');
});

test('C2: DNS отказ отличается от отказа доступа', () => {
  const result = commandResult({ stderr: 'Could not resolve host: git.example.invalid' });

  assert.equal(classifyGitFailure(result).code, 'source_unreachable');
});

test('C3: отказ соединения важнее сопутствующего отказа чтения repository', () => {
  const stderr = 'Connection refused\nCould not read from remote repository';

  assert.equal(classifyGitFailure(commandResult({ stderr })).code, 'source_unreachable');
});

test('C4: auth, permission, 404 и отсутствие credentials дают безопасную подсказку', () => {
  for (const stderr of ['Authentication failed fixture-secret', 'Permission denied', 'repository not found',
    'terminal prompts disabled', 'returned error: 401', 'returned error: 403', 'returned error: 404']) {
    const error = classifyGitFailure(commandResult({ stderr }));

    assert.equal(error.code, 'source_unavailable');
    assert.equal(error.message.includes('fixture-secret'), false);
    assert.match(error.message, /gh auth setup-git/u);
  }
});

test('C5: неизвестный отказ не раскрывает сырой stderr', () => {
  const error = classifyGitFailure(commandResult({ stderr: 'fatal: fixture-secret' }));

  assert.equal(error.code, 'source_failed');
  assert.equal(error.message.includes('fixture-secret'), false);
});

test('T6: обрезанный structured stdout не становится полным списком тегов', () => {
  const truncated = commandResult({
    code: 0,
    stdout: `${A}\trefs/tags/v1.0.0`,
    stdoutTruncated: true,
  });

  assert.throws(() => parsePluginTags(completeGitStdout(truncated)), {
    code: 'command_output_limit',
  });
});

test('T7: NUL fields сохраняют русский TAB/LF и byte chunks, пределы явные', async () => {
  const special = 'путь\tс\nразделителями.txt';
  const diff = `A\0${special}\0M\0обычный.txt\0`;
  const bytes = Buffer.from(diff);
  const cut = bytes.indexOf(Buffer.from('п')) + 1;
  const script = `
    process.stdout.write(Buffer.from(${JSON.stringify([...bytes.subarray(0, cut)])}));
    setTimeout(() => process.stdout.write(Buffer.from(${JSON.stringify([...bytes.subarray(cut)])})), 20);
  `;
  const result = await runCommand(process.execPath, ['-e', script], { timeoutMs: 5000, env: {} });
  const parsed = parsePluginChangedFiles(completeGitStdout(result));

  assert.deepEqual(parsed.records, [
    { status: 'A', path: special },
    { status: 'M', path: 'обычный.txt' },
  ]);
  assert.equal(parsed.truncated, false);
  assert.deepEqual(parsePluginCommits(`${A}\0Русская тема\t\0`).records,
    [{ sha: A, subject: 'Русская тема\t' }]);

  const history = Array.from({ length: 51 }, () => `${A}\0Тема\0`).join('');
  const files = Array.from({ length: 201 }, (_, index) => `A\0файл-${index}\0`).join('');

  assert.equal(parsePluginCommits(history).records.length, 50);
  assert.equal(parsePluginCommits(history).truncated, true);
  assert.equal(parsePluginChangedFiles(files).records.length, 200);
  assert.equal(parsePluginChangedFiles(files).truncated, true);
});
