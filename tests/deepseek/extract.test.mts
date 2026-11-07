import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createReadStream, writeSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { packagePayload } from '../../deepseek/scripts/packagePayload.mts';
import { materializePayload, resolveExtractionCache } from '../../deepseek/src/launcher/extract.ts';
import { packageIdFor } from '../../deepseek/src/runtime/metadata.ts';
import { deepSeekPayloadFixture } from '../helpers/deepseekPayload.mts';
import type { PayloadEntry } from '../../deepseek/src/runtime/payloadIndex.ts';
import { acquireDirectoryLock, processOwnerState } from '../../shared/node/directoryLock.ts';
import { sha256File } from '../../shared/node/hash.ts';

/**
 * Распаковщик получает только индекс и bytes из закрытого архива, без доступа к sources.
 * Кэш и все внешние sentinels находятся в собственном одноразовом каталоге теста.
 */
async function fixture(t: test.TestContext) {
  const { root, options } = await deepSeekPayloadFixture(t);
  const payload = await packagePayload(options);
  const packageId = packageIdFor({ payload });
  const cacheDir = path.join(root, 'cache с пробелами');
  const extract = () => materializePayload({
    cacheDir,
    packageId,
    payload,
    archive: () => createReadStream(options.outputFile),
  });

  return {
    root,
    payload,
    packageId,
    cacheDir,
    extract,
    options,
  };
}

test('холодный кэш публикует целую поставку, повторный запуск переиспользует каталог', async (t) => {
  const { payload, packageId, cacheDir, extract } = await fixture(t);
  const directory = await extract();
  const original = await fs.stat(directory, { bigint: true });

  assert.equal(directory, path.join(cacheDir, 'packages', packageId));
  assert.equal(await fs.readFile(path.join(directory, 'node'), 'utf8'), 'ordinary-node-bytes');
  assert.equal((await fs.stat(path.join(directory, 'generation/dependency.js'))).mode & 0o777, 0o555);
  assert.equal(await fs.readlink(path.join(directory, 'generation/relative-link')), 'dependency.js');
  assert.equal(await extract(), directory);
  assert.equal((await fs.stat(directory, { bigint: true })).ino, original.ino);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, '.ready.json'), 'utf8')).payloadSha256,
    payload.sha256);

  const marker = JSON.parse(await fs.readFile(path.join(directory, '.ready.json'), 'utf8'));
  const fields = ['ino', 'size', 'mode', 'mtimeNs', 'ctimeNs'] as const;
  const rootStat = await fs.lstat(directory, { bigint: true });

  assert.deepEqual(marker.statFields, fields);
  assert.deepEqual(marker.root, fields.map((field) => rootStat[field].toString()));

  for (const name of ['node', 'generation/relative-link']) {
    const index = payload.entries.findIndex((entry) => entry.path === name);
    const stat = await fs.lstat(path.join(directory, name), { bigint: true });

    assert.deepEqual(marker.entries[index], fields.map((field) => stat[field].toString()));
  }
});

const hostilePaths = [
  ['traversal', '../sentinel'],
  ['absolute', '/outside/sentinel'],
  ['NUL', 'bad\0path'],
  ['normalized duplicate', 'generation/./entry.mjs'],
];

for (const [label, name] of hostilePaths) {
  test(`индекс ${label} отвергается до создания cache, sentinel неизменён`, async (t) => {
    const { root, payload, packageId, cacheDir } = await fixture(t);
    const sentinel = path.join(root, 'sentinel');

    await fs.writeFile(sentinel, 'untouched');
    await assert.rejects(() => materializePayload({
      cacheDir,
      packageId,
      payload: { ...payload, entries: [...payload.entries, { ...payload.entries[0]!, path: name! }] },
      archive: () => [],
    }), { code: 'deepseek_payload_invalid' });
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'untouched');
    assert.equal(await fs.access(cacheDir).then(() => true, () => false), false);
  });
}

