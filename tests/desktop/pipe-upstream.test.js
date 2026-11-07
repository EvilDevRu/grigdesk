import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { temporary } from '../relay/helpers.js';
import { clientFixture } from '../server/helpers/clientAccess.js';
import { sealedIdentity } from '../../desktop/src/identity.ts';
import { sealUiRelease } from '../../desktop/src/uiRelease.ts';
import { startPipe } from '../../desktop/src/pipe/pipeServer.ts';
import { createUpstream } from '../../desktop/src/pipe/upstream.ts';

const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const WebSocket = requireServer('ws');
const COOKIE = 'grigdesk_pipe=synthetic-pipe-secret';

/**
 * Миниатюрный интерфейс запечатан отдельно от сервера заглушки.
 * Порты случайные; cookie и ключ окна существуют только в этой фикстуре.
 */
async function makePipe(t, upstream) {
  const directory = await temporary(t);

  await writeFile(path.join(directory, 'index.html'), '<h1>Машины</h1>');
  await sealUiRelease(directory);

  const pipe = await startPipe({
    port: 0,
    uiDir: directory,
    secret: 'synthetic-pipe-secret',
    appApi: { major: 0, minor: 1 },
    upstream,
  });

  t.after(() => pipe.close());

  return pipe;
}

/**
 * Заглушка наблюдает каждый запрос и даёт поток, бинарное эхо и истекающую сессию.
 * Счётчики позволяют отличить обновление cookie от повторной мутации.
 */
async function localMachine(t) {
  const calls = [];
  let version = '0.1';
  let sessions = 0;
  let failNext = false;
  let sessionValid = false;
  let helloDelay = 0;
  let helloFailure = false;
  let releaseLate = () => {};
  const server = http.createServer((req, res) => {
    calls.push({
      path: req.url,
      method: req.method,
      headers: req.headers,
    });
    res.setHeader('X-GrigDesk-Api', version);

    if (req.url === '/api/auth/window-session') {
      assert.equal(req.headers['x-grigdesk-window-key'], 'synthetic-key');
      sessions += 1;
      sessionValid = true;
      res.setHeader('set-cookie', `grigdesk_sid=session${sessions}; HttpOnly`);
      res.end('{}');
    } else if (failNext) {
      failNext = false;
      res.writeHead(401).end('{}');
    } else if (req.url === '/api/auth/state') {
      res.end(JSON.stringify({ authenticated: sessionValid }));
    } else if (req.url === '/api/client/hello' && !sessionValid) {
      res.writeHead(401).end('{}');
    } else if (req.url === '/api/client/hello') {
      setTimeout(() => res.writeHead(helloFailure ? 503 : 200).end('{}'), helloDelay).unref();
    } else if (req.url === '/api/slow-review') {
      req.resume();
      setTimeout(() => res.end('{"ok":true}'), 4000).unref();
    } else if (req.url === '/api/failure-review') {
      res.writeHead(500).end('{"error":"fixture"}');
    } else if (req.url === '/api/late') {
      releaseLate = () => res.end('{}');
    } else if (req.url === '/api/held-events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
    } else if (req.url === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      setTimeout(() => res.end('data: second\n\n'), 80);
    } else if (req.url === '/api/echo') {
      req.pipe(res);
    } else {
      res.setHeader('set-cookie', 'grigdesk_sid=never-renderer');
      res.end(JSON.stringify(req.headers));
    }
  });
  const ws = new WebSocket.Server({ server });

  ws.on('connection', (socket) => socket.on('message', (value, binary) => socket.send(value, { binary })));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const client of ws.clients) {
      client.terminate();
    }

    ws.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  return {
    calls,
    address: `http://127.0.0.1:${server.address().port}`,
    version(value) {
      version = value;
    },
    fail() {
      failNext = true;
    },
    sessions: () => sessions,
    hello(delay, failure = false) {
      helloDelay = delay;
      helloFailure = failure;
    },
    expire() {
      sessionValid = false;
    },
    releaseLate: () => releaseLate(),
  };
}

/**
 * Наблюдает выдачу настоящего клиентского сокета, не добавляя ему close-слушателей.
 * Фильтр порта исключает локальную трубу и внутренние запросы TLS-стенда.
 */
