import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import { acquireDirectoryLock } from '../../shared/node/directoryLock.ts';
import { sha256 } from '../../shared/node/hash.ts';
import { completed } from '../cli/helpers/sandbox.mts';
import { ensureTestDeepSeekBinary } from '../helpers/deepseekBinary.mts';
import {
  DAY, oldTree, pinnedCacheFixture, present, retentionFixture, treeSnapshot, waitFile,
} from '../helpers/deepseekRetentionFixture.mts';

const helperUrl = new URL('../helpers/deepseekBinary.mts', import.meta.url).href;

/**
 * Дочерний helper использует тот же публичный вход с приватным окружением теста.
 * stdout проверяется как один JSON, а служебная диагностика остаётся в stderr.
 */
function helperProcess(overrides: NodeJS.ProcessEnv = {}) {
  return spawn(process.execPath, ['--input-type=module', '-e', [
    `import { ensureTestDeepSeekBinary } from ${JSON.stringify(helperUrl)};`,
    'console.log(JSON.stringify(await ensureTestDeepSeekBinary()));',
  ].join('\n')], {
    env: { ...process.env, ...overrides },
    cwd: '/',
  });
}

/**
 * Все пять поколений достаточно старые, но имеют различимый порядок свежести.
 * Умолчание K=3 сохраняет g1..g3, поэтому g4/g5 проверяют защиты сверх лимита.
 */
async function generations(root: string): Promise<string[]> {
  const result: string[] = [];

  for (let index = 1; index <= 5; index++) {
    result.push(await oldTree(root, `node-cache/generations/g${index}`, index,
      Date.now() - (8 + index) * DAY));
  }

  return result;
}

test('HR-RETENTION: старые семейства исчезают, current/young и pinned cache целы', async (t) => {
  const box = await retentionFixture(t);
  const old = [];

  for (const relative of ['test-builds/old', 'gates/candidate-old', 'gates/reports-old',
    'build-input-tests/standalone-old', 'explicit-cache/old']) {
    old.push(await oldTree(box.root, relative));
  }

  const young = await oldTree(box.root, 'test-builds/young', 13, Date.now() - 6 * DAY);
  const pinned = await oldTree(box.root, 'node-cache/runtime-deps-node24', 41);
  const pinnedBefore = await treeSnapshot(pinned);
  const dirs = await generations(box.root);
  const child = helperProcess();
  const result = await completed(child);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).binary, box.binary);

  for (const directory of [...old, ...dirs.slice(3)]) {
    assert.equal(await present(directory), false,
      `Retention не удалил ${path.relative(box.root, directory)}`);
  }

  for (const directory of [young, box.cache, ...dirs.slice(0, 3)]) {
    assert.equal(await present(directory), true);
  }

  assert.deepEqual(await treeSnapshot(pinned), pinnedBefore);
  assert.match(result.stderr, /\d/u, 'Об удалении и байтах должен сообщать stderr');
});

for (const mode of ['default', 'configured'] as const) {
  test(`HR-AGE: порог и K ${mode} согласованы с командой`, async (t) => {
    const box = await retentionFixture(t);
    const twoDays = await oldTree(box.root, 'test-builds/two-days', 17, Date.now() - 2 * DAY);
    const eightDays = await oldTree(box.root, 'test-builds/eight-days');
    const dirs = await generations(box.root);

    if (mode === 'configured') {
      process.env.GRIGDESK_TEST_DEEPSEEK_RETENTION = '1d';
      process.env.GRIGDESK_TEST_DEEPSEEK_KEEP_GENERATIONS = '2';
    }

    await ensureTestDeepSeekBinary();
    assert.equal(await present(eightDays), false, 'Старое удаляется при обоих порогах');
    assert.equal(await present(twoDays), mode === 'default');
    assert.deepEqual(await fs.readdir(path.dirname(dirs[0]!)), mode === 'default'
      ? ['g1', 'g2', 'g3'] : ['g1', 'g2']);
  });
}

for (const [key, value] of [
  ['GRIGDESK_TEST_DEEPSEEK_RETENTION', '0d'],
  ['GRIGDESK_TEST_DEEPSEEK_RETENTION', 'bad'],
  ['GRIGDESK_TEST_DEEPSEEK_KEEP_GENERATIONS', '0'],
  ['GRIGDESK_TEST_DEEPSEEK_KEEP_GENERATIONS', '9007199254740992'],
] as const) {
  test(`HR-AGE: неверная настройка ${key}=${value} отказывает до удаления`, async (t) => {
    const box = await retentionFixture(t);

    await oldTree(box.root, 'test-builds/old');
    process.env[key] = value;

    const before = await treeSnapshot(box.root);

    await assert.rejects(ensureTestDeepSeekBinary());
    assert.deepEqual(await treeSnapshot(box.root), before);
    assert.equal(await present(box.calls), false, 'Некорректная политика не должна запускать binary');
  });
}

