import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

import { RotatingLog } from '../../shared/node/rotatingLog.ts';
import { logParts } from '../../shared/node/logArchives.ts';
import { main as runLoggedServer } from '../../server/scripts/runLoggedServer.mts';
import { spawnServer } from '../../desktop/src/serverProcess.ts';
import { buildHelper } from '../../server/scripts/sea/helpers.mts';

/**
 * Каждый тест получает отдельный каталог и явные небольшие лимиты.
 * Ни один путь не ведёт к состоянию работающего приложения.
 */
async function fixture(t: TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-log-rotation-'));

  t.after(() => rm(dir, { recursive: true, force: true }));

  return { dir, file: path.join(dir, 'server.log') };
}

/**
 * Собирает сохранённые байты в порядке записи, прозрачно раскрывая gzip.
 * Проверяется содержимое всего потока, включая границы chunk и архивов.
 */
async function contents(dir: string, file: string): Promise<Buffer> {
  const names = await readdir(dir);
  const parts = logParts(names, path.basename(file));
  const buffers: Buffer[] = [];

  for (const part of parts) {
    const data = await readFile(path.join(dir, part.name));

    buffers.push(part.compressed ? gunzipSync(data) : data);
  }

  if (names.includes(path.basename(file))) {
    buffers.push(await readFile(file));
  }

  return Buffer.concat(buffers);
}

