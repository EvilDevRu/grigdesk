import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { parseArgs } from '../../cli/args.ts';
import { runCli } from '../../cli/commands.ts';
import { acquireDirectoryLock, directoryCleanupLockPath } from '../../shared/node/directoryLock.ts';
import { completed } from './helpers/sandbox.mts';
import { sourceMenu } from './helpers/menuFixture.mts';
import { assertRestored, startPty } from './helpers/pty.mts';
import {
  DAY, NOW, ageTree, oldTree, pinnedCacheFixture, present, retentionFixture, treeSnapshot, waitFile,
} from '../helpers/deepseekRetentionFixture.mts';

interface Entry {
  path: string;
  bytes: number | null;
  status: string;
  reason: string | null;
}

interface Report {
  root: string;
  dryRun: boolean;
  olderThanMs: number;
  keepGenerations: number;
  entries: Entry[];
  wouldDeleteBytes: number;
  freedBytes: number;
  errorCount: number;
}

/**
 * Вызывается существующая публичная команда, отсутствующий модуль не импортируется.
 * На базе ожидаемый RED — код 2 неизвестной команды вместо успешного отчёта.
 */
async function invoke(args: string[] = [], expectedCode = 0) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(['artifacts-cleanup', ...args, '--json'], {
    attached: async () => assert.fail('Локальная уборка не запускает внешние команды'),
    write: (text: string) => {
      stdout += text;
    },
    error: (text: string) => {
      stderr += text;
    },
  });

  assert.equal(code, expectedCode, `artifacts-cleanup: ${stderr}`);
  assert.doesNotMatch(stdout, /\x1b|[╭╮╰╯]/u);

  return { report: JSON.parse(stdout) as Report, stderr };
}

/**
 * Сначала создаётся приватный root для прямого CLI и shell-песочницы.
 * Источник пути совпадает с artifactsPath: явно заданный artifacts override.
 */
async function fixture(t: TestContext) {
  const box = await retentionFixture(t);

  await fs.mkdir(box.artifacts, { recursive: true });

  return box;
}

function entry(report: Report, relative: string): Entry {
  const result = report.entries.find((item) => item.path === relative);

  assert.ok(result, `Нет записи ${relative}: ${JSON.stringify(report)}`);

  return result;
}

test('AC-DRY/AC-JSON: список 12288 байт, dry-run сохраняет дерево и не создаёт lock', async (t) => {
  const box = await fixture(t);

  await oldTree(box.artifacts, 'first', 4096);
  await oldTree(box.artifacts, 'second', 8192);
  await oldTree(box.artifacts, 'young', 73, Date.now() - 6 * DAY);

  const before = await treeSnapshot(box.artifacts);
  const { report } = await invoke(['--dry-run']);

  assert.equal(report.root, box.artifacts);
  assert.equal(report.dryRun, true);
  assert.equal(report.olderThanMs, 7 * DAY);
  assert.equal(report.keepGenerations, 3);
  assert.equal(report.wouldDeleteBytes, 12288);
  assert.equal(report.freedBytes, 0);
  assert.equal(report.errorCount, 0);
  assert.equal(entry(report, 'first').bytes, 4096);
  assert.equal(entry(report, 'second').bytes, 8192);
  assert.equal(entry(report, 'first').status, 'would-delete');
  assert.equal(entry(report, 'young').reason, 'young');
  assert.deepEqual(await treeSnapshot(box.artifacts), before);
});

test('AC-DELETE/AC-AGE: default7d, новый порог и повтор без двойного учёта', async (t) => {
  const box = await fixture(t);
  const old = await oldTree(box.artifacts, 'old', 4096);
  const young = await oldTree(box.artifacts, 'young', 8192, Date.now() - 6 * DAY);
  const first = (await invoke()).report;

  assert.equal(first.freedBytes, 4096);
  assert.equal(entry(first, 'old').status, 'deleted');
  assert.equal(entry(first, 'young').reason, 'young');
  assert.equal(await present(old), false);
  assert.equal(await present(young), true);

  const repeated = (await invoke()).report;

  assert.equal(repeated.freedBytes, 0);

  const changed = (await invoke(['--older-than', '1d'])).report;

  assert.equal(changed.freedBytes, 8192);
  assert.equal(await present(young), false);
  assert.equal(await present(box.artifacts), true);
});

