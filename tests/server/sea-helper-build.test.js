import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  buildHelper,
  loadHelpers,
  renderHelperEntry,
} from '../../server/scripts/sea/helpers.mts';

const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { build } = require('esbuild');
const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const FIXTURE = 'tests/server/sea/fixtures/helpers/cli.ts';

/**
 * Временный корень: сборочный вход, вывод helper-а, счётчик запусков.
 * Уборка удаляет только этот каталог.
 */
async function scratch(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-sea-helper-'));

  t.after(() => rm(root, {
    recursive: true,
    force: true
  }));

  return root;
}

/**
 * Пишет манифест helper-ов и возвращает его путь.
 * Вход берётся из репозитория, чтобы прямой запуск исходника тоже проверялся.
 */
async function manifest(root, helpers) {
  const file = path.join(root, 'helpers.json');

  await writeFile(file, JSON.stringify({
    schema: 1,
    helpers,
  }, null, 2));

  return file;
}

/**
 * Запускает файл отдельным Node, подаёт stdin и возвращает код и потоки.
 * Тест видит настоящий stdout/stderr и код выхода, а не подменённые значения.
 */
async function runFile(file, args, { stdin = '', env = {} } = {}) {
  const child = spawn(process.execPath, [file, ...args], {
    env: {
      PATH: '/usr/bin:/bin',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(stdin);

  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });

  return {
    code,
    stdout,
    stderr
  };
}

test('SEA-HELP-01: импорт библиотеки не запускает CLI и сохраняет прежние имена', async (t) => {
  const root = await scratch(t);
  const counter = path.join(root, 'counter.txt');
  const module = await import(pathToFileURL(path.join(ROOT, FIXTURE)).href);
  const previous = process.env.HELPER_COUNTER;

  process.env.HELPER_COUNTER = counter;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.HELPER_COUNTER;
    } else {
      process.env.HELPER_COUNTER = previous;
    }
  });

  assert.equal(typeof module.main, 'function');
  assert.equal(module.legacyMain, module.main);
  await assert.rejects(readFile(counter), { code: 'ENOENT' });

  const code = module.main(['library'], { readStdin: () => '' });

  assert.equal(code, 0);
  assert.equal(await readFile(counter, 'utf8'), 'run\n');
});

test('SEA-HELP-02: собранный helper сохраняет argv, stdin, stdout и код выхода', async (t) => {
  const root = await scratch(t);
  const counter = path.join(root, 'counter.txt');
  const outDir = path.join(root, 'helpers');
  const manifestFile = await manifest(root, [{
    id: 'fixture-helper',
    entry: FIXTURE,
    entryKind: 'main',
    exports: ['main'],
    description: 'фикстура helper-а',
  }]);

  const built = await buildHelper({
    manifestPath: manifestFile,
    id: 'fixture-helper',
    outDir,
    workDir: path.join(root, 'work'),
    root: ROOT,
    esbuild: build,
  });

  assert.equal(built.file, path.join(outDir, 'fixture-helper.mjs'));

  const result = await runFile(built.file, ['a b', ''], {
    stdin: 'вход',
    env: { HELPER_COUNTER: counter },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    argv: ['a b', ''],
    input: 'вход',
  });
  assert.equal(await readFile(counter, 'utf8'), 'run\n');

  const failed = await runFile(built.file, ['--fail'], {
    env: { HELPER_COUNTER: counter },
  });

  assert.equal(failed.code, 3);
  assert.equal(failed.stderr, 'expected failure\n');
  assert.equal(await readFile(counter, 'utf8'), 'run\nrun\n');
});

test('SEA-HELP-03: прямой запуск исходника сохраняется', async (t) => {
  const root = await scratch(t);
  const counter = path.join(root, 'counter.txt');
  const result = await runFile(path.join(ROOT, FIXTURE), ['исходник'], {
    stdin: 'stdin',
    env: { HELPER_COUNTER: counter },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    argv: ['исходник'],
    input: 'stdin',
  });
  assert.equal(await readFile(counter, 'utf8'), 'run\n');
});

test('SEA-HELP-04: guard без main не превращается в пустой успех', async (t) => {
  const root = await scratch(t);
  const entry = 'tests/server/sea/fixtures/helpers/guard-only.ts';
  const manifestFile = await manifest(root, [{
    id: 'guard-only',
    entry,
    entryKind: 'main',
    exports: ['main'],
    description: 'только guard',
  }]);

  await assert.rejects(buildHelper({
    manifestPath: manifestFile,
    id: 'guard-only',
    outDir: path.join(root, 'helpers'),
    workDir: path.join(root, 'work'),
    root: ROOT,
    esbuild: build,
  }), /не экспортирует main/);
});

test('SEA-HELP-05: повторный вызов helper-а выполняет операцию каждый раз', async (t) => {
  const root = await scratch(t);
  const counter = path.join(root, 'counter.txt');
  const module = await import(pathToFileURL(path.join(ROOT, FIXTURE)).href);
  const previous = process.env.HELPER_COUNTER;

  process.env.HELPER_COUNTER = counter;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.HELPER_COUNTER;
    } else {
      process.env.HELPER_COUNTER = previous;
    }
  });

  assert.equal(module.main([], { readStdin: () => '' }), 0);
  assert.equal(module.main([], { readStdin: () => '' }), 0);
  assert.equal(await readFile(counter, 'utf8'), 'run\nrun\n');
});

test('SEA-HELP-06: manifest проверяет id, вид входа и exports', async (t) => {
  const root = await scratch(t);
  const file = await manifest(root, [{
    id: 'fixture-helper',
    entry: FIXTURE,
    entryKind: 'main',
    exports: ['main'],
    description: 'фикстура',
  }]);

  const loaded = await loadHelpers(file, ROOT);

  assert.equal(loaded.helpers[0].id, 'fixture-helper');

  for (const broken of [
    [{ ...loaded.helpers[0], entryKind: 'magic' }],
    [{ ...loaded.helpers[0], exports: [] }],
    [{ ...loaded.helpers[0] }, { ...loaded.helpers[0] }],
    [{ ...loaded.helpers[0], id: 'Плохой id' }],
    [{ ...loaded.helpers[0], entry: '../outside.ts' }],
  ]) {
    const brokenFile = await manifest(root, broken);

    await assert.rejects(loadHelpers(brokenFile, ROOT), /helper|Некоррект/);
  }
});

test('SEA-HELP-07: сгенерированный entry вызывает ровно один экспорт', async () => {
  const source = renderHelperEntry({
    id: 'fixture-helper',
    entry: FIXTURE,
    entryKind: 'main',
    exports: ['main'],
    description: 'фикстура',
  }, '/tmp/helpers/fixture-helper.mjs', ROOT);

  assert.match(source, /markHelperEntry\("fixture-helper"\)/);
  assert.match(source, /const \{ main \} = await import/);
  assert.match(source, /await main\(process\.argv\.slice\(2\)\)/);
  assert.equal(source.match(/await main\(/g)?.length, 1);
});