function observeUpstreamSockets(t, address) {
  const port = Number(new URL(address).port);
  const sockets = new Set();
  const warnings = [];
  const original = http.Agent.prototype.addRequest;

  t.mock.method(http.Agent.prototype, 'addRequest', function (request, options, ...rest) {
    if (Number(options.port) === port) {
      request.once('socket', (socket) => sockets.add(socket));
    }

    return Reflect.apply(original, this, [request, options, ...rest]);
  });

  const onWarning = (warning) => {
    if (warning.name === 'MaxListenersExceededWarning'
      && warning.type === 'close' && sockets.has(warning.emitter)) {
      warnings.push(warning);
    }
  };

  process.on('warning', onWarning);
  t.after(() => process.off('warning', onWarning));

  return { sockets, warnings };
}

/**
 * Удалённый вариант использует настоящий pinned TLS-вход и синтетическое привязанное устройство.
 * Все ключи и состояние создаются соседней фикстурой во временной папке.
 */
async function socketReuseMachine(t, remote) {
  if (!remote) {
    const machine = await localMachine(t);

    return { address: machine.address, windowKey: async () => 'synthetic-key' };
  }

  const fixture = await clientFixture(t, {
    register({ app }) {
      app.get('/api/client/hello', async () => ({ product: 'grigdesk' }));
    },
  });

  await fixture.devices.add({
    name: 'Тестовое окно',
    fp: fixture.client.fp,
    scope: 'client',
  });

  return {
    address: `https://127.0.0.1:${fixture.port}`,
    fp: fixture.identity.fp,
    identity: { key: fixture.client.keyPem, cert: fixture.client.certPem },
  };
}

for (const remote of [false, true]) {
  for (const mode of ['GET', 'probe', 'GET + probe']) {
    const protocol = remote ? 'TLS' : 'HTTP';

    test(`${protocol}: 30 ${mode} не накапливают close на одном живом сокете`,
      { timeout: 15000 }, async (t) => {
        const options = await socketReuseMachine(t, remote);
        const observed = observeUpstreamSockets(t, options.address);
        const upstream = createUpstream(options);
        const pipe = await makePipe(t, upstream);
        const counts = [];

        t.after(() => upstream.close());

        for (let index = 0; index < 30; index += 1) {
          const operations = mode === 'GET + probe' ? ['GET', 'probe'] : [mode];

          for (const operation of operations) {
            if (operation === 'GET') {
              const response = await fetch(`${pipe.origin}/api/private`, { headers: { cookie: COOKIE } });

              assert.equal(response.status, 200);
              assert.ok(await response.text(), 'Короткий ответ полностью прочитан.');
            } else {
              await upstream.probe();
              assert.equal(upstream.state().status, 'online');
            }

            // Даём Agent убрать временные слушатели завершившегося HTTP-запроса.
            // Измеряем живой свободный сокет, а не незавершённый ответ.
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(observed.sockets.size, 1, 'Все операции переиспользуют один сокет.');

            const [socket] = observed.sockets;

            assert.equal(socket.destroyed, false);
            assert.equal(socket.getMaxListeners(), 10, 'Штатный лимит слушателей не повышен.');
            counts.push(socket.listenerCount('close'));
          }
        }

        const [socket] = observed.sockets;

        if (remote) {
          assert.equal(socket.getProtocol(), 'TLSv1.3');
          assert.equal(socket.getPeerX509Certificate().fingerprint256.replaceAll(':', '').toLowerCase(),
            options.fp);
        }

        const closed = once(socket, 'close');

        upstream.close();
        await closed;
        assert.equal(socket.destroyed, true);
        assert.ok(socket.listenerCount('close') < counts[0], 'Закрытие освободило close-обработчики.');
        t.diagnostic(`close после операций: ${counts.join(', ')}; warnings: ${observed.warnings.length}`);

        for (const [index, count] of counts.entries()) {
          assert.equal(count, counts[0], `Число close выросло после операции ${index + 1}.`);
        }

        assert.equal(observed.warnings.length, 0, 'Переиспользование не вызывает предупреждение close.');
      });
  }
}

