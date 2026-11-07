import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HELPER = fileURLToPath(new URL('../../deploy/lib/tracker-cli.sh', import.meta.url));

// Заглушка npm: каждая строка журнала — cwd, NODE_ENV и argv через разделитель \x1f.
// Сценарий отказа выбирается FAKE_NPM_FAIL; build создаёт исполняемый результат в <root>/bin.
const FAKE_NPM = [
  '#!/bin/bash',
  'line="$PWD"$\'\\x1f\'"${NODE_ENV:-}"',
  'for arg in "$@"; do',
  '  line+=$\'\\x1f\'"$arg"',
  'done',
  'printf \'%s\\n\' "$line" >> "$FAKE_NPM_LOG"',
  'prefix=$2',
  'if [[ " $* " == *" ci "* && "${FAKE_NPM_FAIL:-}" == ci ]]; then',
  '  exit 3',
  'fi',
  'if [[ " $* " == *" ci "* && "${FAKE_NPM_FAIL:-}" == ci-twice ]]; then',
  '  count=$(( $(cat "$FAKE_NPM_LOG.count" 2>/dev/null || echo 0) + 1 ))',
  '  echo "$count" > "$FAKE_NPM_LOG.count"',
  '  (( count > 2 )) || exit 3',
  'fi',
  'if [[ " $* " == *" run build"* ]]; then',
  '  if [[ "${FAKE_NPM_FAIL:-}" == build ]]; then',
  '    exit 4',
  '  fi',
  '  if [[ "${FAKE_NPM_FAIL:-}" == build-before-ci ]]; then',
  '    grep -q $\'\\x1fci\\x1f\' "$FAKE_NPM_LOG" || exit 4',
  '  fi',
  '  if [[ "${FAKE_NPM_FAIL:-}" != noresult ]]; then',
  '    mkdir -p "$prefix/../bin"',
  '    printf \'#!/bin/sh\\necho new\\n\' > "$prefix/../bin/tracker"',
  '    chmod 755 "$prefix/../bin/tracker"',
  '  fi',
  'fi',
  'exit 0',
  '',
].join('\n');

interface Installation {
  root: string;
  linkDir: string;
  log: string;
  status: number | null;
  stderr: string;
  calls(): string[][];
}

/**
 * Отдельный корень кода, каталог ссылок и заглушка npm в PATH.
 * Настоящие npm, systemctl и сеть недостижимы: PATH состоит из заглушек и /usr/bin:/bin.
 */
function prepare(name: string): Omit<Installation, 'status' | 'stderr'> {
  const base = mkdtempSync(path.join(os.tmpdir(), 'tracker-install-'));
  const root = path.join(base, name, 'code');
  const linkDir = path.join(base, name, 'local bin');
  const stubs = path.join(base, 'stubs');
  const log = path.join(base, 'npm.log');

  mkdirSync(path.join(root, 'tracker'), { recursive: true });
  mkdirSync(stubs);
  writeFileSync(path.join(stubs, 'npm'), FAKE_NPM, { mode: 0o755 });

  return {
    root,
    linkDir,
    log,
    calls: () => existsSync(log)
      ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => line.split('\x1f'))
      : [],
  };
}

/**
 * Проверяет вызов функции, прямой запуск helper или его подключение через source.
 * Возвращает код и stderr; stdout установщика тесту не нужен.
 */
function install(
  box: Omit<Installation, 'status' | 'stderr'>,
  fail = '',
  mode: 'call' | 'direct' | 'source' = 'call',
): Installation {
  const stubs = path.join(path.dirname(box.log), 'stubs');
  const script = mode === 'source'
    ? 'set -euo pipefail; source "$1"'
    : 'set -euo pipefail; source "$1"; grigdesk_install_tracker_cli "$2" "$3"';
  const args = mode === 'direct'
    ? [HELPER, box.root, box.linkDir]
    : ['-c', script, 'tracker-install-test', HELPER, box.root, box.linkDir];
  const result = spawnSync('/bin/bash', args, {
    cwd: path.dirname(box.log),
    encoding: 'utf8',
    env: {
      PATH: `${stubs}:/usr/bin:/bin`,
      HOME: path.dirname(box.log),
      FAKE_NPM_LOG: box.log,
      FAKE_NPM_FAIL: fail,
      NODE_ENV: 'production',
      GRIGDESK_B24_INSTALL_PAUSE: '0',
    },
    timeout: 10000,
  });

  return {
    ...box,
    status: result.status,
    stderr: result.stderr,
  };
}

test('BL-01: установщик собирает до обновления ссылки', () => {
  const box = install(prepare('обычный'));
  const prefix = path.join(box.root, 'tracker');

  assert.equal(box.status, 0, box.stderr);
  assert.deepEqual(box.calls().map((call) => call.slice(2)), [
    ['--prefix', prefix, 'ci', '--include=dev', '--no-audit', '--no-fund'],
    ['--prefix', prefix, 'run', 'build'],
  ]);
  assert.equal(box.calls()[0]?.[1], 'development');
  assert.equal(readlinkSync(path.join(box.linkDir, 'tracker')), path.join(box.root, 'bin/tracker'));
});

