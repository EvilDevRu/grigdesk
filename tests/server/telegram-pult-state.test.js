// Срез T телеграм-пульта: pult-state.json — «о чём уже сказано» и message_id карточек.
//
// Обещания (docs/plans/telegram-pult-plan.md, §5.2):
//  - запись атомарная (tmp+rename), чтение после «рестарта» (новый инстанс на том же
//    файле) возвращает то же состояние — рестарт сервера не спамит заново;
//  - карточки ключуются строками (`task:…`, `task:…:stage:…`, `pid:…`) и несут
//    message_id — им редактируется карточка при уходе повода;
//  - битый файл не роняет пульт: warn + чистое состояние (правило «теряется один
//    файл, не вся история»);
//  - состояние не растёт бесконечно: переполнение подрезается по свежести.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TelegramPultStateStore, PULT_STATE_MAX_CARDS } from '../../server/src/lib/telegram/pult/state-store.js';

const T0 = Date.UTC(2026, 7, 19, 10, 0, 0);
const silent = { warn() {}, error() {}, info() {} };

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tg-pult-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'pult-state.json') };
}

test('пустого файла нет — чистое состояние без предупреждений', async (t) => {
  const { file } = await fixture(t);
  const warns = [];
  const store = new TelegramPultStateStore({ file, log: { ...silent, warn: (...a) => warns.push(a) } });
  assert.deepEqual(await store.read(), { cards: {} });
  assert.equal(warns.length, 0);
});

test('запись атомарная, «рестарт» читает то же состояние', async (t) => {
  const { dir, file } = await fixture(t);
  const cards = {
    'task:4187': { messageId: 10, kind: 'gate', at: T0 },
    'task:4188:stage:BUILD': { messageId: 11, kind: 'silence', at: T0 + 1 },
    'pid:a1b2c3d4': { messageId: 12, kind: 'question', at: T0 + 2 },
  };
  const a = new TelegramPultStateStore({ file, log: silent });
  await a.write({ cards });

  // Временных огрызков рядом не остаётся (tmp+rename).
  const names = await readdir(dir);
  assert.deepEqual(names, ['pult-state.json']);

  const b = new TelegramPultStateStore({ file, log: silent });
  assert.deepEqual(await b.read(), { cards });
});

test('битый файл: warn + чистое состояние, запись после этого работает', async (t) => {
  const { file } = await fixture(t);
  await writeFile(file, '{broken json\n');
  const warns = [];
  const store = new TelegramPultStateStore({ file, log: { ...silent, warn: (...a) => warns.push(a) } });
  assert.deepEqual(await store.read(), { cards: {} });
  assert.equal(warns.length >= 1, true, 'битый файл обязан оставить след в логе');

  await store.write({ cards: { 'task:1': { messageId: 1, kind: 'gate', at: T0 } } });
  assert.deepEqual((await store.read()).cards['task:1'], { messageId: 1, kind: 'gate', at: T0 });
});

test('чужая форма файла (не наша схема) тоже читается как чистое состояние', async (t) => {
  const { file } = await fixture(t);
  await writeFile(file, JSON.stringify({ version: 999, cards: 'oops' }));
  const store = new TelegramPultStateStore({ file, log: silent });
  assert.deepEqual(await store.read(), { cards: {} });
});

test('переполнение подрезается по свежести: новые карточки переживают старые', async (t) => {
  const { file } = await fixture(t);
  const store = new TelegramPultStateStore({ file, log: silent });
  const cards = {};
  for (let i = 0; i < PULT_STATE_MAX_CARDS + 20; i += 1) {
    cards[`task:${i}`] = { messageId: i + 1, kind: 'gate', at: T0 + i };
  }
  await store.write({ cards });
  const saved = (await store.read()).cards;
  const keys = Object.keys(saved);
  assert.equal(keys.length, PULT_STATE_MAX_CARDS);
  assert.equal('task:0' in saved, false, 'самая старая карточка ушла');
  assert.equal(`task:${PULT_STATE_MAX_CARDS + 19}` in saved, true, 'самая свежая осталась');
});