test('местная труба очищает заголовки, передаёт 5 МиБ, SSE и бинарный WebSocket', async (t) => {
  const machine = await localMachine(t);
  const upstream = createUpstream({ address: machine.address, windowKey: async () => 'synthetic-key' });
  const pipe = await makePipe(t, upstream);
  const headers = {
    cookie: COOKIE,
    origin: pipe.origin,
    'x-grigdesk-token': 'forbidden',
    'x-grigdesk-internal': 'forbidden',
    'x-grigdesk-window-key': 'forbidden',
    forwarded: 'forbidden',
    'x-forwarded-for': 'forbidden',
  };
  const response = await fetch(`${pipe.origin}/api/headers`, { headers });
  const received = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(received.host, new URL(machine.address).host);
  assert.equal(received.origin, machine.address);
  assert.equal(received.cookie, 'grigdesk_sid=session1');

  for (const name of ['x-grigdesk-token', 'x-grigdesk-internal', 'x-grigdesk-window-key',
    'forwarded', 'x-forwarded-for']) {
    assert.equal(received[name], undefined);
  }

  const bytes = Buffer.alloc(5 * 1024 * 1024, 197);
  const echo = await fetch(`${pipe.origin}/api/echo`, {
    method: 'POST',
    headers,
    body: bytes,
  });

  assert.deepEqual(Buffer.from(await echo.arrayBuffer()), bytes);

  const events = await fetch(`${pipe.origin}/api/events`, { headers });
  const reader = events.body.getReader();
  const first = await reader.read();

  assert.match(new TextDecoder().decode(first.value), /first/);
  assert.equal(first.done, false);
  await reader.cancel();

  const socket = new WebSocket(`${pipe.origin.replace('http:', 'ws:')}/api/ws`, {
    headers: { cookie: COOKIE },
  });

  await once(socket, 'open');
  socket.send(Buffer.from([0, 255, 3]));

  const [message, binary] = await once(socket, 'message');

  assert.deepEqual([...message], [0, 255, 3]);
  assert.equal(binary, true);
  socket.terminate();

  const rejected = new WebSocket(`${pipe.origin.replace('http:', 'ws:')}/api/ws`);
  const rejection = await new Promise((resolve) => {
    rejected.on('unexpected-response', (_req, reply) => {
      resolve(reply.statusCode);
      reply.resume();
      rejected.terminate();
    });
    rejected.on('error', () => {});
  });

  assert.equal(rejection, 403);
});

test('местная сессия обновляется один раз; GET повторяется, POST не повторяется', async (t) => {
  const machine = await localMachine(t);
  const upstream = createUpstream({ address: machine.address, windowKey: async () => 'synthetic-key' });
  const pipe = await makePipe(t, upstream);
  const headers = { cookie: COOKIE };

  await fetch(`${pipe.origin}/api/headers`, { headers });
  machine.fail();
  assert.equal((await fetch(`${pipe.origin}/api/headers`, { headers })).status, 200);
  assert.equal(machine.sessions(), 2);
  machine.fail();

  const mutation = await fetch(`${pipe.origin}/api/mutate`, {
    headers,
    method: 'POST',
    body: 'one',
  });

  assert.equal(mutation.status, 401);
  assert.equal(machine.calls.filter((call) => call.path === '/api/mutate').length, 1);
  assert.equal(machine.sessions(), 3);
});

test('несовместимость защёлкивается до следующего запроса к машине', async (t) => {
  const machine = await localMachine(t);
  const upstream = createUpstream({ address: machine.address, windowKey: async () => 'synthetic-key' });
  const pipe = await makePipe(t, upstream);
  const headers = { cookie: COOKIE };

  machine.version('1.0');

  const first = await fetch(`${pipe.origin}/api/headers`, { headers });

  assert.equal(first.status, 426);
  assert.equal((await first.json()).error, 'client_upgrade_required');

  const count = machine.calls.length;

  assert.equal((await fetch(`${pipe.origin}/api/headers`, { headers })).status, 426);
  assert.equal(machine.calls.length, count);
  assert.equal(upstream.state().status, 'incompatible');
});

