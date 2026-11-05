import assert from 'node:assert/strict';
import { closeSync, openSync, readSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import v8 from 'node:v8';
import vm from 'node:vm';

import { createWebLogStore } from '../../server/src/lib/webLog/store.ts';
import { createWebLog } from '../../web/src/shared/webLog.ts';
import { readWebLog } from '../../server/src/lib/webLog/reader.ts';

function entry() {
  const log = createWebLog({ now: () => new Date('2026-09-23T00:00:00Z'),
    monotonicNow: () => 0, pageId: 'page-aaaaaaaaaaaaaaaa',
    tabId: 'tab-bbbbbbbbbbbbbbbb', version: 'dev',
    context: () => ({ route: '/chats', vis: 'visible', boot: null }) });
  log.record('app.pagehide', { persisted: false });
  return log.snapshot().entries[0];
}

test('сервер добавляет rx, ротирует конкурентные записи и продолжает после рестарта', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-web-log-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const now = () => new Date('2026-09-23T23:59:59Z');
  const segmentBytes = Buffer.byteLength(`${JSON.stringify({ ...entry(), rx: now().toISOString() })}\n`) + 1;
  const store = createWebLogStore({
    dir,
    now,
    segmentBytes,
  });
  t.after(() => store.close());

  const replies = await Promise.all(Array.from({ length: 8 }, () => store.append([entry()])));

  assert.equal(replies.reduce((sum, reply) => sum + reply.accepted, 0), 8);
  assert.ok(replies.every((reply) => reply.dropped === 0 && reply.reason === null));
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(dir, '2026-09-23.ndjson'))).mode & 0o777, 0o600);
  const lines = (await readFile(path.join(dir, '2026-09-23.ndjson'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).rx, now().toISOString());

  await store.close();

  const restarted = createWebLogStore({
    dir,
    now,
    segmentBytes,
  });
  t.after(() => restarted.close());
  assert.deepEqual(await restarted.append([entry()]), {
    accepted: 1,
    dropped: 0,
    reason: null,
  });

  let downloaded = '';

  for await (const chunk of await restarted.download('2026-09-23')) {
    downloaded += chunk;
  }

  assert.equal(downloaded.trim().split('\n').length, 9);
  assert.equal((await readdir(dir)).filter((name) => name.endsWith('.gz')).length, 8);

  const rows = [];

  for await (const row of readWebLog({ dir, day: '2026-09-23' })) {
    rows.push(row);
  }

  assert.equal(rows.length, 1);
  assert.equal(rows[0].duplicates, 8);
});

test('сервер чинит только незавершённый хвост и удаляет старые UTC-дни', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-web-log-repair-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const line = `${JSON.stringify({ ...entry(), rx: '2026-09-23T00:00:00Z' })}\n`;
  await writeFile(path.join(dir, '2026-09-23.ndjson'), `${line}{"unfinished":`);
  await writeFile(path.join(dir, '2026-09-09.ndjson'), line);
  await writeFile(path.join(dir, '2026-09-10.ndjson'), line);
  const store = createWebLogStore({ dir, now: () => new Date('2026-09-23T01:00:00Z') });
  t.after(() => store.close());
  await store.cleanup();
  await store.append([entry()]);
  const current = await readFile(path.join(dir, '2026-09-23.ndjson'), 'utf8');
  assert.equal(current.trim().split('\n').length, 2);
  assert.doesNotMatch(current, /unfinished/u);
  await assert.rejects(stat(path.join(dir, '2026-09-09.ndjson')));
  assert.ok(await stat(path.join(dir, '2026-09-10.ndjson')));
});

test('при заполнении бюджета удаляется старое, скачивание уже открытого снимка сохраняется', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-web-log-budget-'));
  const now = () => new Date('2026-09-23T10:00:00Z');
  const store = createWebLogStore({
    dir,
    now,
    segmentBytes: 400,
    maxTotalBytes: 1000,
    maxArchives: 2,
  });

  t.after(() => rm(dir, { recursive: true, force: true }));
  t.after(() => store.close());
  await store.append([{ ...entry(), seq: 1 }]);

  const snapshot = await store.download('2026-09-23');

  await writeFile(path.join(dir, 'keep.txt'), 'чужой файл');

  for (let seq = 2; seq <= 20; seq += 1) {
    const ack = await store.append([{ ...entry(), seq }]);

    assert.equal(ack.accepted, 1);
    assert.equal(ack.dropped, 0);
  }

  let previous = '';

  for await (const chunk of snapshot) {
    previous += chunk;
  }

  assert.equal(JSON.parse(previous).seq, 1);

  const names = (await readdir(dir)).filter((name) => name !== 'keep.txt');
  const sizes = await Promise.all(names.map((name) => stat(path.join(dir, name))));

  assert.ok(sizes.reduce((sum, info) => sum + info.size, 0) <= 1000);
  assert.ok(names.filter((name) => name.endsWith('.gz')).length <= 2);
  assert.equal(await readFile(path.join(dir, 'keep.txt'), 'utf8'), 'чужой файл');

  const rows = [];

  for await (const row of readWebLog({ dir, day: '2026-09-23' })) {
    rows.push(row);
  }

  assert.equal(rows.at(-1).entry.seq, 20);
  assert.ok(rows.length < 20);
});

test('UTC-очистка удаляет архивные части вместе с активным файлом старого дня', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-web-log-archive-age-'));
  let time = new Date('2026-09-01T10:00:00Z');
  const store = createWebLogStore({
    dir,
    now: () => time,
    segmentBytes: 400,
  });

  t.after(() => rm(dir, { recursive: true, force: true }));
  t.after(() => store.close());
  await store.append(Array.from({ length: 5 }, (_, seq) => ({ ...entry(), seq: seq + 1 })));
  assert.ok((await readdir(dir)).some((name) => name.endsWith('.gz')));
  time = new Date('2026-09-15T00:00:00Z');
  await store.cleanup();
  assert.deepEqual(await readdir(dir), []);
});

// Поток скачивания обязан владеть FileHandle. С голым fd поток закрывал номер
// дескриптора, а сборщик мусора позже закрывал его ещё раз — уже чужой файл
// или сокет, либо ронял процесс исключением EBADF.
test('скачивание закрывает FileHandle само: сборка мусора не трогает чужой дескриптор', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-web-log-download-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createWebLogStore({ dir, now: () => new Date('2026-09-23T01:00:00Z') });
  t.after(() => store.close());
  await store.append([entry()]);

  let text = '';
  for await (const chunk of await store.download('2026-09-23')) text += chunk;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(text, /app\.pagehide/u);

  const other = path.join(dir, 'other.txt');
  await writeFile(other, 'чужие данные');
  const fd = openSync(other, 'r');
  const warnings = [];
  const onWarning = (warning) => warnings.push(warning.message);
  process.on('warning', onWarning);
  t.after(() => process.off('warning', onWarning));

  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  for (let i = 0; i < 5; i += 1) {
    gc();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const buffer = Buffer.alloc(64);
  const read = readSync(fd, buffer, 0, buffer.length, 0);
  closeSync(fd);
  assert.equal(buffer.subarray(0, read).toString(), 'чужие данные');
  assert.equal(warnings.some((message) => /file descriptor/iu.test(message)), false);
});