test('точный duplicate path отвергается до файловых эффектов', async (t) => {
  const { payload, packageId, cacheDir } = await fixture(t);

  await assert.rejects(() => materializePayload({
    cacheDir,
    packageId,
    payload: { ...payload, entries: [...payload.entries, payload.entries[0]!] },
    archive: () => [],
  }), { code: 'deepseek_payload_invalid' });
  assert.equal(await fs.access(cacheDir).then(() => true, () => false), false);
});

const hostileLinks: [string, PayloadEntry[]][] = [
  ['наружу', [{
    path: 'outside',
    type: 'link',
    mode: 0o777,
    target: '../sentinel',
  }]],
  ['через другую ссылку', [
    {
    path: 'outside',
    type: 'link',
    mode: 0o777,
    target: '../sentinel',
  },
    {
    path: 'chain',
    type: 'link',
    mode: 0o777,
    target: 'outside',
  },
  ]],
  ['цикл', [
    {
    path: 'cycle-a',
    type: 'link',
    mode: 0o777,
    target: 'cycle-b',
  },
    {
    path: 'cycle-b',
    type: 'link',
    mode: 0o777,
    target: 'cycle-a',
  },
  ]],
  ['запись сквозь ссылку', [
    {
    path: 'through',
    type: 'link',
    mode: 0o777,
    target: 'generation',
  },
    {
    path: 'through/file',
    type: 'file',
    mode: 0o644,
    size: 0,
    sha256: '0'.repeat(64),
  },
  ]],
];

for (const [label, entries] of hostileLinks) {
  test(`symlink ${label} отвергается, внешний sentinel неизменён`, async (t) => {
    const { root, payload, packageId, cacheDir } = await fixture(t);

    await fs.writeFile(path.join(root, 'sentinel'), 'untouched');
    await assert.rejects(() => materializePayload({
      cacheDir,
      packageId,
      payload: { ...payload, entries: [...payload.entries, ...entries] },
      archive: () => [],
    }), { code: 'deepseek_payload_invalid' });
    assert.equal(await fs.readFile(path.join(root, 'sentinel'), 'utf8'), 'untouched');
    assert.equal(await fs.access(cacheDir).then(() => true, () => false), false);
  });
}

for (const damage of ['byte', 'truncated']) {
  test(`${damage} архив не публикуется, прежнее поколение сохранено`, async (t) => {
    const { cacheDir, payload, options, extract } = await fixture(t);
    const previous = await extract();
    const bytes = await fs.readFile(options.outputFile);
    const corrupted = damage === 'truncated' ? bytes.subarray(0, bytes.length - 10) : Buffer.from(bytes);

    if (damage === 'byte') {
      corrupted[Math.floor(corrupted.length / 2)]! ^= 1;
    }

    await assert.rejects(() => materializePayload({
      cacheDir,
      packageId: packageIdFor({ payload, binaryVersion: 'damaged-next' }),
      payload,
      archive: () => [corrupted],
    }), { code: 'deepseek_payload_invalid' });
    assert.equal(await fs.readFile(path.join(previous, 'node'), 'utf8'), 'ordinary-node-bytes');
    assert.deepEqual(await fs.readdir(path.join(cacheDir, 'packages')), [path.basename(previous)]);
  });
}

test('ENOSPC на второй записи убирает staging и не публикует поколение', async (t) => {
  const { cacheDir, packageId, payload, options } = await fixture(t);
  let writes = 0;

  await assert.rejects(() => materializePayload({
    cacheDir,
    packageId,
    payload,
    archive: () => createReadStream(options.outputFile),
    fileSystem: {
      write(fd, bytes) {
        writes += 1;

        if (writes === 2) {
          throw Object.assign(new Error('synthetic ENOSPC'), { code: 'ENOSPC' });
        }

        return writeSync(fd, bytes);
      },
    },
  }), { code: 'ENOSPC' });
  assert.equal(writes, 2);
  assert.deepEqual(await fs.readdir(path.join(cacheDir, 'packages')), []);
});