test('удалённая труба сверяет pin до HTTP и различает unpaired, revoked и offline', async (t) => {
  let requests = 0;
  const fixture = await clientFixture(t, {
    register({ app }) {
      app.addHook('onRequest', async () => {
        requests += 1;
      });
      app.get('/api/client/hello', async () => ({ product: 'grigdesk' }));
      app.get('/api/forbidden', async (_req, reply) => reply.code(403).send({ error: 'permission_denied' }));
    },
  });
  const directory = await temporary(t);
  const keyDirectory = path.join(directory, 'identity');
  const store = sealedIdentity({
    available: () => true,
    seal: (text) => Buffer.from(text),
    open: (data) => data.toString(),
  });
  const identity = await store.create(keyDirectory, 'Тестовая установка');
  const fp = new (await import('node:crypto')).X509Certificate(identity.cert)
    .fingerprint256.replaceAll(':', '').toLowerCase();
  const device = await fixture.devices.add({
    name: 'Окно',
    fp,
    scope: 'client',
  });
  const address = `https://127.0.0.1:${fixture.port}`;
  const upstream = createUpstream({
    address,
    fp: fixture.identity.fp,
    identity,
  });
  const pipe = await makePipe(t, upstream);
  const headers = { cookie: COOKIE };

  await upstream.probe();
  assert.equal((await fetch(`${pipe.origin}/api/private`, { headers })).status, 200);
  assert.equal(upstream.state().status, 'online');
  assert.equal((await fetch(`${pipe.origin}/api/forbidden`, { headers })).status, 403);
  assert.equal(upstream.state().status, 'online', 'Обычный запрет не отзывает устройство.');
  assert.equal((await fetch(`${pipe.origin}/api/private`, { headers })).status, 200);

  const wrong = createUpstream({
    address,
    fp: '00'.repeat(32),
    identity,
  });
  const wrongPipe = await makePipe(t, wrong);
  const before = requests;

  assert.equal((await fetch(`${wrongPipe.origin}/api/private`, { headers })).status, 503);
  assert.equal(wrong.state().status, 'identityMismatch');
  assert.equal(requests, before);

  const stranger = createUpstream({
    address,
    fp: fixture.identity.fp,
    identity: { key: fixture.stranger.keyPem, cert: fixture.stranger.certPem },
  });
  const strangerPipe = await makePipe(t, stranger);

  assert.equal((await fetch(`${strangerPipe.origin}/api/private`, { headers })).status, 401);
  assert.equal(stranger.state().status, 'unpaired');
  await fixture.devices.revoke(device.id);
  fixture.listener.disconnect(fp);
  upstream.close();

  const revoked = createUpstream({
    address,
    fp: fixture.identity.fp,
    identity,
  });
  const revokedPipe = await makePipe(t, revoked);

  assert.equal((await fetch(`${revokedPipe.origin}/api/private`, { headers })).status, 403);
  assert.equal(revoked.state().status, 'revoked');
  await fixture.listener.close();

  const unavailable = createUpstream({
    address,
    fp: fixture.identity.fp,
    identity,
  });
  const unavailablePipe = await makePipe(t, unavailable);

  assert.equal((await fetch(`${unavailablePipe.origin}/api/private`, { headers })).status, 503);
  await unavailable.probe();
  assert.equal(unavailable.state().status, 'offline');
});


test('поздний совместимый ответ не снимает защёлку incompatible', async (t) => {
  const machine = await localMachine(t);
  const upstream = createUpstream({ address: machine.address, windowKey: async () => 'synthetic-key' });
  const pipe = await makePipe(t, upstream);
  const headers = { cookie: COOKIE };
  const late = fetch(`${pipe.origin}/api/late`, { headers });

  while (!machine.calls.some((call) => call.path === '/api/late')) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  machine.version('1.0');
  assert.equal((await fetch(`${pipe.origin}/api/headers`, { headers })).status, 426);
  machine.releaseLate();
  assert.equal((await late).status, 426);
  assert.equal(upstream.state().status, 'incompatible');
  assert.deepEqual(upstream.state().serverApi, { major: 1, minor: 0 });
});


