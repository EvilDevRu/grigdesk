// Characterization тонкого Bot API транспорта перед переносом materialization
// в channel adapter. Сеть здесь полностью подменена: фиксируем только контракт,
// лимит байтов и то, что секрет не добирается до ошибок.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  callBotApi,
  downloadFile,
  getFile,
} from '../../server/src/lib/telegram/api.ts';
import * as telegramApi from '../../server/src/lib/telegram/api.ts';

const TOKEN = '8123456789:AAHrEaLLyLoNgSeCrEtPaRt_x1y2z3w4v5u6';

test('sendChatAction отправляет typing одним неидемпотентным вызовом Bot API', async () => {
  const calls = [];
  assert.equal(typeof telegramApi.sendChatAction, 'function');
  await telegramApi.sendChatAction(TOKEN, 555001, 'typing', {
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.deepEqual(calls.map((call) => call.body), [{ chat_id: 555001, action: 'typing' }]);
});

test('sendChatAction не повторяется после неопределённого транспортного обрыва', async () => {
  let attempts = 0;
  assert.equal(typeof telegramApi.sendChatAction, 'function');
  await assert.rejects(() => telegramApi.sendChatAction(TOKEN, 555001, 'typing', {
    retries: 2,
    fetchImpl: async () => {
      attempts += 1;
      throw new Error('socket closed after write');
    },
  }));
  assert.equal(attempts, 1);
});

test('getFile возвращает свежий filePath и размер из Bot API', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return new Response(JSON.stringify({
      ok: true,
      result: {
        file_id: 'file-1',
        file_path: 'documents/report.log',
        file_size: 12_345,
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  assert.deepEqual(await getFile(TOKEN, 'file-1', { fetchImpl }), {
    fileId: 'file-1',
    filePath: 'documents/report.log',
    size: 12_345,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { file_id: 'file-1' });
});

test('downloadFile отвергает content-length выше лимита до чтения body', async () => {
  let bodyRead = false;
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: (name) => (name === 'content-length' ? '5' : null) },
    async arrayBuffer() {
      bodyRead = true;
      return Uint8Array.from([1, 2, 3, 4, 5]).buffer;
    },
  });

  await assert.rejects(
    () => downloadFile(TOKEN, 'documents/report.log', { fetchImpl, limit: 4 }),
    /больше предела/i,
  );
  assert.equal(bodyRead, false, 'известный заранее oversize не читаем в память');
});

test('downloadFile проверяет фактический размер при пустом content-length', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    async arrayBuffer() { return Uint8Array.from([1, 2, 3, 4, 5]).buffer; },
  });

  await assert.rejects(
    () => downloadFile(TOKEN, 'documents/report.log', { fetchImpl, limit: 4 }),
    /больше предела/i,
  );
});

test('транспортный обрыв повторяется только у идемпотентных вызовов', async () => {
  const attempts = [];
  const sleeps = [];
  const sleepImpl = async (ms) => { sleeps.push(ms); };
  const flaky = (failures, payload) => async () => {
    attempts.push(1);
    // Так выглядит живой обрыв TLS до api.telegram.org: fetch отвергает промис,
    // ответа нет вовсе. Именно он ронял подготовку вложений с download_failed.
    if (attempts.length <= failures) throw new Error('unexpected eof while reading');
    return payload();
  };

  const file = await getFile(TOKEN, 'file-1', {
    retries: 2,
    sleepImpl,
    fetchImpl: flaky(2, () => new Response(JSON.stringify({
      ok: true,
      result: { file_id: 'file-1', file_path: 'photos/1.jpg', file_size: 10 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })),
  });
  assert.equal(file.filePath, 'photos/1.jpg');
  assert.equal(attempts.length, 3, 'две дополнительные попытки');
  assert.deepEqual(sleeps, [500, 1500], 'пауза растёт, но остаётся короткой');

  attempts.length = 0;
  const bytes = await downloadFile(TOKEN, 'photos/1.jpg', {
    retries: 2,
    sleepImpl,
    fetchImpl: flaky(1, () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      async arrayBuffer() { return Uint8Array.from([7, 7]).buffer; },
    })),
  });
  assert.equal(bytes.byteLength, 2);
  assert.equal(attempts.length, 2);

  // Отказ самого Телеграма ожиданием не лечится: повторять его — только тянуть
  // время человека, который ждёт ответа формы.
  attempts.length = 0;
  await assert.rejects(() => getFile(TOKEN, 'file-1', {
    retries: 2,
    sleepImpl,
    fetchImpl: async () => {
      attempts.push(1);
      return new Response(JSON.stringify({ ok: false, description: 'file is too big' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    },
  }));
  assert.equal(attempts.length, 1);

  // Умолчание прежнее: у отправки сообщения повтора нет и быть не должно —
  // Bot API не даёт idempotency key, дубль уехал бы в чужой чат.
  attempts.length = 0;
  await assert.rejects(() => callBotApi(TOKEN, 'sendMessage', { chat_id: 1 }, {
    sleepImpl,
    fetchImpl: async () => {
      attempts.push(1);
      throw new Error('unexpected eof while reading');
    },
  }));
  assert.equal(attempts.length, 1);
});

test('transport и Telegram errors не раскрывают токен', async () => {
  const transport = async () => { throw new Error(`connect ${TOKEN} refused`); };
  await assert.rejects(
    () => downloadFile(TOKEN, 'documents/report.log', { fetchImpl: transport }),
    (err) => {
      assert.ok(!err.message.includes(TOKEN));
      assert.match(err.message, /…v5u6/);
      return true;
    },
  );

  const rejected = async () => new Response(JSON.stringify({
    ok: false,
    description: `bad token ${TOKEN}`,
  }), { status: 400, headers: { 'content-type': 'application/json' } });
  await assert.rejects(
    () => getFile(TOKEN, 'file-1', { fetchImpl: rejected }),
    (err) => {
      assert.ok(!err.message.includes(TOKEN));
      assert.match(err.message, /…v5u6/);
      return true;
    },
  );
});