test('подмена bytes при сохранённом ready-marker обнаруживается', async (t) => {
  const { extract } = await fixture(t);
  const directory = await extract();

  await fs.chmod(path.join(directory, 'generation/dependency.js'), 0o644);
  await fs.writeFile(path.join(directory, 'generation/dependency.js'), 'tampered');
  await assert.rejects(extract, { code: 'deepseek_payload_invalid' });
  assert.equal(await fs.readFile(path.join(directory, 'generation/dependency.js'), 'utf8'), 'tampered');
});

test('тёплый старт проверяет lstat и состав без чтения содержимого payload файлов', async (t) => {
  const input = await fixture(t);
  let reads = 0;
  const options = {
    cacheDir: input.cacheDir,
    packageId: input.packageId,
    payload: input.payload,
    archive: () => createReadStream(input.options.outputFile),
    fileSystem: {
      hashFile: async (file: string) => {
        reads += 1;

        return sha256File(file);
      },
    },
  };
  const directory = await materializePayload(options);

  assert.ok(reads > 0, 'Холодная распаковка полностью хеширует реальные файлы');
  reads = 0;
  assert.equal(await materializePayload(options), directory);
  assert.equal(reads, 0, 'Неизменный kernel fingerprint исключает повторное чтение bytes');
});

test('изменение только ctime вызывает полный пересчёт; явный verify всегда читает файлы', async (t) => {
  const input = await fixture(t);
  const directory = await input.extract();
  const file = path.join(directory, 'generation/dependency.js');
  const before = await fs.lstat(file, { bigint: true });

  await pause(2);
  await fs.chmod(file, Number(before.mode & 0o777n));

  const after = await fs.lstat(file, { bigint: true });

  assert.equal(after.ino, before.ino);
  assert.equal(after.mode, before.mode);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.notEqual(after.ctimeNs, before.ctimeNs);

  let reads = 0;
  const options = {
    cacheDir: input.cacheDir,
    packageId: input.packageId,
    payload: input.payload,
    archive: () => createReadStream(input.options.outputFile),
    fileSystem: {
      hashFile: async (name: string) => {
        reads += 1;

        return sha256File(name);
      },
    },
  };
  const count = input.payload.entries.filter((entry) => entry.type === 'file').length;

  assert.equal(await materializePayload(options), directory);
  assert.equal(reads, count, 'Расхождение ctime перепроверяет все bytes');
  reads = 0;
  await materializePayload(options);
  assert.equal(reads, 0, 'Успешная полная проверка обновляет kernel fingerprint');
  await materializePayload({ ...options, fullVerify: true });
  assert.equal(reads, count, 'Verify не использует быстрый путь');
});

test('подмена mode при сохранённом ready-marker обнаруживается', async (t) => {
  const { extract } = await fixture(t);
  const directory = await extract();

  await fs.chmod(path.join(directory, 'node'), 0o644);
  await assert.rejects(extract, { code: 'deepseek_payload_invalid' });
});

for (const damage of ['replace', 'link', 'extra', 'missing']) {
  test(`${damage} при сохранённом ready-marker обнаруживается`, async (t) => {
    const { extract } = await fixture(t);
    const directory = await extract();
    const marker = await fs.readFile(path.join(directory, '.ready.json'), 'utf8');
    const file = path.join(directory, 'generation/dependency.js');

    if (damage === 'replace') {
      const temporary = path.join(directory, 'replacement');
      const before = await fs.lstat(file, { bigint: true });

      await fs.writeFile(temporary, 'changed-bytes', { mode: Number(before.mode & 0o777n) });
      await fs.rename(temporary, file);
      assert.notEqual((await fs.lstat(file, { bigint: true })).ino, before.ino);
    } else if (damage === 'link') {
      const link = path.join(directory, 'generation/relative-link');

      await fs.unlink(link);
      await fs.symlink('entry.mjs', link);
    } else if (damage === 'extra') {
      await fs.writeFile(path.join(directory, 'extra'), 'unexpected', { mode: 0o444 });
    } else {
      await fs.unlink(file);
    }

    await assert.rejects(extract, { code: 'deepseek_payload_invalid' });
    assert.equal(await fs.readFile(path.join(directory, '.ready.json'), 'utf8'), marker);
  });
}