test('несовместимость закрывает уже открытые SSE и upgrade', { timeout: 7000 }, async (t) => {
  const machine = await localMachine(t);
  const upstream = createUpstream({ address: machine.address, windowKey: async () => 'synthetic-key' });
  const pipe = await makePipe(t, upstream);
  const headers = { cookie: COOKIE };
  const events = await fetch(`${pipe.origin}/api/held-events`, { headers });
  const reader = events.body.getReader();

  await reader.read();

  const socket = new WebSocket(`${pipe.origin.replace('http:', 'ws:')}/api/ws`, { headers });

  await once(socket, 'open');

  let closed = false;

  socket.once('close', () => {
    closed = true;
  });
  machine.version('1.0');
  assert.equal((await fetch(`${pipe.origin}/api/headers`, { headers })).status, 426);

  const deadline = Date.now() + 1000;

  while (!closed && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  socket.terminate();
  assert.equal(closed, true, 'Upgrade остался открыт после incompatible.');

  const result = await reader.read().catch(() => ({ done: true }));

  assert.equal(result.done, true);
});

test('disconnect во время чтения ключа не отправляет поздний HTTP', { timeout: 5000 }, async (t) => {
  const machine = await localMachine(t);
  let release;
  let started;
  const waiting = new Promise((resolve) => {
    started = resolve;
  });
  const key = new Promise((resolve) => {
    release = resolve;
  });
  const upstream = createUpstream({
    address: machine.address,
    windowKey: async () => {
      started();

      return key;
    },
  });
  const pipe = await makePipe(t, upstream);
  const pending = fetch(`${pipe.origin}/api/headers`, { headers: { cookie: COOKIE } });

  await waiting;
  upstream.close();
  release('synthetic-key');
  assert.equal((await pending).status, 503);
  assert.equal(machine.calls.length, 0, 'Закрытый транспорт отправил запрос после чтения ключа.');
});


test('потеря местной сессии обновляется и при auth/state, и при probe hello', async (t) => {
  const machine = await localMachine(t);
  const upstream = createUpstream({ address: machine.address, windowKey: async () => 'synthetic-key' });
  const pipe = await makePipe(t, upstream);
  const headers = { cookie: COOKIE };

  assert.equal((await (await fetch(`${pipe.origin}/api/auth/state`, { headers })).json())
    .authenticated, true);
  machine.expire();
  assert.equal((await (await fetch(`${pipe.origin}/api/auth/state`, { headers })).json())
    .authenticated, true);
  assert.equal(machine.sessions(), 2);
  machine.expire();
  await upstream.probe();
  assert.equal(upstream.state().status, 'online');
  assert.equal(machine.sessions(), 3);
});

test('D1: медленный POST и отмена окном не меняют профиль и соседний SSE',
  { timeout: 20000 }, async (t) => {
    const machine = await localMachine(t);
    const states = [];
    const upstream = createUpstream({
      address: machine.address,
      windowKey: async () => 'synthetic-key',
      onState: (state) => states.push(state.status),
    });
    const pipe = await makePipe(t, upstream);
    const headers = { cookie: COOKIE };

    await upstream.probe();
    assert.equal(upstream.state().status, 'online');

    const events = await fetch(`${pipe.origin}/api/held-events`, { headers });
    const reader = events.body.getReader();

    await reader.read();

    let ended = false;
    const pending = reader.read().then(() => {
      ended = true;
    }, () => {
      ended = true;
    });
    const slow = await fetch(`${pipe.origin}/api/slow-review`, {
      method: 'POST',
      headers,
      body: 'one',
    });

    assert.equal(slow.status, 200);
    assert.deepEqual(await slow.json(), { ok: true });

    const controller = new AbortController();
    const aborted = fetch(`${pipe.origin}/api/slow-review`, { headers, signal: controller.signal })
      .catch(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await aborted;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await fetch(`${pipe.origin}/api/failure-review`, { headers })).status, 500);
    assert.equal(upstream.state().status, 'online');
    assert.equal(states.includes('offline'), false);
    assert.equal(ended, false);
    await reader.cancel();
    await pending;
  });

test('D1: SSE без событий десять секунд не получает таймаут прикладного запроса',
  { timeout: 16000 }, async (t) => {
    const machine = await localMachine(t);
    const upstream = createUpstream({ address: machine.address, windowKey: async () => 'synthetic-key' });
    const pipe = await makePipe(t, upstream);

    await upstream.probe();

    const events = await fetch(`${pipe.origin}/api/held-events`, { headers: { cookie: COOKIE } });
    const reader = events.body.getReader();

    await reader.read();

    let ended = false;
    const pending = reader.read().then(() => {
      ended = true;
    }, () => {
      ended = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 10000));
    assert.equal(ended, false);
    assert.equal(upstream.state().status, 'online');
    await reader.cancel();
    await pending;
  });

test('D1: отмена до заголовков сохраняет состояние и соседний поток', async (t) => {
  const machine = await localMachine(t);
  const upstream = createUpstream({ address: machine.address, windowKey: async () => 'synthetic-key' });
  const pipe = await makePipe(t, upstream);
  const headers = { cookie: COOKIE };

  await upstream.probe();

  const events = await fetch(`${pipe.origin}/api/held-events`, { headers });
  const reader = events.body.getReader();

  await reader.read();

  let ended = false;
  const pending = reader.read().then(() => {
      ended = true;
    }, () => {
      ended = true;
    });
  const controller = new AbortController();
  const aborted = fetch(`${pipe.origin}/api/slow-review`, { headers, signal: controller.signal })
    .catch(() => undefined);

  await new Promise((resolve) => setTimeout(resolve, 100));
  controller.abort();
  await aborted;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(upstream.state().status, 'online');
  assert.equal(ended, false);
  await reader.cancel();
  await pending;
});

