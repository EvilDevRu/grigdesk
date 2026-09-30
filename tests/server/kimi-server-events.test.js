// Поток событий Kimi: подпротокол с токеном, подписка на сессии и доставка кадров.
//
// Проверяем контракт, снятый с установленного сервера 0.33.0: токен едет подпротоколом
// `kimi-code.bearer.<token>`, после открытия уходит `subscribe` со списком сессий, а
// серверные кадры доходят до подписчика без потерь.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  KIMI_WS_BEARER_PREFIX,
  kimiEventSocketUrl,
  openKimiEventStream,
} from '../../server/src/lib/kimi/serverEvents.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const websocket = requireFromServer('@fastify/websocket');

/**
 * Фейковый сервер событий: запоминает подпротокол и подписку, умеет push кадров.
 * Настоящий WebSocket, поэтому проверяется и рукопожатие, и кадры.
 */
async function fakeEventServer(t) {
  const app = Fastify({ logger: false });
  const state = { protocol: '', subscribe: null, socket: null };

  await app.register(websocket);
  app.get('/api/v1/ws', { websocket: true }, (socket, request) => {
    state.protocol = String(request.headers['sec-websocket-protocol'] || '');
    state.socket = socket;
    socket.on('message', (raw) => {
      state.subscribe = JSON.parse(String(raw));
    });
  });

  await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => app.close());

  const address = app.server.address();

  return { state, baseUrl: `http://127.0.0.1:${address.port}` };
}

test('Kimi: адрес сокета и подпротокол с токеном', () => {
  assert.equal(
    kimiEventSocketUrl('http://127.0.0.1:58627/', 'client-1'),
    'ws://127.0.0.1:58627/api/v1/ws?client_id=client-1',
  );
  assert.equal(
    kimiEventSocketUrl('https://kimi.local', 'client-1'),
    'wss://kimi.local/api/v1/ws?client_id=client-1',
  );
  assert.equal(KIMI_WS_BEARER_PREFIX, 'kimi-code.bearer.');
});

test('Kimi: поток подписывается на сессии и отдаёт кадры подписчику', async (t) => {
  const { state, baseUrl } = await fakeEventServer(t);
  const events = [];
  const closed = [];

  const stream = openKimiEventStream({
    baseUrl,
    token: 'secret-token',
    sessionIds: ['session-fixture-0001'],
    clientId: 'client-fixture',
    onEvent: (event) => events.push(event),
    onClose: (info) => closed.push(info),
  });

  await stream.ready;
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(state.protocol, `${KIMI_WS_BEARER_PREFIX}secret-token`);
  assert.deepEqual(state.subscribe, {
    type: 'subscribe',
    id: 'c_1',
    payload: { session_ids: ['session-fixture-0001'] },
  });

  state.socket.send(JSON.stringify({
    type: 'event.assistant.delta',
    seq: 42,
    session_id: 'session-fixture-0001',
    payload: { message_id: 'message-1', delta: 'Потому что ' },
  }));
  state.socket.send(JSON.stringify({
    type: 'event.assistant.completed',
    seq: 43,
    session_id: 'session-fixture-0001',
    payload: { message_id: 'message-1', content: [{ type: 'text', text: 'Потому что он меньше.' }] },
  }));

  await waitFor(() => events.length === 2, 'два события из потока');

  assert.equal(events[0].type, 'event.assistant.delta');
  assert.equal(events[0].payload.delta, 'Потому что ');
  assert.equal(events[1].payload.message_id, 'message-1');

  stream.close();
  await waitFor(() => closed.length === 1, 'закрытие соединения');
  assert.equal(closed[0].code, 1000);
});

test('Kimi: битый кадр не рвёт поток, ошибка соединения видна вызывающему', async (t) => {
  const { state, baseUrl } = await fakeEventServer(t);
  const events = [];
  const errors = [];

  const stream = openKimiEventStream({
    baseUrl,
    token: 'token',
    sessionIds: ['session-fixture-0001'],
    onEvent: (event) => events.push(event),
    onError: (error) => errors.push(error),
  });

  await stream.ready;
  state.socket.send('не-json');
  state.socket.send(JSON.stringify({ type: 'event.turn.ended', seq: 44, session_id: 'session-fixture-0001' }));

  await waitFor(() => events.length === 1, 'валидный кадр после мусора');
  assert.equal(events[0].type, 'event.turn.ended');
  assert.equal(errors.length, 0);

  const broken = openKimiEventStream({
    baseUrl: 'http://127.0.0.1:1',
    token: 'token',
    sessionIds: ['session-fixture-0001'],
    onEvent: () => {},
    onError: (error) => errors.push(error),
  });

  await assert.rejects(() => broken.ready);
  assert.equal(errors.length, 1);
});

/** Ожидание условия короткими паузами: настоящие задержки в тесте не нужны. */
async function waitFor(check, what, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (check()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`не дождались: ${what}`);
}