/**
 * Каждый child принадлежит текущему тесту, его SIGKILL и ожидание не касаются чужих PID.
 * Очередь IPC сохраняет ранние сообщения и не теряет завершение до установки listener.
 */
function extractionProcess(t: test.TestContext, input: Awaited<ReturnType<typeof fixture>>, hold: boolean) {
  const script = fileURLToPath(new URL('../helpers/deepseekExtractionProcess.mts', import.meta.url));
  const child = spawn(process.execPath, [script], {
    env: { PATH: '', TMPDIR: process.env.TMPDIR },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const messages: { kind: string; directory?: string }[] = [];
  const waiters = new Set<() => void>();
  let stderr = '';
  const closed = new Promise<number | null>((resolve) => child.once('close', resolve));

  child.stderr!.on('data', (bytes) => {
    stderr += String(bytes);
  });
  child.on('message', (message: { kind: string }) => {
    messages.push(message);

    for (const wake of waiters) {
      wake();
    }
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }

    await closed;
  });

  const message = (kind: string) => new Promise<{ kind: string; directory?: string }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      waiters.delete(check);
      reject(new Error(`Нет IPC ${kind}: ${JSON.stringify(messages)} ${stderr}`));
    }, 10000);
    const check = () => {
      const found = messages.find((item) => item.kind === kind || item.kind === 'failed');

      if (found) {
        clearTimeout(timeout);
        waiters.delete(check);
        resolve(found);
      }
    };

    waiters.add(check);
    check();
  });
  const start = async () => {
    await message('ready');
    child.send({
      kind: 'start',
      cacheDir: input.cacheDir,
      packageId: input.packageId,
      payload: input.payload,
      archiveFile: input.options.outputFile,
      hold,
    });
    await message('started');
  };

  return {
    child,
    messages,
    message,
    start,
    closed,
  };
}

test('два процесса получают одну целую поставку, второй ждёт публикации первого', async (t) => {
  const input = await fixture(t);
  const first = extractionProcess(t, input, true);

  await first.start();
  assert.equal((await first.message('staging')).kind, 'staging');

  const second = extractionProcess(t, input, false);

  await second.start();
  await pause(150);
  assert.ok(!second.messages.some((message) => message.kind === 'archive-opened'),
    'Один packageId распаковывается только одним владельцем lock');
  first.child.send({ kind: 'release' });

  const a = await first.message('done');
  const b = await second.message('done');

  assert.equal(a.kind, 'done');
  assert.equal(b.kind, 'done');
  assert.equal(a.directory, b.directory);
  assert.equal(await first.closed, 0);
  assert.equal(await second.closed, 0);
  assert.deepEqual(await fs.readdir(path.join(input.cacheDir, 'packages')), [input.packageId]);
});

test('SIGKILL владельца staging позволяет следующему процессу восстановить поставку', async (t) => {
  const input = await fixture(t);
  const first = extractionProcess(t, input, true);

  await first.start();
  assert.equal((await first.message('staging')).kind, 'staging');
  assert.equal(await fs.access(path.join(input.cacheDir, 'packages', input.packageId))
    .then(() => true, () => false), false);
  first.child.kill('SIGKILL');
  await first.closed;

  const directory = await input.extract();

  assert.equal(await fs.readFile(path.join(directory, 'node'), 'utf8'), 'ordinary-node-bytes');
  assert.deepEqual(await fs.readdir(path.join(input.cacheDir, 'packages')), [input.packageId]);
});

test('живой lock не удаляется по таймауту ожидания', async (t) => {
  const { root } = await fixture(t);
  const directory = path.join(root, 'live.lock');
  const lock = await acquireDirectoryLock(directory);

  t.after(() => lock.release());

  const before = await fs.readFile(path.join(directory, 'owner.json'), 'utf8');

  await assert.rejects(() => acquireDirectoryLock(directory, { waitMs: 75, pollMs: 10 }), {
    code: 'directory_lock_busy',
  });
  assert.equal(await fs.readFile(path.join(directory, 'owner.json'), 'utf8'), before);
});