test('D1: поздний 401 прежней сессии не создаёт второй обмен ключа', async (t) => {
  let exchanges = 0;
  let rejected = 0;
  let releaseLate;
  const lateReady = new Promise((resolve) => releaseLate = resolve);
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-GrigDesk-Api', '0.1');

    if (request.url === '/api/auth/window-session') {
      exchanges += 1;
      response.setHeader('Set-Cookie', `grigdesk_sid=session${exchanges}; HttpOnly`);
      response.end('{}');
    } else if (request.url === '/api/initial') {
      response.end('{}');
    } else if (request.headers.cookie === 'grigdesk_sid=session1') {
      rejected += 1;

      if (request.url === '/api/late401') {
        await lateReady;
      } else {
        while (rejected < 2) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }

      response.writeHead(401).end('{}');
    } else {
      response.end('{}');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const upstream = createUpstream({
    address: `http://127.0.0.1:${server.address().port}`,
    windowKey: async () => 'synthetic-key',
  });
  const pipe = await makePipe(t, upstream);
  const headers = { cookie: COOKIE };

  t.after(async () => {
    releaseLate();
    upstream.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await (await fetch(`${pipe.origin}/api/initial`, { headers })).text();

  const late = fetch(`${pipe.origin}/api/late401`, { headers });
  const early = await fetch(`${pipe.origin}/api/early401`, { headers });

  assert.equal(early.status, 200);
  await early.text();
  releaseLate();

  const restored = await late;

  assert.equal(restored.status, 200);
  await restored.text();
  assert.equal(exchanges, 2, 'Один обмен при старте и один общий при потере сессии.');
});


test('R2: один медленный hello сохраняет online и SSE, три отказа подряд дают offline',
  { timeout: 12000 }, async (t) => {
    const machine = await localMachine(t);
    const upstream = createUpstream({ address: machine.address, windowKey: async () => 'synthetic-key' });
    const pipe = await makePipe(t, upstream);

    t.after(() => upstream.close());
    await upstream.probe();

    const events = await fetch(`${pipe.origin}/api/held-events`, { headers: { cookie: COOKIE } });
    const reader = events.body.getReader();

    await reader.read();
    machine.hello(4000);
    await upstream.probe();
    assert.equal(upstream.state().status, 'online');

    const alive = reader.read().then(() => 'closed', () => 'closed');

    assert.equal(await Promise.race([alive, new Promise((resolve) =>
      setTimeout(() => resolve('alive'), 100))]), 'alive');
    machine.hello(0);
    await upstream.probe();
    machine.hello(0, true);

    for (const expected of ['online', 'online', 'offline']) {
      await upstream.probe();
      assert.equal(upstream.state().status, expected);
    }

    await reader.cancel();
  });

test('труба передаёт корреляцию и время до заголовков без ожидания конца SSE', async (t) => {
  let release = () => {};
  const server = http.createServer((req, res) => {
    res.setHeader('X-GrigDesk-Api', '0.1');

    if (req.url === '/api/auth/window-session') {
      res.setHeader('set-cookie', 'grigdesk_sid=fixture-session');
      res.end('{}');

      return;
    }
    if (req.url === '/api/plain') {
      res.setHeader('Server-Timing', 'db;dur=2');
      res.end('{}');

      return;
    }

    res.setHeader('Server-Timing', 'db;dur=2, grigdesk;dur=10.0');
    res.setHeader('X-GrigDesk-Request', 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: first\n\n');
    release = () => res.end('data: second\n\n');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    release();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const upstream = createUpstream({
    address: `http://127.0.0.1:${server.address().port}`,
    windowKey: async () => 'fixture-key',
  });
  const pipe = await makePipe(t, upstream);
  const headers = { cookie: COOKIE };
  const response = await fetch(`${pipe.origin}/api/timed`, {
    headers, signal: AbortSignal.timeout(5000),
  });

  assert.match(response.headers.get('server-timing'), /grigdesk;dur=10\.0/u);
  assert.match(response.headers.get('server-timing'), /grigdesk_pipe;dur=\d+(?:\.\d+)?/u);
  assert.equal(response.headers.get('x-grigdesk-request'), 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');

  const reader = response.body.getReader();
  const first = await reader.read();

  assert.match(new TextDecoder().decode(first.value), /data: first/u);
  release();

  while (!(await reader.read()).done) {
    // Дочитываем остаток, не удерживая тело и не оставляя активный сокет фикстуры.
  }

  const plain = await fetch(`${pipe.origin}/api/plain`, { headers });

  assert.equal(plain.headers.get('server-timing'), 'db;dur=2');
  assert.deepEqual(await plain.json(), {});
});
