import ssePlugin from '../../server/src/plugins/sse.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { Writable } from 'node:stream';

import { installHttpDiagnostics } from '../../server/src/lib/httpDiagnostics.ts';

const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireServer('fastify');
const websocket = requireServer('@fastify/websocket');

test('Server-Timing измеряет сервер и следует общему уровню логирования', async (t) => {
  let clock = 0;
  const app = Fastify({ logger: { level: 'debug' } });

  t.mock.method(performance, 'now', () => clock);
  t.after(() => app.close());
  installHttpDiagnostics(app);
  app.get('/api/probe', async (_request, reply) => {
    clock += 42;
    reply.header('server-timing', 'db;dur=2');

    return { ok: true };
  });

  const first = await app.inject('/api/probe?private=secret');

  assert.equal(first.headers['server-timing'], 'db;dur=2, grigdesk;dur=42.0');
  assert.deepEqual(first.json(), { ok: true });
  app.log.level = 'info';

  const disabled = await app.inject('/api/probe');

  assert.equal(disabled.headers['server-timing'], 'db;dur=2');
  app.log.level = 'debug';

  const resumed = await app.inject('/api/probe');

  assert.equal(resumed.headers['server-timing'], 'db;dur=2, grigdesk;dur=42.0');
});

test('HTTP диагностика связывает этапы, не доверяет request-id и отключается', async (t) => {
  let clock = 0;
  const entries = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      entries.push(JSON.parse(String(chunk)));
      callback();
    },
  });
  const app = Fastify({ logger: { level: 'debug', stream } });

  t.mock.method(performance, 'now', () => clock);
  t.after(() => app.close());
  installHttpDiagnostics(app);
  app.addHook('preHandler', async () => {
    clock += 5;
  });
  app.get('/api/probe/:id', async () => {
    clock += 40;

    return { ok: true };
  });

  const response = await app.inject({
    url: '/api/probe/private?token=secret',
    headers: { 'x-grigdesk-request': 'attacker-value' },
  });
  const token = response.headers['x-grigdesk-request'];
  const entry = entries.find((item) => item.event === 'server.http');

  assert.match(token, /^[a-f0-9-]{36}$/u);
  assert.notEqual(token, 'attacker-value');
  assert.equal(entry.serverRequest, token);
  assert.equal(entry.path, '/api/probe/:id');
  assert.equal(entry.ms, 45);
  assert.equal(entry.status, 200);
  assert.equal(response.headers['server-timing'], 'grigdesk;dur=45.0');
  assert.deepEqual(response.json(), { ok: true });
  assert.doesNotMatch(JSON.stringify(entry), /private|secret|attacker/u);
  app.log.level = 'info';

  const disabled = await app.inject('/api/probe/private');

  assert.equal(disabled.headers['x-grigdesk-request'], undefined);
  assert.equal(disabled.headers['server-timing'], undefined);
});

test('незавершённый HTTP оставляет pending, reset не возрождает старое поколение', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const entries = [];
  const app = Fastify({ logger: { level: 'debug', stream: new Writable({
    write(chunk, _encoding, done) {
      entries.push(JSON.parse(String(chunk)));
      done();
    },
  }) } });
  const diagnostics = installHttpDiagnostics(app);
  let release;
  let entered;
  const started = new Promise((resolve) => entered = resolve);

  t.after(() => app.close());
  app.get('/api/held', async () => {
    entered();

    return new Promise((resolve) => release = resolve);
  });

  const pending = app.inject('/api/held');

  await started;
  t.mock.timers.tick(9000);
  assert.equal(entries.filter((item) => item.event === 'server.pending').length, 1);
  diagnostics.reset();
  release({ ok: true });

  const response = await pending;

  assert.equal(response.headers['x-grigdesk-request'], undefined);
  assert.equal(entries.filter((item) => item.event === 'server.http').length, 0);
});

test('настоящий Fastify SSE и raw headers имеют метаданные и не остаются pending', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'http-diag-sse-'));
  const entries = [];
  const app = Fastify({ logger: { level: 'debug', stream: new Writable({
    write(chunk, _encoding, done) {
      entries.push(JSON.parse(String(chunk)));
      done();
    },
  }) } });

  installHttpDiagnostics(app);
  await app.register(ssePlugin, { stateDir: dir });
  app.get('/api/raw', (_request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, 'OK', ['Server-Timing', 'db;dur=2', 'X-Probe', 'kept']);
    reply.raw.end('raw');
  });
  await app.listen({ port: 0, host: '127.0.0.1' });

  const abort = new AbortController();

  t.after(async () => {
    abort.abort();
    app.server.closeAllConnections();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const stream = await fetch(`${origin}/api/events`, { signal: abort.signal });

  assert.match(stream.headers.get('x-grigdesk-request'), /^[a-f0-9-]{36}$/u);
  assert.match(stream.headers.get('server-timing'), /grigdesk;dur=/u);

  const reader = stream.body.getReader();
  const hello = await reader.read();

  assert.match(new TextDecoder().decode(hello.value), /event: hello/u);
  t.mock.timers.tick(3100);
  assert.equal(entries.filter((row) => row.event === 'server.pending').length, 0);

  const raw = await fetch(`${origin}/api/raw`);

  assert.equal(await raw.text(), 'raw');
  assert.equal(raw.headers.get('x-probe'), 'kept');
  assert.match(raw.headers.get('server-timing'), /db;dur=2, grigdesk;dur=/u);
  assert.match(raw.headers.get('x-grigdesk-request'), /^[a-f0-9-]{36}$/u);
  abort.abort();
});

test('WebSocket снимает HTTP pending после handshake и сохраняет отказ авторизации', async (t) => {
  const rows = [];
  const app = Fastify({ logger: { level: 'debug', stream: new Writable({
    write(chunk, _encoding, done) {
      rows.push(JSON.parse(String(chunk)));
      done();
    },
  }) } });

  installHttpDiagnostics(app);
  await app.register(websocket);
  app.get('/api/socket', {
    websocket: true,
    preValidation: async (request, reply) => {
      if (request.headers['x-fixture-access'] !== 'yes') {
        return reply.code(401).send({ error: 'unauthorized' });
      }
    },
  }, (socket) => {
    socket.on('message', (message) => socket.send(message));
  });
  await app.ready();
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const socket = await app.injectWS('/api/socket', { headers: { 'x-fixture-access': 'yes' } });

  t.after(async () => {
    socket.terminate();
    await app.close();
  });

  const reply = once(socket, 'message');

  socket.send('probe');
  assert.equal((await reply)[0].toString(), 'probe');
  t.mock.timers.tick(3100);
  assert.equal(rows.filter((row) => row.event === 'server.pending').length, 0);
  assert.equal(rows.filter((row) => row.event === 'server.upgrade').length, 1);
  await assert.rejects(app.injectWS('/api/socket'), /401/u);
  assert.ok(rows.some((row) => row.event === 'server.http' && row.status === 401));
});
