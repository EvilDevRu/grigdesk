import assert from 'node:assert/strict';
import test from 'node:test';

import { DeepSeekWebClient, DeepSeekWebError } from '../../server/src/lib/deepseek/serverClient.ts';

const MIB = 1024 * 1024;
const BAD_RESPONSE_MESSAGE = 'DeepSeek web вернул повреждённый RPC-ответ';

/**
 * Подменяет только HTTP: авторизация выдаёт cookie, RPC получает настоящий rpcId.
 * Поток ответа остаётся независимым от fetch-сигнала, чтобы проверить отмену самим клиентом.
 */
async function clientFixture(t, respond) {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    if (init.redirect === 'manual') {
      return new Response(null, {
        status: 303,
        headers: { 'set-cookie': 'fixture=valid; HttpOnly' },
      });
    }

    return respond(JSON.parse(init.body), init.signal);
  });

  return DeepSeekWebClient.authenticate('http://127.0.0.1/?token=fixture');
}

/**
 * Выдаёт байты небольшими порциями без опережающего чтения.
 * Отмена фиксируется на источнике, чтобы отличить её от простого отказа JSON.parse.
 */
function streamedResponse(bytes) {
  const state = { offset: 0, cancelled: false };
  const body = new ReadableStream({
    pull(controller) {
      if (state.offset === bytes.byteLength) {
        controller.close();

        return;
      }

      const end = Math.min(state.offset + 65537, bytes.byteLength);

      controller.enqueue(bytes.subarray(state.offset, end));
      state.offset = end;
    },
    cancel() {
      state.cancelled = true;
    },
  }, { highWaterMark: 0 });

  return { response: new Response(body), state };
}

/**
 * Проверяет публичный контракт для любого сбоя чтения или разбора RPC-тела.
 * Ошибки загрузчика схем настроек не должны становиться причиной отказа RPC.
 */
function assertBadResponse(error) {
  assert.ok(error instanceof DeepSeekWebError);
  assert.equal(error.code, 'deepseek_bad_response');
  assert.equal(error.message, BAD_RESPONSE_MESSAGE);
  assert.equal(error.uncertain, true);

  return true;
}

for (const withSignal of [true, false]) {
  test(`session/page: ответ больше 2 МиБ, signal=${withSignal}`, async (t) => {
    const value = {
      records: [{ type: 'tool/result', data: `${'x'.repeat(3 * MIB)}конец истории` }],
    };
    const client = await clientFixture(t, (request) => {
      assert.equal(request.method, 'session/page');
      assert.equal(request.payload.args.maxMessages, 100);

      const bytes = new TextEncoder().encode(JSON.stringify({
        type: 'server-response',
        rpcId: request.rpcId,
        result: { ok: true, value },
      }));

      assert.ok(bytes.byteLength > 2 * MIB);

      return streamedResponse(bytes).response;
    });
    const signal = withSignal ? new AbortController().signal : undefined;
    const result = await client.rpc('session/page', { maxMessages: 100 }, 30_000, signal);

    assert.equal(result.records[0].data.length, value.records[0].data.length);
    assert.equal(result.records[0].data, value.records[0].data);
  });

  test(`RPC: предел 32 МиБ считается по байтам, signal=${withSignal}`, async (t) => {
    let state;
    const client = await clientFixture(t, (request) => {
      const bytes = new TextEncoder().encode(JSON.stringify({
        type: 'server-response',
        rpcId: request.rpcId,
        result: { ok: true, value: 'я'.repeat(16 * MIB + 65536) },
      }));

      assert.ok(bytes.byteLength > 32 * MIB);

      const stream = streamedResponse(bytes);

      state = stream.state;

      return stream.response;
    });
    const signal = withSignal ? new AbortController().signal : undefined;

    await assert.rejects(client.rpc('session/page', {}, 30_000, signal), assertBadResponse);
    assert.equal(state.cancelled, true);
    assert.ok(state.offset > 32 * MIB, 'Клиент должен дочитать до собственного предела');
    assert.ok(state.offset < 32 * MIB + 65537, 'Лишние порции после предела не читаются');
  });
}

test('RPC: abort посреди чтения вызывает reader.cancel и отклоняет promise', async (t) => {
  const controller = new AbortController();
  const reading = Promise.withResolvers();
  let reader;
  let sent = false;
  const body = new ReadableStream({
    pull(streamController) {
      if (!sent) {
        sent = true;
        streamController.enqueue(new TextEncoder().encode('{"type":"server-response",'));

        return;
      }

      reading.resolve();
    },
  }, { highWaterMark: 0 });
  const getReader = body.getReader.bind(body);

  t.mock.method(body, 'getReader', () => {
    reader = getReader();
    t.mock.method(reader, 'cancel');

    return reader;
  });

  const client = await clientFixture(t, () => new Response(body));
  const rpc = client.rpc('session/page', {}, 30_000, controller.signal);
  const rejected = assert.rejects(rpc, assertBadResponse);

  await reading.promise;
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));

  // Проверка идёт до ожидания rpc: старый helper иначе зависает на незавершённом read.
  t.after(() => reader.cancel().catch(() => {}));
  assert.ok(reader.cancel.mock.callCount() > 0);
  await rejected;
  assert.equal(body.locked, false);
});
