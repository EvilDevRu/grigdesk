import assert from 'node:assert/strict';
import test from 'node:test';

import { TelegramAccountPoller } from '../../server/src/lib/telegram/accountPoller.ts';

const token = '8123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture({ updates = [], enabled = () => true, call = null, onMessage = null } = {}) {
  const appended = [];
  const writes = [];
  const changed = [];
  let current = true;
  let releases = 0;
  const context = {
    botId: '8123456789',
    credentials: { botId: '8123456789', token },
    archive: {
      append: async (message) => appended.push(message),
      flush: async () => {},
    },
    pollState: {
      read: async () => ({ offset: 7, updatedAtMs: 1 }),
      write: async (value) => writes.push(value),
    },
  };
  const lease = {
    accountRef: 'acc_bot', generation: 3, context,
    isCurrent: () => current,
    release: () => { releases += 1; },
  };
  const calls = [];
  const botApi = {
    callBotApi: call || (async (...args) => { calls.push(args); return updates; }),
  };
  const poller = new TelegramAccountPoller({
    acquireLease: () => lease,
    botApi,
    isEnabled: enabled,
    now: () => 1_800_000_000_000,
    onChanged: (event) => changed.push(event),
    onMessage,
    timeoutSec: 0,
    log: { warn() {}, error() {} },
  });
  return {
    poller, context, calls, appended, writes, changed,
    setCurrent: (value) => { current = value; },
    releases: () => releases,
  };
}

test('disabled Telegram poller не берёт lease и не читает сеть', async () => {
  let acquired = 0;
  const poller = new TelegramAccountPoller({
    acquireLease: () => { acquired += 1; throw new Error('unexpected'); },
    botApi: { callBotApi: async () => { throw new Error('unexpected'); } },
    isEnabled: () => false,
    timeoutSec: 0,
  });
  assert.deepEqual(await poller.tick(), { polled: false, reason: 'plugin_disabled' });
  assert.equal(acquired, 0);
});

test('поллер передаёт id автора сообщения, на которое ответил владелец', async () => {
  const delivered = [];
  const f = fixture({
    onMessage: async (message) => delivered.push(message),
    updates: [{
      update_id: 8,
      message: {
        message_id: 4,
        date: 1_780_000_000,
        chat: { id: 555001, type: 'private', first_name: 'Аня' },
        from: { id: 555001, first_name: 'Аня' },
        text: 'свой ответ',
        reply_to_message: {
          message_id: 3,
          from: { id: 8123456789, first_name: 'GrigDesk', is_bot: true },
          text: 'карточка вопроса',
        },
      },
    }],
  });
  await f.poller.tick();
  assert.deepEqual(
    { replyToMessageId: delivered[0]?.replyToMessageId, replyToFromId: delivered[0]?.replyToFromId },
    { replyToMessageId: 3, replyToFromId: 8123456789 },
  );
});

test('poller пишет update и offset только в захваченный account context', async () => {
  const f = fixture({
    updates: [{
      update_id: 8,
      message: {
        message_id: 4,
        date: 1_780_000_000,
        chat: { id: -1001, type: 'supergroup', title: 'Баги' },
        from: { id: 42, first_name: 'Иван' },
        text: 'Не открывается форма',
      },
    }],
  });
  assert.deepEqual(await f.poller.tick(), { polled: true, updates: 1 });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][1], 'getUpdates');
  assert.equal(f.calls[0][2].offset, 7);
  assert.equal(f.appended.length, 1);
  assert.deepEqual(f.writes, [{ offset: 9, updatedAtMs: 1_800_000_000_000 }]);
  assert.equal(f.poller.status().offset, 9);
  assert.equal(f.changed.length, 1);
  assert.equal(f.releases(), 1);
});

test('network result старой generation отбрасывается до append и offset commit', async () => {
  const gate = deferred();
  const started = deferred();
  let f;
  f = fixture({
    call: async () => {
      started.resolve();
      await gate.promise;
      return [{ update_id: 9, message: {
        message_id: 5,
        date: 1_780_000_001,
        chat: { id: -1001, type: 'supergroup', title: 'Баги' },
        from: { id: 42, first_name: 'Иван' },
        text: 'Поздний результат',
      } }];
    },
  });
  const result = f.poller.tick();
  await started.promise;
  f.setCurrent(false);
  gate.resolve();
  assert.deepEqual(await result, { polled: true, discarded: true, reason: 'account_changed' });
  assert.deepEqual(f.appended, []);
  assert.deepEqual(f.writes, []);
  assert.equal(f.releases(), 1);
});

test('stop ждёт завершения отмены начатого long poll', async () => {
  const gate = deferred();
  const started = deferred();
  const f = fixture({ call: async (_token, _method, _body, { signal }) => {
    started.resolve(signal);
    await gate.promise;

    return [];
  } });
  const tick = f.poller.tick();
  const signal = await started.promise;
  let stopped = false;
  const stopping = f.poller.stop().then(() => { stopped = true; });

  assert.equal(signal.aborted, true);
  await Promise.resolve();
  assert.equal(stopped, false);
  gate.resolve();
  await tick;
  await stopping;
  assert.equal(stopped, true);
  assert.equal(f.releases(), 1);
});

test('stop отменяет сеть, пропускает queued ticks и не меняет offset', async () => {
  const started = deferred();
  let calls = 0;
  const f = fixture({ call: async (_token, _method, _body, { signal }) => {
    calls += 1;
    started.resolve();

    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  } });
  const first = f.poller.tick();

  await started.promise;

  const queued = f.poller.tick();

  await f.poller.stop();
  await Promise.all([first, queued]);
  assert.equal(calls, 1);
  assert.deepEqual(f.writes, []);
  assert.equal(f.poller.lastError, null, 'Остановка не становится сетевой ошибкой');
  assert.equal(f.releases(), 1);
});

test('stop посреди updates сохраняет обработанный префикс без второго callback', async () => {
  const entered = deferred();
  const release = deferred();
  const handled = [];
  const message = (id) => ({
    update_id: id,
    message: {
      message_id: id,
      date: 100,
      chat: { id: 42, type: 'private' },
      text: 'синтетика',
    },
  });
  const f = fixture({
    updates: [message(8), message(9)],
    onMessage: async (value) => {
      handled.push(value);
      entered.resolve();
      await release.promise;
    },
  });
  const tick = f.poller.tick();

  await entered.promise;

  const stopping = f.poller.stop();

  release.resolve();
  await stopping;
  await tick;
  assert.equal(handled.length, 1);
  assert.equal(f.writes[0].offset, 9, 'Успешный callback не будет исполнен повторно');
});

test('409 Bot API становится безопасной poll_conflict диагностикой', async () => {
  const f = fixture({ call: async () => { throw Object.assign(new Error(`token ${token}`), { status: 409 }); } });
  const result = await f.poller.tick();
  assert.equal(result.error.code, 'poll_conflict');
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(f.poller.status().conflict, true);
});