test('BL-02: сбой ci/build и отсутствие результата сохраняют прежнюю ссылку', () => {
  for (const fail of ['ci', 'build', 'noresult']) {
    const box = prepare(`отказ ${fail}`);
    const previous = path.join(path.dirname(box.log), 'previous-tracker');

    mkdirSync(box.linkDir, { recursive: true });
    symlinkSync(previous, path.join(box.linkDir, 'tracker'));

    const result = install(box, fail);

    assert.notEqual(result.status, 0, fail);
    assert.match(result.stderr, /[А-Яа-я]/, fail);
    assert.equal(readlinkSync(path.join(box.linkDir, 'tracker')), previous, fail);
    // Сеть машины нестабильна: ci повторяется пять раз, прежде чем шаг сдаётся.
    assert.deepEqual(result.calls().length, fail === 'ci' ? 5 : 2, fail);
  }
});

test('BL-02: повторный сбой сборки с установленными пакетами сохраняет прежнюю ссылку', () => {
  const box = prepare('повторный отказ сборки');
  const previous = path.join(path.dirname(box.log), 'previous-tracker');

  for (const name of ['esbuild', 'postject']) {
    mkdirSync(path.join(box.root, 'tracker/node_modules', name), { recursive: true });
  }

  mkdirSync(box.linkDir, { recursive: true });
  symlinkSync(previous, path.join(box.linkDir, 'tracker'));

  const result = install(box, 'build');

  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(result.calls().map((call) => call.slice(4)), [
    ['run', 'build'],
    ['ci', '--include=dev', '--no-audit', '--no-fund'],
    ['run', 'build'],
  ]);
  assert.equal(readlinkSync(path.join(box.linkDir, 'tracker')), previous);
});

test('BL-03: готовый старый файл не отменяет сборку', () => {
  const box = prepare('старый файл');

  mkdirSync(path.join(box.root, 'bin'), { recursive: true });
  writeFileSync(path.join(box.root, 'bin/tracker'), '#!/bin/sh\necho old\n', { mode: 0o755 });

  const result = install(box);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls().length, 2);
  assert.equal(readFileSync(path.join(box.root, 'bin/tracker'), 'utf8'), '#!/bin/sh\necho new\n');
});

test('BL-04: пробелы в code-root/linkDir не дробят аргументы', () => {
  const box = install(prepare('папка с пробелами и кириллицей'));

  assert.equal(box.status, 0, box.stderr);

  for (const call of box.calls()) {
    assert.equal(call[3], path.join(box.root, 'tracker'));
  }

  assert.equal(readlinkSync(path.join(box.linkDir, 'tracker')), path.join(box.root, 'bin/tracker'));
});

test('BL-06: установленные инструменты сборки не скачиваются заново', () => {
  const box = prepare('инструменты есть');

  for (const name of ['esbuild', 'postject']) {
    mkdirSync(path.join(box.root, 'tracker/node_modules', name), { recursive: true });
  }

  const result = install(box);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls().map((call) => call.slice(4)), [['run', 'build']]);
});

test('BL-06a: неполные пакеты восстанавливаются после отказа сборки', () => {
  const box = prepare('неполные пакеты');
  const previous = path.join(path.dirname(box.log), 'previous-tracker');

  for (const name of ['esbuild', 'postject']) {
    mkdirSync(path.join(box.root, 'tracker/node_modules', name), { recursive: true });
  }

  mkdirSync(box.linkDir, { recursive: true });
  symlinkSync(previous, path.join(box.linkDir, 'tracker'));

  const result = install(box, 'build-before-ci');

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls().map((call) => call.slice(4)), [
    ['run', 'build'],
    ['ci', '--include=dev', '--no-audit', '--no-fund'],
    ['run', 'build'],
  ]);
  assert.equal(result.calls()[1]?.[1], 'development');
  assert.match(result.stderr, /tracker.*зависимост/);
  assert.equal(readlinkSync(path.join(box.linkDir, 'tracker')), path.join(box.root, 'bin/tracker'));
});

test('BL-07: обрыв сети при npm ci повторяется, а не валит установку', () => {
  const result = install(prepare('нестабильная сеть'), 'ci-twice');

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls().map((call) => call[4]), ['ci', 'ci', 'ci', 'run']);
});

test('BL-08: обычный файл tracker в PATH не перезаписывается', () => {
  const box = prepare('чужой файл');
  const foreign = path.join(box.linkDir, 'tracker');

  mkdirSync(box.linkDir, { recursive: true });
  writeFileSync(foreign, '#!/bin/sh\necho foreign\n', { mode: 0o755 });

  const result = install(box);

  // Свой код 2: сборка прошла, не обновлена только ссылка — установщик не скажет «не собран».
  assert.equal(result.status, 2);
  assert.match(result.stderr, /не перезаписан/);
  assert.equal(readFileSync(foreign, 'utf8'), '#!/bin/sh\necho foreign\n');
});

test('BL-11: прямой запуск helper собирает файл и создаёт ссылку', () => {
  const result = install(prepare('прямой запуск с пробелами'), '', 'direct');

  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(path.join(result.linkDir, 'tracker')), 'ссылка tracker не создана');
  assert.equal(readlinkSync(path.join(result.linkDir, 'tracker')), path.join(result.root, 'bin/tracker'));
  assert.deepEqual(result.calls().map((call) => call.slice(4)), [
    ['ci', '--include=dev', '--no-audit', '--no-fund'],
    ['run', 'build'],
  ]);
});

test('BL-11: source без вызова функции не запускает npm', () => {
  const result = install(prepare('только подключение'), '', 'source');

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls(), []);
  assert.equal(existsSync(result.linkDir), false);
});