test('AC-AGE: точный cutoff, будущее и свежий вложенный файл защищают родителя', async (t) => {
  const box = await fixture(t);

  t.mock.method(Date, 'now', () => NOW);

  const boundary = await oldTree(box.artifacts, 'boundary', 1, NOW - 7 * DAY);
  const future = await oldTree(box.artifacts, 'future', 1, NOW + DAY);
  const freshChild = await oldTree(box.artifacts, 'fresh-child', 1, NOW - 8 * DAY);
  const eligible = await oldTree(box.artifacts, 'eligible', 1, NOW - 8 * DAY);

  await fs.utimes(path.join(freshChild, 'sentinel'), NOW / 1000, NOW / 1000);

  const { report } = await invoke();

  for (const directory of [boundary, future, freshChild]) {
    assert.equal(await present(directory), true);
    assert.equal(entry(report, path.basename(directory)).reason, 'young');
  }

  assert.equal(await present(eligible), false);
});

test('AC-ARGS: сроки m/h/d, K и флаги разбираются строго с прежним приоритетом help', () => {
  for (const [duration, milliseconds] of [['15m', 900000], ['12h', DAY / 2], ['7d', 7 * DAY]] as const) {
    const args = parseArgs(['artifacts-cleanup', '--older-than', duration,
      '--keep-generations', '2', '--dry-run', '--json']);

    assert.equal(args.kind, 'artifacts-cleanup');
    assert.equal(Reflect.get(args, 'olderThanMs'), milliseconds);
    assert.equal(Reflect.get(args, 'keepGenerations'), 2);
    assert.equal(Reflect.get(args, 'dryRun'), true);
    assert.equal(args.json, true);
  }

  assert.equal(parseArgs(['artifacts-cleanup', '--older-than', 'bad', '--help']).kind, 'help');
});

test('AC-ARGS: неверные/повторные флаги дают 2 до любых файловых эффектов', async (t) => {
  const box = await fixture(t);

  await oldTree(box.artifacts, 'old');
  await invoke(['--dry-run']);

  const before = await treeSnapshot(box.artifacts);
  const invalid = [
    ['--older-than'], ['--older-than', '0d'], ['--older-than', '-1d'],
    ['--older-than', '9007199254740992d'], ['--older-than', '1w'], ['--older-than', '1.5d'],
    ['--keep-generations'], ['--keep-generations', '0'], ['--keep-generations', '-1'],
    ['--keep-generations', '9007199254740992'], ['--keep-generations', '1.5'],
    ['--older-than', '1d', '--older-than', '2d'],
    ['--keep-generations', '2', '--keep-generations', '3'], ['extra'], ['--unknown'],
  ];

  for (const tail of invalid) {
    let error = '';
    const code = await runCli(['artifacts-cleanup', ...tail], {
      attached: async () => assert.fail('Ошибка args не должна запускать команды'),
      write: () => assert.fail('Ошибка args не должна печатать отчёт'),
      error: (text: string) => {
        error += text;
      },
    });

    assert.equal(code, 2, JSON.stringify(tail));
    assert.ok(error.length > 0);
  }

  for (const tail of [['status', '--dry-run'], ['open', '--older-than', '1d'],
    ['server', 'status', '--keep-generations', '2']]) {
    assert.throws(() => parseArgs(tail));
  }

  assert.deepEqual(await treeSnapshot(box.artifacts), before);
});

