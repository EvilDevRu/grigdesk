import assert from 'node:assert/strict';
import { closeSync, openSync, readSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import v8 from 'node:v8';
import vm from 'node:vm';

import { createWebLogStore } from '../../server/src/lib/webLog/store.ts';
import { createWebLog } from '../../web/src/shared/webLog.ts';

function entry() {
  const log = createWebLog({ now: () => new Date('2026-09-23T00:00:00Z'),
    monotonicNow: () => 0, pageId: 'page-aaaaaaaaaaaaaaaa',
    tabId: 'tab-bbbbbbbbbbbbbbbb', version: 'dev',
    context: () => ({ route: '/chats', vis: 'visible', boot: null }) });
  log.record('app.pagehide', { persisted: false });
  return log.snapshot().entries[0];
}

test('сервер добавляет rx, сериализует квоту и учитывает размер после рестарта', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-web-log-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const now = () => new Date('2026-09-23T23:59:59Z');
  const dailyBytes = Buffer.byteLength(`${JSON.stringify({ ...entry(), rx: now().toISOString() })}\n`) + 1;
  const store = createWebLogStore({ dir, now, dailyBytes });
  t.after(() => store.close());

  const replies = await Promise.all(Array.from({ length: 8 }, () => store.append([entry()])));
  assert.equal(replies.reduce((sum, reply) => sum + reply.accepted, 0), 1);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(dir, '2026-09-23.ndjson'))).mode & 0o777, 0o600);
  const lines = (await readFile(path.join(dir, '2026-09-23.ndjson'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).rx, now().toISOString());

  const restarted = createWebLogStore({ dir, now, dailyBytes });
  t.after(() => restarted.close());
  assert.deepEqual(await restarted.append([entry()]), {
    accepted: 0, dropped: 1, reason: 'daily_limit',
  });
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