test('HR-LOCK: metadata/verify идут под настоящим lock current, token один и после отпущен', async (t) => {
  const box = await retentionFixture(t);

  await oldTree(box.root, 'explicit-cache/current');
  await ensureTestDeepSeekBinary();

  const calls = (await fs.readFile(box.calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

  assert.equal(calls.length, 2);
  assert.ok(calls[0].owner, 'Metadata вызвана без directory lock');
  assert.equal(calls[0].owner.pid, process.pid);
  assert.deepEqual(calls[1].owner, calls[0].owner, 'Verify должен сохранять свой token');
  assert.equal(await present(`${box.cache}.lock`), false);
  assert.equal(await present(box.cache), true);
  assert.ok((await fs.stat(box.cache)).mtimeMs > Date.now() - DAY, 'Current освежается под lock');
});

test('HR-LOCK: чужой candidate сохраняет себя и generations до release', async (t) => {
  const box = await retentionFixture(t);
  const candidate = await oldTree(box.root, 'test-builds/active');
  const free = await oldTree(box.root, 'test-builds/free');
  const dirs = await generations(box.root);
  const lock = await acquireDirectoryLock(`${candidate}.lock`, { waitMs: 0 });

  t.after(() => lock.release());

  const ownerBefore = await fs.readFile(`${candidate}.lock/owner.json`, 'utf8');

  await ensureTestDeepSeekBinary();
  assert.equal(await present(free), false, 'Незанятый старый candidate должен удаляться');
  assert.equal(await present(candidate), true);
  assert.deepEqual(await fs.readFile(`${candidate}.lock/owner.json`, 'utf8'), ownerBefore);

  for (const directory of dirs) {
    assert.equal(await present(directory), true, 'Чужая сборка читает generations после release');
  }

  await lock.release();
  await ensureTestDeepSeekBinary();
  assert.equal(await present(candidate), false);
  assert.equal(await present(dirs[4]!), false);
});

test('HR-GEN-LOCK: g4 сохраняется под per-generation lock, g5 удаляется; release разрешает g4', async (t) => {
  const box = await retentionFixture(t);
  const dirs = await generations(box.root);
  const lock = await acquireDirectoryLock(`${dirs[3]}.lock`, { waitMs: 0 });

  t.after(() => lock.release());
  await ensureTestDeepSeekBinary();
  assert.equal(await present(dirs[4]!), false, 'g5 вне последних K должен удалиться');
  assert.equal(await present(dirs[3]!), true, 'Живой per-generation lock защищает g4');
  await lock.release();
  await ensureTestDeepSeekBinary();
  assert.equal(await present(dirs[3]!), false);
});

test('HR-LOCK: два процесса не удаляют current друг друга', async (t) => {
  const box = await retentionFixture(t);
  const firstCache = await oldTree(box.root, 'explicit-cache/first');
  const secondCache = await oldTree(box.root, 'explicit-cache/second');
  const barrier = path.join(box.home, 'metadata');

  await fs.writeFile(box.control, JSON.stringify({ barrier }));

  const first = helperProcess({ GRIGDESK_TEST_DEEPSEEK_CACHE_DIR: firstCache });
  const firstDone = completed(first);

  t.after(() => first.kill('SIGKILL'));
  await waitFile(`${barrier}.ready`);

  const ownerFile = `${firstCache}.lock/owner.json`;

  assert.equal(await present(ownerFile), true, 'Первый helper должен удерживать настоящий lock');

  const owner = await fs.readFile(ownerFile, 'utf8');

  await fs.writeFile(box.control, '{}');

  const second = await completed(helperProcess({ GRIGDESK_TEST_DEEPSEEK_CACHE_DIR: secondCache }));

  assert.equal(second.code, 0, second.stderr);
  assert.equal(await present(firstCache), true);
  assert.equal(await present(secondCache), true);
  assert.equal(await fs.readFile(ownerFile, 'utf8'), owner);
  await fs.writeFile(`${barrier}.release`, '');
  assert.equal((await firstDone).code, 0);
});

for (const mode of ['default-root', 'root-override', 'default-explicit-cache', 'external-cache'] as const) {
  test(`HR-ROOTS: ${mode}, выбор cache и границы автоматической уборки`, async (t) => {
    const box = await retentionFixture(t);
    let root = box.root;
    let expectedCache = box.cache;

    if (mode === 'default-root') {
      delete process.env.GRIGDESK_TEST_DEEPSEEK_ROOT;
    } else if (mode === 'root-override') {
      root = path.join(box.home, 'chosen-root');
      expectedCache = path.join(root, 'explicit-cache/current');
      process.env.GRIGDESK_TEST_DEEPSEEK_ROOT = root;
      process.env.GRIGDESK_TEST_DEEPSEEK_CACHE_DIR = expectedCache;
    } else if (mode === 'default-explicit-cache') {
      delete process.env.GRIGDESK_TEST_DEEPSEEK_CACHE_DIR;
      expectedCache = path.join(root, 'explicit-cache', sha256(box.binary));
    } else {
      expectedCache = path.join(box.home, 'external-cache');
      process.env.GRIGDESK_TEST_DEEPSEEK_CACHE_DIR = expectedCache;
    }

    await fs.mkdir(expectedCache, { recursive: true });

    const old = await oldTree(root, 'test-builds/old');
    const unknown = await oldTree(root, 'gates/unknown');
    const unknownInput = await oldTree(root, 'build-input-tests/unknown');
    const neighbor = await oldTree(box.artifacts, 'other-topic');
    const external = await oldTree(box.home, 'external-node-cache');

    process.env.GRIGDESK_DEEPSEEK_NODE_CACHE = external;

    await pinnedCacheFixture(root);

    const cacheBefore = await treeSnapshot(path.join(root, 'node-cache'));
    const externalBefore = await treeSnapshot(external);
    const selectedBefore = await treeSnapshot(expectedCache);
    const neighborBefore = await treeSnapshot(neighbor);
    const binaryBefore = await fs.readFile(box.binary);
    const payloadBefore = await fs.readFile(box.payload);
    const unusedBefore = root === box.root ? null : await treeSnapshot(box.root);
    const result = await ensureTestDeepSeekBinary();

    assert.equal(result.cacheDir, expectedCache);
    assert.equal(await present(old), false, 'Выбранный root должен очищаться');
    assert.equal(await present(unknown), true);
    assert.equal(await present(unknownInput), true);
    assert.deepEqual(await treeSnapshot(path.join(root, 'node-cache')), cacheBefore);
    assert.deepEqual(await treeSnapshot(external), externalBefore);
    assert.deepEqual(await treeSnapshot(neighbor), neighborBefore);
    assert.deepEqual(await fs.readFile(box.binary), binaryBefore);
    assert.deepEqual(await fs.readFile(box.payload), payloadBefore);

    if (mode === 'external-cache') {
      assert.deepEqual(await treeSnapshot(expectedCache), selectedBefore);
      assert.equal(await present(`${expectedCache}.lock`), false);
    }

    if (unusedBefore) {
      assert.deepEqual(await treeSnapshot(box.root), unusedBefore);
    }
  });
}

test('HR-ERROR: EACCES виден, Promise отклонён, lock отпущен и повтор успешен', async (t) => {
  const box = await retentionFixture(t);
  const old = await oldTree(box.root, 'test-builds/old');
  const remove = fs.rm.bind(fs);
  const stderr: string[] = [];
  const write = t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
    stderr.push(String(chunk));

    return true;
  });
  const fault = t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
    if (path.basename(String(args[0])).startsWith(`${path.basename(old)}.cleanup-`)) {
      throw Object.assign(new Error('Тестовый EACCES удаления'), { code: 'EACCES' });
    }

    return remove(...args);
  });

  syncBuiltinESMExports();
  t.after(() => {
    fault.mock.restore();
    syncBuiltinESMExports();
  });

  await assert.rejects(ensureTestDeepSeekBinary());
  fault.mock.restore();
  syncBuiltinESMExports();
  write.mock.restore();
  assert.match(stderr.join(''), /EACCES|old|доступ/iu);
  assert.equal(await present(`${box.cache}.lock`), false);
  assert.equal(await present(old), true);
  await ensureTestDeepSeekBinary();
  assert.equal(await present(old), false);
});

test('HR-ERROR: отказ verify отпускает lock, повтор подготовки не зависает', async (t) => {
  const box = await retentionFixture(t);
  const old = await oldTree(box.root, 'test-builds/old');

  await fs.writeFile(box.control, JSON.stringify({ exit: 9 }));
  await assert.rejects(ensureTestDeepSeekBinary());
  assert.equal(await present(`${box.cache}.lock`), false);
  await fs.writeFile(box.control, '{}');
  await ensureTestDeepSeekBinary();
  assert.equal(await present(old), false, 'После ошибки maintenance должен работать при повторе');
});