for (const kind of ['sibling', 'ancestor', 'nested', 'payload-cache', 'ownerless', 'corrupt', 'dead']) {
  test(`AC-LOCKS: ${kind}, read-only preview и безопасное удаление`, async (t) => {
    const box = await fixture(t);
    const old = await oldTree(box.artifacts, 'locked');
    const lockPath = kind === 'ancestor' ? `${box.artifacts}.lock`
      : kind === 'nested' ? path.join(old, 'nested.lock')
        : kind === 'payload-cache' ? path.join(old, '.locks/package-id') : `${old}.lock`;

    await fs.mkdir(path.dirname(lockPath), { recursive: true });

    if (['sibling', 'ancestor', 'nested', 'payload-cache'].includes(kind)) {
      const lock = await acquireDirectoryLock(lockPath, { waitMs: 0 });

      t.after(() => lock.release());
    } else {
      await fs.mkdir(lockPath);

      if (kind !== 'ownerless') {
        await fs.writeFile(path.join(lockPath, 'owner.json'), kind === 'corrupt' ? '{broken'
          : JSON.stringify({
            pid: process.pid,
            starttime: '0',
            token: 'proven-reused-pid',
          }));
      }
    }

    await ageTree(old, Date.now() - 8 * DAY);

    const before = await treeSnapshot(box.artifacts);
    const ownerBefore = await treeSnapshot(lockPath);
    const preview = (await invoke(['--dry-run'])).report;

    assert.deepEqual(await treeSnapshot(box.artifacts), before);
    assert.deepEqual(await treeSnapshot(lockPath), ownerBefore);
    assert.equal(entry(preview, 'locked').status, kind === 'dead' ? 'would-delete' : 'skipped');

    const result = (await invoke()).report;

    assert.equal(await present(old), kind !== 'dead');

    if (kind === 'dead') {
      assert.equal(entry(result, 'locked').status, 'deleted');
    } else {
      assert.equal(entry(result, 'locked').reason,
        ['ownerless', 'corrupt'].includes(kind) ? 'lock-unknown' : 'locked');
    }

    if (kind !== 'dead') {
      assert.deepEqual(await treeSnapshot(lockPath), ownerBefore);
    }
  });
}

test('AC-LOCKS: EPERM проверки процесса означает unknown, не разрешение удаления', async (t) => {
  const box = await fixture(t);
  const old = await oldTree(box.artifacts, 'permission');
  const lock = await acquireDirectoryLock(`${old}.lock`, { waitMs: 0 });

  t.after(() => lock.release());

  const before = await treeSnapshot(`${old}.lock`);
  const fault = t.mock.method(process, 'kill', () => {
    throw Object.assign(new Error('Тестовый запрет проверки PID'), { code: 'EPERM' });
  });
  const { report } = await invoke();

  fault.mock.restore();
  syncBuiltinESMExports();
  assert.equal(entry(report, 'permission').reason, 'lock-unknown');
  assert.equal(await present(old), true);
  assert.deepEqual(await treeSnapshot(`${old}.lock`), before);
});

for (const keep of [3, 2]) {
  test(`AC-CACHE: последние K=${keep}, pinned cache побайтно сохраняется`, async (t) => {
    const box = await fixture(t);
    const cache = await pinnedCacheFixture(box.root);
    const before = await treeSnapshot(cache);
    const dirs = [];

    for (let index = 1; index <= 5; index++) {
      dirs.push(await oldTree(cache, `generations/g${index}`, index, Date.now() - (8 + index) * DAY));
    }

    const { report } = await invoke(keep === 3 ? [] : ['--keep-generations', String(keep)]);

    for (let index = 0; index < dirs.length; index++) {
      assert.equal(await present(dirs[index]!), index < keep);
    }

    const after = await treeSnapshot(cache);
    const withoutGenerations = (values: unknown[]) => values.filter((value) => {
      const relative = (value as { path: string }).path;

      return relative !== '' && !relative.startsWith('generations');
    });

    assert.deepEqual(withoutGenerations(after), withoutGenerations(before));
    assert.equal(report.errorCount, 0);
  });
}

test('AC-CACHE: young/locked сверх K и чужая candidate-сборка защищают поколения', async (t) => {
  const box = await fixture(t);
  const generations = path.join(box.root, 'node-cache/generations');
  const locked = await oldTree(generations, 'locked', 1, Date.now() - 12 * DAY);
  const free = await oldTree(generations, 'free', 1, Date.now() - 11 * DAY);
  const young = await oldTree(generations, 'young', 1, Date.now() - DAY);
  const newest = await oldTree(generations, 'latest', 1, Date.now());
  const lock = await acquireDirectoryLock(`${locked}.lock`, { waitMs: 0 });

  t.after(() => lock.release());
  await invoke(['--keep-generations', '1']);
  assert.equal(await present(free), false);
  assert.equal(await present(locked), true);
  assert.equal(await present(young), true);
  assert.equal(await present(newest), true);

  const candidate = await oldTree(box.root, 'test-builds/current');
  const candidateLock = await acquireDirectoryLock(`${candidate}.lock`, { waitMs: 0 });

  t.after(() => candidateLock.release());
  await lock.release();
  await invoke(['--keep-generations', '1']);
  assert.equal(await present(locked), true);
  await candidateLock.release();
  await invoke(['--keep-generations', '1']);
  assert.equal(await present(locked), false);
});

