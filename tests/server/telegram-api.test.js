// Characterization тонкого Bot API транспорта перед переносом materialization
// в channel adapter. Сеть здесь полностью подменена: фиксируем только контракт,
// лимит байтов и то, что секрет не добирается до ошибок.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  downloadFile,
  getFile,
} from '../../server/src/lib/telegram/api.js';

const TOKEN = '8123456789:AAHrEaLLyLoNgSeCrEtPaRt_x1y2z3w4v5u6';

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