test('ротация во время работы сохраняет каждый байт и продолжает после нового запуска', async (t) => {
  const { dir, file } = await fixture(t);
  const data = Buffer.from('Строка диагностики\n'.repeat(300));
  const options = {
    maxBytes: 1024,
    maxArchives: 20,
    maxTotalBytes: 32 * 1024,
  };
  const first = new RotatingLog(file, options);
  const done = finished(first);

  first.write(data.subarray(0, 1501));
  first.end(data.subarray(1501));
  await done;
  assert.deepEqual(await contents(dir, file), data);

  const second = new RotatingLog(file, options);
  const restarted = finished(second);

  second.end('После рестарта\n');
  await restarted;
  assert.deepEqual(await contents(dir, file), Buffer.concat([data, Buffer.from('После рестарта\n')]));
  assert.ok((await stat(file)).size <= 1024);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('хранение ограничено числом и суммой архивов, чужие файлы не удаляются', async (t) => {
  const { dir, file } = await fixture(t);
  const unrelated = path.join(dir, 'server.log.keep');

  await writeFile(unrelated, 'чужой файл');

  const writer = new RotatingLog(file, {
    maxBytes: 1024,
    maxArchives: 2,
    maxTotalBytes: 2500,
  });
  const done = finished(writer);
  const data = randomBytes(12 * 1024 + 17);

  writer.end(data);
  await done;

  const parts = logParts(await readdir(dir), 'server.log');
  const sizes = await Promise.all(parts.map((part) => stat(path.join(dir, part.name))));

  assert.ok(parts.length <= 2);
  assert.ok(sizes.reduce((sum, info) => sum + info.size, (await stat(file)).size) <= 2500);

  const retained = await contents(dir, file);

  assert.ok(retained.equals(data.subarray(data.length - retained.length)));
  assert.equal(await readFile(unrelated, 'utf8'), 'чужой файл');
});

test('старый большой активный файл архивируется при старте без новой записи', async (t) => {
  const { dir, file } = await fixture(t);
  const previous = Buffer.from('старые записи\n'.repeat(1000));

  await writeFile(file, previous);

  const writer = new RotatingLog(file, { maxBytes: 1024 });
  const done = finished(writer);

  writer.end();
  await done;
  assert.equal((await stat(file)).size, 0);
  assert.deepEqual(await contents(dir, file), previous);
});

test('симлинк вместо активного файла не меняет чужие данные', async (t) => {
  const { dir, file } = await fixture(t);
  const other = path.join(dir, 'private');

  await writeFile(other, 'не трогать');
  await symlink(other, file);

  const writer = new RotatingLog(file);
  const done = finished(writer);

  writer.end('запись');
  await assert.rejects(done);
  assert.equal(await readFile(other, 'utf8'), 'не трогать');
});

test('ручной запуск сохраняет stdout, stderr, хвост и исходный код выхода', async (t) => {
  const { file } = await fixture(t);
  const code = await runLoggedServer([file, process.execPath, '-e',
    'process.stdout.write("out\\n"); process.stderr.write("err\\n"); process.exitCode = 7;']);
  const text = await readFile(file, 'utf8');

  assert.equal(code, 7);
  assert.match(text, /out\n/u);
  assert.match(text, /err\n/u);
});

test('после аварии восстанавливается raw, импортируется .1, старые архивы удаляются', async (t) => {
  const { dir, file } = await fixture(t);
  const raw = `${file}.0000000000000001.raw`;

  await writeFile(raw, 'до аварии\n');
  await writeFile(raw.slice(0, -4) + '.gz.tmp', 'недописанный gzip');
  await writeFile(file + '.1', 'прежняя копия\n');

  const writer = new RotatingLog(file);
  const done = finished(writer);

  writer.end('новая строка\n');
  await done;
  assert.equal((await contents(dir, file)).toString(), 'до аварии\nпрежняя копия\nновая строка\n');
  assert.ok(!(await readdir(dir)).some((name) => /\.(raw|tmp|1)$/u.test(name)));

  const archived = logParts(await readdir(dir), 'server.log')[0]!;
  const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);

  await utimes(path.join(dir, archived.name), old, old);

  const restarted = new RotatingLog(file);
  const restartedDone = finished(restarted);

  restarted.end('после уборки\n');
  await restartedDone;
  assert.doesNotMatch((await contents(dir, file)).toString(), /до аварии/u);
  assert.equal((await stat(path.join(dir, logParts(await readdir(dir), 'server.log')[0]!.name)))
    .mode & 0o777, 0o600);
});

test('desktop сохраняет IPC, обе трубы и вывод при ротации работающего ребёнка', async (t) => {
  const { dir, file } = await fixture(t);

  await mkdir(path.join(dir, 'server'));

  const child = spawnServer({
    root: dir,
    serverCommand: process.execPath,
    serverArgs: ['-e', 'process.stdout.write("out\\n".repeat(1000));'
      + 'process.stderr.write("err\\n"); process.send("written");'],
    env: {},
  } as Parameters<typeof spawnServer>[0], 'pipe');
  const writer = new RotatingLog(file, { maxBytes: 1024 });
  const done = finished(writer);
  const closed = once(child, 'close');

  t.after(() => child.kill());
  child.stdout!.pipe(writer, { end: false });
  child.stderr!.pipe(writer, { end: false });

  const [message] = await once(child, 'message');

  assert.equal(message, 'written');
  await closed;
  writer.end();
  await done;

  const text = (await contents(dir, file)).toString();

  assert.equal(text.match(/out\n/gu)?.length, 1000);
  assert.equal(text.match(/err\n/gu)?.length, 1);
  assert.ok(logParts(await readdir(dir), 'server.log').length > 1);
});

test('собранный helper выполняется один раз и сохраняет код завершения', async (t) => {
  const { dir, file } = await fixture(t);
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const built = await buildHelper({
    manifestPath: path.join(root, 'server/build/helpers.json'),
    id: 'run-logged-server',
    root,
    workDir: path.join(dir, 'work'),
    outDir: path.join(dir, 'helpers'),
  });
  const result = spawnSync(process.execPath, [built.file, file, process.execPath, '-e',
    'process.stdout.write("один запуск\\n"); process.exitCode = 9;'], { encoding: 'utf8' });

  assert.equal(result.status, 9, result.stderr);
  assert.equal(await readFile(file, 'utf8'), 'один запуск\n');
});

test('SIGTERM ручного launcher передаётся ребёнку, последняя строка дописывается', async (t) => {
  const { dir, file } = await fixture(t);
  const ready = path.join(dir, 'ready');
  const script = 'const fs = require("node:fs");'
    + 'const timer = setInterval(() => {}, 1000);'
    + 'process.on("SIGTERM", () => { process.stdout.write("хвост\\n"); clearInterval(timer); });'
    + 'fs.writeFileSync(process.argv[1], "ready");';
  const child = spawn(process.execPath, [
    fileURLToPath(new URL('../../server/scripts/runLoggedServer.mts', import.meta.url)),
    file, process.execPath, '-e', script, ready,
  ], { stdio: 'ignore' });
  const closed = once(child, 'close');
  const deadline = Date.now() + 5000;

  t.after(() => child.kill());

  while (!(await stat(ready).catch(() => null))) {
    assert.ok(Date.now() < deadline, 'ребёнок не сообщил о готовности');
    await pause(10);
  }

  child.kill('SIGTERM');

  const [code] = await closed;

  assert.equal(code, 0);
  assert.equal(await readFile(file, 'utf8'), 'хвост\n');
});