/**
 * Освобождение владельца может убрать claim между последним lstat и rmdir ожидающего.
 * Управляемый файловый барьер воспроизводит этот порядок без случайного тайминга нагрузки.
 */
test('release между проверкой reclaim и его уборкой не срывает следующего владельца', async (t) => {
  const { root } = await fixture(t);
  const directory = path.join(root, 'release-race.lock');
  const owner = await acquireDirectoryLock(directory);
  const remove = fs.rmdir.bind(fs);
  let released = false;
  const intercept = t.mock.method(fs, 'rmdir', async (...args: Parameters<typeof fs.rmdir>) => {
    const [file] = args;

    if (file === path.join(directory, '.reclaim') && !released) {
      released = true;
      await owner.release();
    }

    return remove(...args);
  });

  try {
    const next = await acquireDirectoryLock(directory, { waitMs: 1000, pollMs: 1 });

    assert.equal(released, true, 'Барьер действительно совпал с release');
    assert.notEqual(next.owner.token, owner.owner.token);
    await owner.release();
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'owner.json'), 'utf8')).token,
      next.owner.token);
    await next.release();
  } finally {
    intercept.mock.restore();
    await owner.release();
  }
});

test('ошибка доступа к процессу не разрешает удалить его lock', async (t) => {
  const { root } = await fixture(t);
  const directory = path.join(root, 'denied.lock');
  const owner = {
    pid: process.pid,
    starttime: 'unknown-start',
    token: 'foreign-token',
  };
  const probe = {
    readStat: async () => {
      throw Object.assign(new Error('synthetic EACCES'), { code: 'EACCES' });
    },
    signal: () => {
      throw Object.assign(new Error('synthetic EPERM'), { code: 'EPERM' });
    },
  };

  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'owner.json'), JSON.stringify(owner));

  assert.equal(await processOwnerState(owner, probe), 'unknown');
  await assert.rejects(() => acquireDirectoryLock(directory, {
    waitMs: 75,
    pollMs: 10,
    probe,
  }), {
    code: 'directory_lock_busy',
  });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'owner.json'), 'utf8')), owner);
});

test('cache root берётся из dataHome или явного пути с пробелами без fallback', () => {
  assert.equal(resolveExtractionCache(undefined, { env: {}, home: '/home/test' }),
    '/home/test/.grigdesk/runtimes/deepseek');
  assert.equal(resolveExtractionCache(undefined, {
    env: { GRIGDESK_HOME: '/fixture/data', DSH_HOME: '/must/not/be/cache' },
    home: '/other/home',
  }), '/fixture/data/runtimes/deepseek');
  assert.equal(resolveExtractionCache('/explicit/cache с пробелами', {
    env: { GRIGDESK_HOME: 'invalid data home' },
    home: '',
  }), '/explicit/cache с пробелами');

  for (const value of ['', 'relative', '/']) {
    assert.throws(() => resolveExtractionCache(value, { env: {}, home: '/home/test' }), {
      code: 'deepseek_cache_invalid',
    });
  }
});

test('release идемпотентен и не снимает заменённую чужую запись', async (t) => {
  const { root } = await fixture(t);
  const directory = path.join(root, 'replacement.lock');
  const lock = await acquireDirectoryLock(directory);
  const replacement = { ...lock.owner, token: 'foreign-replacement-token' };

  await fs.writeFile(path.join(directory, 'owner.json'), JSON.stringify(replacement));
  await lock.release();
  await lock.release();

  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'owner.json'), 'utf8')), replacement);
});

test('переиспользованный PID с другим временем старта не удерживает stale lock', async (t) => {
  const { root } = await fixture(t);
  const directory = path.join(root, 'reused-pid.lock');
  const stale = {
    pid: process.pid,
    starttime: '0',
    token: 'old-process-token',
  };

  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'owner.json'), JSON.stringify(stale));

  const lock = await acquireDirectoryLock(directory, { waitMs: 1000, pollMs: 5 });

  assert.notEqual(lock.owner.token, stale.token);
  await lock.release();
  assert.equal(await fs.access(directory).then(() => true, () => false), false);
});
