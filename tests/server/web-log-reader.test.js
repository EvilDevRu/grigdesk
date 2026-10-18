import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { createWebLog } from '../../web/src/shared/webLog.ts';
import { readWebLog } from '../../server/src/lib/webLog/reader.ts';

function marked(page = 'page-aaaaaaaaaaaaaaaa') {
  const log = createWebLog({ now: () => new Date('2026-09-22T23:59:00Z'),
    monotonicNow: () => 0, pageId: page,
    tabId: 'tab-bbbbbbbbbbbbbbbb', version: 'dev',
    context: () => ({ route: '/chats', vis: 'visible', boot: null }) });
  log.record('page.visibility', { state: 'visible' });
  log.mark('Сбой', null);
  return log.snapshot().entries.at(-1);
}

test('reader объединяет дубли и раскрывает debug-дамп через UTC-полночь', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-web-log-reader-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const entry = marked();
  const line = JSON.stringify({ ...entry, rx: '2026-09-23T00:00:01Z' });
  await writeFile(path.join(dir, '2026-09-23.ndjson'), `${line}\n${line}\n{"bad":`);
  const warnings = [];
  const rows = [];
  for await (const row of readWebLog({ dir, now: () => new Date('2026-09-23T01:00:00Z'),
    since: new Date('2026-09-22T23:00:00Z'), level: 'warn', dump: true,
    warn: (message) => warnings.push(message) })) rows.push(row);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].contextOf.seq, entry.seq);
  assert.equal(rows[0].entry.ev, 'page.visibility');
  assert.equal(rows[1].duplicates, 1);
  assert.ok(warnings.some((message) => message.includes('строка 3')));

  const result = spawnSync(process.execPath, ['server/scripts/web-log.mjs', '--day', '2026-09-23',
    '--level', 'warn', '--json'], { cwd: new URL('../..', import.meta.url),
    env: { ...process.env, GRIGDESK_WEB_LOG_DIR: dir }, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  assert.doesNotMatch(result.stderr, /\{"bad"/u);
});

test('reader ограничивает индекс, сообщает об этом и не скрывает новые строки', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-web-log-index-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = marked();
  const second = marked('page-cccccccccccccccc');
  const one = JSON.stringify({ ...first, rx: '2026-09-22T23:59:59Z' });
  const two = JSON.stringify({ ...second, rx: '2026-09-23T00:00:01Z' });
  await writeFile(path.join(dir, '2026-09-22.ndjson'), `${one}\n`);
  await writeFile(path.join(dir, '2026-09-23.ndjson'), `${two}\n${two}\n`);
  const warnings = [];
  const rows = [];
  for await (const row of readWebLog({ dir, since: new Date('2026-09-22T23:59:00Z'),
    ev: 'ma*', level: 'warn', maxIndex: 1,
    warn: (message) => warnings.push(message) })) rows.push(row);

  assert.equal(rows.length, 3);
  assert.equal(rows[0].entry.page, first.page);
  assert.equal(rows[1].entry.page, second.page);
  assert.ok(warnings.some((message) => message.includes('Индекс дедупликации исчерпан')));

  const filtered = [];
  for await (const row of readWebLog({ dir, since: new Date('2026-09-23T00:00:00Z'),
    page: second.page, ev: 'mark', level: 'warn' })) filtered.push(row);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].duplicates, 1);
});

test('CLI в тексте показывает время окна, маршрут и предысторию под записью', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-web-log-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const entry = marked();
  await writeFile(path.join(dir, '2026-09-23.ndjson'),
    `${JSON.stringify({ ...entry, rx: '2026-09-23T00:00:01Z' })}\n`);
  const cli = (args) => spawnSync(process.execPath, ['server/scripts/web-log.mjs', ...args], {
    cwd: new URL('../..', import.meta.url), env: { ...process.env, GRIGDESK_WEB_LOG_DIR: dir },
    encoding: 'utf8',
  });

  const text = cli(['--day', '2026-09-23', '--level', 'warn', '--dump']);
  assert.equal(text.status, 0, text.stderr);
  const lines = text.stdout.trimEnd().split('\n');
  assert.match(lines[0], /^2026-09-22T23:59:00\.000Z warn {2}mark \/chats page-a+:2 /u);
  assert.equal(lines[1], '  предыстория (1):');
  assert.match(lines[2], /^ {4}2026-09-22T23:59:00\.000Z debug page\.visibility \/chats page-a+:1 /u);

  const bad = cli(['--since', '5x']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Для --since нужен интервал вроде 30m, 2h или 1d/u);
  assert.match(bad.stderr, /Использование:/u);
  assert.match(cli(['--nope']).stderr, /Неизвестный аргумент: --nope/u);
});