test('AC-PATHS: выбранный data home, отсутствующий и пустой root без mkdir', async (t) => {
  const box = await fixture(t);

  delete process.env.GRIGDESK_ARTIFACTS_DIR;

  const root = path.join(process.env.GRIGDESK_HOME!, 'artifacts');
  const missing = (await invoke()).report;

  assert.equal(missing.root, root);
  assert.equal(missing.freedBytes, 0);
  assert.equal(await present(root), false);
  await fs.mkdir(root, { recursive: true });
  assert.equal((await invoke()).report.entries.length, 0);

  const old = await oldTree(root, 'old');
  const unrelated = await oldTree(box.artifacts, 'unselected');

  await invoke();
  assert.equal(await present(old), false);
  assert.equal(await present(unrelated), true);
});

test('AC-PATHS: относительный root и / отвергаются до обхода', async (t) => {
  await fixture(t);
  await invoke(['--dry-run']);

  for (const root of ['relative-root', '/']) {
    process.env.GRIGDESK_ARTIFACTS_DIR = root;

    let output = '';
    const code = await runCli(['artifacts-cleanup', '--dry-run'], {
      attached: async () => assert.fail('Некорректный root не запускает команды'),
      write: (text: string) => {
        output += text;
      },
      error: (text: string) => {
        output += text;
      },
    });

    assert.equal(code, 1, output);
    assert.ok(output.trim());
  }
});

test('AC-PATHS: ссылки не ведут наружу, обычный файл root остаётся', async (t) => {
  const box = await fixture(t);
  const external = await oldTree(box.home, 'external');
  const old = await oldTree(box.artifacts, 'old');

  await fs.symlink(external, path.join(box.artifacts, 'linked'));
  await fs.symlink(external, path.join(old, 'outside'));
  await fs.writeFile(path.join(box.artifacts, 'file'), 'keep me');
  await ageTree(old, Date.now() - 8 * DAY);

  const before = await treeSnapshot(external);
  const { report } = await invoke();

  assert.equal(await present(old), false);
  assert.equal(entry(report, 'linked').reason, 'symlink');
  assert.equal(entry(report, 'file').reason, 'not-directory');
  assert.equal(await present(path.join(box.artifacts, 'linked')), true);
  assert.deepEqual(await treeSnapshot(external), before);
});

test('AC-JSON/AC-NO-AUTO: shell pipe и TTY с --json, help/status не удаляют old', async (t) => {
  const box = await sourceMenu(t);
  const artifacts = path.join(box.home, 'артефакты с пробелами');
  const old = await oldTree(artifacts, 'old', 4096);
  const environment = { ...box.environment, GRIGDESK_ARTIFACTS_DIR: artifacts };
  const before = await treeSnapshot(artifacts);
  const piped = await box.run(['artifacts-cleanup', '--dry-run', '--json'], environment);

  assert.equal(piped.code, 0, piped.stderr);
  assert.equal(JSON.parse(piped.stdout).wouldDeleteBytes, 4096);
  assert.deepEqual(box.calls(), [], 'Локальная уборка не обращается к systemd');
  assert.deepEqual(box.requests(), []);

  const session = startPty(t, {
    argv: ['bash', path.join(box.root, 'bin/grigdesk-ctl'), 'artifacts-cleanup', '--dry-run', '--json'],
    env: environment,
  });
  const result = await session.done;

  assert.equal(result.code, 0, session.output());
  assert.equal(JSON.parse(session.output()).wouldDeleteBytes, 4096);
  assert.doesNotMatch(session.output(), /\x1b|[╭╮╰╯]/u);
  assertRestored(result, session.output());
  assert.deepEqual(await treeSnapshot(artifacts), before);

  for (const args of [['--help'], ['status', '--json']]) {
    const result = await box.run(args, environment);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(await present(old), true);
    assert.deepEqual(await treeSnapshot(artifacts), before);
  }
});

