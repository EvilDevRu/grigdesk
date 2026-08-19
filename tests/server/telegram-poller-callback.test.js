// Срез P телеграм-пульта: callback_query в общем поллере (план, §4/§5.3).
//
// Обещания:
//  - `allowed_updates` в getUpdates содержит callback_query (иначе кнопки немы);
//  - callback-апдейт маршрутизируется в onCallback нормализованным, offset двигается
//    и по нему, в архив он НЕ пишется (это нажатие, а не переписка);
//  - lease-дисциплина не нарушена: смена generation отбрасывает обработку.
import assert from 'node:assert/strict';
import test from 'node:test';

import { TelegramAccountPoller } from '../../server/src/lib/telegram/account-poller.js';
import { normalizeUpdate } from '../../server/src/lib/telegram/updates.js';

const token = '8123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi';

const CALLBACK_UPDATE = {
  update_id: 21,
  callback_query: {
    id: 'cb-1001',
    from: { id: 555001, first_name: 'Аня', username: 'anya' },
    message: {
      message_id: 42,
      chat: { id: 555001, type: 'private' },
      date: 1_780_000_000,
      text: '⏳ #4187 ждёт тебя',
    },
    data: 'g:4187:GATE_PLAN:a',
  },
};

function fixture({ updates = [], onCallback = null } = {}) {
  const appended = [];
  const writes = [];
  const callbacks = [];
  let current = true;
  const context = {
    botId: '8123456789',
    credentials: { botId: '8123456789', token },
    archive: { append: async (message) => appended.push(message), flush: async () => {} },
    pollState: {
      read: async () => ({ offset: 7, updatedAtMs: 1 }),
      write: async (value) => writes.push(value),
    },
  };
  const lease = {
    accountRef: 'acc_bot',
    generation: 3,
    context,
    isCurrent: () => current,
    release: () => {},
  };
  const calls = [];
  const poller = new TelegramAccountPoller({
    acquireLease: () => lease,
    botApi: { callBotApi: async (...args) => { calls.push(args); return updates; } },
    isEnabled: () => true,
    now: () => 1_800_000_000_000,
    onCallback: onCallback || (async (callback, callbackLease) => callbacks.push({ callback, callbackLease })),
    timeoutSec: 0,
    log: { warn() {}, error() {} },
  });
  return {
    poller, calls, appended, writes, callbacks, setCurrent: (value) => { current = value; },
  };
}

test('normalizeUpdate разбирает callback_query в наш контракт', () => {
  const update = normalizeUpdate(CALLBACK_UPDATE);
  assert.equal(update.type, 'callback');
  assert.equal(update.msg, null);
  assert.deepEqual(update.callback, {
    id: 'cb-1001',
    data: 'g:4187:GATE_PLAN:a',
    from: { id: 555001, name: 'Аня', username: 'anya' },
    chatId: 555001,
    chatType: 'private',
    messageId: 42,
  });
});

test('getUpdates просит callback_query; нажатие уходит в onCallback, offset двигается, архив не растёт', async () => {
  const f = fixture({ updates: [CALLBACK_UPDATE] });
  assert.deepEqual(await f.poller.tick(), { polled: true, updates: 1 });
  assert.equal(f.calls[0][1], 'getUpdates');
  assert.equal(f.calls[0][2].allowed_updates.includes('callback_query'), true);

  assert.equal(f.callbacks.length, 1);
  assert.equal(f.callbacks[0].callback.data, 'g:4187:GATE_PLAN:a');
  assert.equal(typeof f.callbacks[0].callbackLease.isCurrent, 'function');
  assert.equal(f.appended.length, 0, 'нажатие кнопки — не сообщение, в архив не пишется');
  assert.deepEqual(f.writes, [{ offset: 22, updatedAtMs: 1_800_000_000_000 }]);
});

test('смена generation во время обработки callback отбрасывает остаток пачки', async () => {
  let seen = 0;
  const f = fixture({
    updates: [CALLBACK_UPDATE, { ...CALLBACK_UPDATE, update_id: 22 }],
    onCallback: async () => { seen += 1; f.setCurrent(false); },
  });
  const result = await f.poller.tick();
  assert.equal(result.discarded, true);
  assert.equal(seen, 1, 'второй callback старой generation не обрабатывается');
  assert.deepEqual(f.writes, [], 'offset старой generation не коммитится');
});
