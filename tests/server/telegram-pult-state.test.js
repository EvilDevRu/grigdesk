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
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  assert.deepEqual(await store.read(), { cards: {}, screen: null, sent: [], turns: [] });
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
  assert.deepEqual(await b.read(), { cards, screen: null, sent: [], turns: [] });
});

test('битый файл: warn + чистое состояние, запись после этого работает', async (t) => {
  const { file } = await fixture(t);
  await writeFile(file, '{broken json\n');
  const warns = [];
  const store = new TelegramPultStateStore({ file, log: { ...silent, warn: (...a) => warns.push(a) } });
  assert.deepEqual(await store.read(), { cards: {}, screen: null, sent: [], turns: [] });
  assert.equal(warns.length >= 1, true, 'битый файл обязан оставить след в логе');

  await store.write({ cards: { 'task:1': { messageId: 1, kind: 'gate', at: T0 } } });
  assert.deepEqual((await store.read()).cards['task:1'], { messageId: 1, kind: 'gate', at: T0 });
});

test('чужая форма файла (не наша схема) тоже читается как чистое состояние', async (t) => {
  const { file } = await fixture(t);
  await writeFile(file, JSON.stringify({ version: 999, cards: 'oops' }));
  const store = new TelegramPultStateStore({ file, log: silent });
  assert.deepEqual(await store.read(), { cards: {}, screen: null, sent: [], turns: [] });
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

// ------------------------------------------- схема v2: экран навигации и реестр sent
//
// t91001: один экран навигации (screen) и реестр эфемерных ответов (sent) для
// /clean. Запись — merge от свежего содержимого файла внутри очереди, не replace:
// вотчер пишет cards, действия — screen/sent, и чужие поля не затираются.

test('файл на диске помечен version: 3', async (t) => {
  const { file } = await fixture(t);
  const store = new TelegramPultStateStore({ file, log: silent });
  await store.write({ cards: {} });
  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(raw.version, 3);
});

test('миграция v1: старый файл читается с пустыми экраном и реестром, карточки целы', async (t) => {
  const { file } = await fixture(t);
  await writeFile(file, JSON.stringify({
    version: 1,
    cards: { 'task:1': { messageId: 1, kind: 'gate', at: T0 } },
  }));
  const store = new TelegramPultStateStore({ file, log: silent });
  assert.deepEqual(await store.read(), {
    cards: { 'task:1': { messageId: 1, kind: 'gate', at: T0 } },
    screen: null,
    sent: [],
    turns: [],
  });
});

test('миграция v2 сохраняет карточки и добавляет пустой реестр ходов', async (t) => {
  const { file } = await fixture(t);
  await writeFile(file, JSON.stringify({
    version: 2,
    cards: { 'wait:1': { messageId: 7, kind: 'gate', at: T0 } },
    screen: null,
    sent: [],
  }));
  const store = new TelegramPultStateStore({ file, log: silent });
  assert.deepEqual(await store.read(), {
    cards: { 'wait:1': { messageId: 7, kind: 'gate', at: T0 } },
    screen: null,
    sent: [],
    turns: [],
  });
});

test('принятый ход переживает рестарт без текста вопроса и токена бота', async (t) => {
  const { file } = await fixture(t);
  const turn = {
    id: 't1a2b3',
    ownerKey: 'acc:T0:555001',
    chatId: 555001,
    chatKey: 'server-owned-chat',
    acceptedAt: T0,
    startedAt: null,
    phase: 'accepted',
    stopMessageId: null,
  };
  const first = new TelegramPultStateStore({ file, log: silent });
  await first.write({ turns: [turn] });
  const second = new TelegramPultStateStore({ file, log: silent });
  assert.deepEqual((await second.read()).turns, [turn]);
});

test('маршрут реплая хранится в карточке независимо от inline-кнопок', async (t) => {
  const { file } = await fixture(t);
  const card = {
    messageId: 42,
    kind: 'question',
    at: T0,
    ownerKey: 'acc:123:555001',
    replyAction: { kind: 'question-text', pid: 'p1abc' },
  };
  const store = new TelegramPultStateStore({ file, log: silent });
  await store.write({ cards: { 'q:p1abc': card } });
  assert.deepEqual((await store.read()).cards['q:p1abc'].replyAction, card.replyAction);
});

test('неизвестный durable-маршрут карточки отвергается fail-closed', async (t) => {
  const { file } = await fixture(t);
  const store = new TelegramPultStateStore({ file, log: silent });
  await assert.rejects(() => store.write({ cards: {
    'q:p1abc': {
      messageId: 42,
      kind: 'question',
      at: T0,
      ownerKey: 'acc:123:555001',
      replyAction: { kind: 'launch-something', taskId: '1' },
    },
  } }), /replyAction|контракт|схем/iu);
});

test('экран навигации пишется и переживает «рестарт»', async (t) => {
  const { file } = await fixture(t);
  const a = new TelegramPultStateStore({ file, log: silent });
  await a.write({ screen: { messageId: 42, at: T0, ownerKey: 'acc:100:200' } });
  const b = new TelegramPultStateStore({ file, log: silent });
  assert.deepEqual((await b.read()).screen, { messageId: 42, at: T0, ownerKey: 'acc:100:200' });
});

test('реестр служебных сообщений пишется и переживает «рестарт»', async (t) => {
  const { file } = await fixture(t);
  const a = new TelegramPultStateStore({ file, log: silent });
  await a.write({ sent: [{ messageId: 7, at: T0 }, { messageId: 8, at: T0 + 1 }] });
  const b = new TelegramPultStateStore({ file, log: silent });
  assert.deepEqual((await b.read()).sent, [{ messageId: 7, at: T0 }, { messageId: 8, at: T0 + 1 }]);
});

test('запись экрана не затирает карточки: слияние идёт от файла, не от памяти', async (t) => {
  const { file } = await fixture(t);
  const watcher = new TelegramPultStateStore({ file, log: silent });
  const actions = new TelegramPultStateStore({ file, log: silent });
  await watcher.write({ cards: { 'wait:1': { messageId: 1, kind: 'gate', at: T0 } } });
  await actions.write({ screen: { messageId: 42, at: T0, ownerKey: 'acc:100:200' } });
  assert.deepEqual((await watcher.read()).cards, { 'wait:1': { messageId: 1, kind: 'gate', at: T0 } });
});

test('запись карточек не затирает экран и реестр другого актора', async (t) => {
  const { file } = await fixture(t);
  const watcher = new TelegramPultStateStore({ file, log: silent });
  const actions = new TelegramPultStateStore({ file, log: silent });
  await actions.write({ screen: { messageId: 42, at: T0, ownerKey: 'acc:100:200' } });
  await actions.write({ sent: [{ messageId: 7, at: T0 }] });
  await watcher.write({ cards: { 'wait:1': { messageId: 1, kind: 'gate', at: T0 } } });
  const state = await actions.read();
  assert.deepEqual(state.screen, { messageId: 42, at: T0, ownerKey: 'acc:100:200' });
  assert.deepEqual(state.sent, [{ messageId: 7, at: T0 }]);
});

test('реестр sent подрезается до потолка: записей не больше 200', async (t) => {
  const { file } = await fixture(t);
  const store = new TelegramPultStateStore({ file, log: silent });
  const sent = Array.from({ length: 220 }, (_, i) => ({ messageId: i + 1, at: T0 + i }));
  await store.write({ sent });
  assert.equal((await store.read()).sent.length, 200);
});

test('реестр sent при переполнении срезает самые старые по at', async (t) => {
  const { file } = await fixture(t);
  const store = new TelegramPultStateStore({ file, log: silent });
  const sent = Array.from({ length: 220 }, (_, i) => ({ messageId: i + 1, at: T0 + i }));
  await store.write({ sent });
  const saved = (await store.read()).sent;
  assert.equal(saved[0].messageId, 21, 'первые 20 (самые старые) срезаны');
});

test('чтение не обгоняет стоящую в очереди запись', async (t) => {
  const { file } = await fixture(t);
  const store = new TelegramPultStateStore({ file, log: silent });
  const write = store.write({ cards: { 'task:1': { messageId: 1, kind: 'gate', at: T0 } } });
  const read = store.read();
  await write;
  assert.equal((await read).cards['task:1']?.messageId, 1);
});