test('AC-RACE: второй процесс держит настоящий sibling lock до файлового release', async (t) => {
  const box = await fixture(t);
  const old = await oldTree(box.artifacts, 'old');
  const barrier = path.join(box.home, 'lock-barrier');
  const lockUrl = new URL('../../shared/node/directoryLock.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', [
    `import { acquireDirectoryLock } from ${JSON.stringify(lockUrl)};`,
    "import fs from 'node:fs/promises';",
    `const lock = await acquireDirectoryLock(${JSON.stringify(`${old}.lock`)}, { waitMs: 0 });`,
    `await fs.writeFile(${JSON.stringify(`${barrier}.ready`)}, '');`,
    `while (!await fs.stat(${JSON.stringify(`${barrier}.release`)}).catch(() => null)) {`,
    '  await new Promise((resolve) => setTimeout(resolve, 15));',
    '}',
    'await lock.release();',
  ].join('\n')]);
  const done = completed(child);

  t.after(() => child.kill('SIGKILL'));
  await waitFile(`${barrier}.ready`);

  const owner = await fs.readFile(`${old}.lock/owner.json`, 'utf8');
  const held = (await invoke()).report;

  assert.equal(entry(held, 'old').reason, 'locked');
  assert.equal(await fs.readFile(`${old}.lock/owner.json`, 'utf8'), owner);
  await fs.writeFile(`${barrier}.release`, '');
  assert.equal((await done).code, 0);
  assert.equal((await invoke()).report.freedBytes, 17);
  assert.equal((await invoke()).report.freedBytes, 0);
});

for (const change of ['mtime', 'lock'] as const) {
  test(`AC-RACE: ${change} между планированием и захватом lock отменяет удаление`, async (t) => {
    const box = await fixture(t);
    const old = await oldTree(box.artifacts, 'old');
    const mkdir = fs.mkdir.bind(fs);
    let changed = false;
    let owner = '';
    const fault = t.mock.method(fs, 'mkdir', async (...args: Parameters<typeof fs.mkdir>) => {
      const barrier = change === 'lock' ? directoryCleanupLockPath(box.artifacts) : `${old}.lock`;

      if (!changed && path.basename(String(args[0])) === path.basename(barrier)) {
        changed = true;

        if (change === 'mtime') {
          await fs.utimes(path.join(old, 'sentinel'), new Date(), new Date());
        } else {
          const lock = await acquireDirectoryLock(`${old}.lock`, { waitMs: 0 });

          t.after(() => lock.release());
          owner = await fs.readFile(`${old}.lock/owner.json`, 'utf8');
        }
      }

      return mkdir(...args);
    });

    syncBuiltinESMExports();
    t.after(() => {
      fault.mock.restore();
      syncBuiltinESMExports();
    });

    const { report } = await invoke();

    fault.mock.restore();
    syncBuiltinESMExports();
    assert.equal(changed, true, 'Гонка должна воспроизводиться до удаления каталога');
    assert.equal(await present(old), true);
    assert.equal(entry(report, 'old').reason, change === 'mtime' ? 'young' : 'locked');

    if (owner) {
      assert.equal(await fs.readFile(`${old}.lock/owner.json`, 'utf8'), owner);
    }
  });
}

test('AC-ERROR: EACCES одного кандидата не мешает второму, JSON/сумма/повтор корректны', async (t) => {
  const box = await fixture(t);
  const denied = await oldTree(box.artifacts, 'denied', 4096);
  const allowed = await oldTree(box.artifacts, 'allowed', 8192);
  const remove = fs.rm.bind(fs);
  const fault = t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
    if (path.basename(String(args[0])).startsWith(`${path.basename(denied)}.cleanup-`)) {
      throw Object.assign(new Error('Тестовый EACCES'), { code: 'EACCES' });
    }

    return remove(...args);
  });

  syncBuiltinESMExports();
  t.after(() => {
    fault.mock.restore();
    syncBuiltinESMExports();
  });

  const { report } = await invoke([], 1);

  fault.mock.restore();
  syncBuiltinESMExports();
  assert.equal(report.errorCount, 1);
  assert.equal(report.freedBytes, 8192);
  assert.equal(entry(report, 'denied').status, 'error');
  assert.equal(entry(report, 'denied').reason, 'io-error');
  assert.equal(await present(denied), true);
  assert.equal(await present(allowed), false);
  assert.equal(await present(`${denied}.lock`), false);
  assert.equal((await invoke()).report.freedBytes, 4096);
});
