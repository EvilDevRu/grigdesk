import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import net from 'node:net';
import test from 'node:test';

import { readConfig } from '../../relay/src/config.ts';
import { createRelayServer } from '../../relay/src/relayServer.ts';
import { createIpLimiter } from '../../relay/src/limits.ts';
import { connect, hello, makeCert, readLine, relayEnv, temporary } from './helpers.js';

/**
 * Запускает посредника на свободном loopback-порту с короткими таймаутами.
 * Все соединения и таймеры теста закрываются через after.
 */
async function fixture(t, overrides = {}) {
  const cert = await makeCert(await temporary(t), 'relay');
  const config = readConfig(
    relayEnv({
      cert,
      overrides,
    }),
  );
  const logs = [];
  const server = createRelayServer(
    {
      ...config,
      port: 0,
    },
    { log: (event) => logs.push(event) },
  );
  const port = await server.listen('127.0.0.1');

  t.after(() => server.close());

  return {
    port,
    cert,
    logs,
    server,
  };
}

test('RL-07…RL-10/RL-13: health, неверные hello, токены и отсутствие мозга', async (t) => {
  const { port, cert } = await fixture(t);

  for (const [request, expected] of [
    [
      {
        v: 1,
        role: 'health',
      },
      { ok: true },
    ],
    [
      {
        v: 1,
        role: 'brain-control',
        token: 'wrong',
      },
      {
        ok: false,
        error: 'unauthorized',
      },
    ],
    [
      {
        v: 1,
        role: 'device',
        token: 'device-token',
      },
      {
        ok: false,
        error: 'brain_offline',
      },
    ],
    [
      {
        v: 1,
        role: 'brain-data',
        token: 'brain-token',
        id: 'a'.repeat(32),
      },
      {
        ok: false,
        error: 'unknown_id',
      },
    ],
    [
      {
        v: 1,
        role: 'other',
      },
      {
        ok: false,
        error: 'bad_role',
      },
    ],
  ]) {
    const socket = await connect(port, cert.fp);

    assert.deepEqual(await hello(socket, request), expected);
    socket.destroy();
  }
});

test('RL-11/RL-23/RL-28: склейка двусторонних байтов, id одноразовый, журнал без секретов', async (t) => {
  const { port, cert, logs } = await fixture(t);
  const control = await connect(port, cert.fp);

  assert.deepEqual(
    await hello(control, {
      v: 1,
      role: 'brain-control',
      token: 'brain-token',
    }),
    { ok: true },
  );

  const incoming = readLine(control);
  const device = await connect(port, cert.fp);
  const deviceReply = hello(device, {
    v: 1,
    role: 'device',
    token: 'device-token',
  });
  const { id } = JSON.parse(await incoming);
  const brain = await connect(port, cert.fp);

  assert.deepEqual(
    await hello(brain, {
      v: 1,
      role: 'brain-data',
      token: 'brain-token',
      id,
    }),
    { ok: true },
  );
  assert.deepEqual(await deviceReply, { ok: true });

  const payload = Buffer.alloc(65536, 123);
  const receive = (socket) =>
    new Promise((resolve) => {
      const chunks = [];
      let length = 0;

      socket.on('data', (chunk) => {
        chunks.push(chunk);
        length += chunk.length;

        if (length === payload.length) {
          resolve(Buffer.concat(chunks));
        }
      });
      socket.resume();
    });
  const brainBytes = receive(brain);

  device.write(payload);
  assert.deepEqual(await brainBytes, payload);

  const deviceBytes = receive(device);

  brain.write(payload);
  assert.deepEqual(await deviceBytes, payload);

  const duplicate = await connect(port, cert.fp);

  assert.deepEqual(
    await hello(duplicate, {
      v: 1,
      role: 'brain-data',
      token: 'brain-token',
      id,
    }),
    {
      ok: false,
      error: 'unknown_id',
    },
  );

  const log = JSON.stringify(logs);

  assert.equal(
    ['brain-token', 'device-token', id, '127.0.0.1'].some((value) => log.includes(value)),
    false,
  );

  const closed = new Promise((resolve) => device.once('close', resolve));

  brain.destroy();
  await closed;
  control.destroy();
  duplicate.destroy();
});

test('RL-12/RL-14/RL-15/RL-17: замена control, ожидания и ping', async (t) => {
  const { port, cert } = await fixture(t, {
    RELAY_BRAIN_TIMEOUT_MS: '100',
    RELAY_MAX_PENDING: '1',
    RELAY_PING_MS: '5000',
  });
  const oldControl = await connect(port, cert.fp);

  await hello(oldControl, {
    v: 1,
    role: 'brain-control',
    token: 'brain-token',
  });

  const oldClosed = new Promise((resolve) => oldControl.once('close', resolve));
  const control = await connect(port, cert.fp);

  await hello(control, {
    v: 1,
    role: 'brain-control',
    token: 'brain-token',
  });
  oldControl.resume();
  await oldClosed;

  const pong = readLine(control);

  control.write('{"t":"ping"}\n');
  assert.equal(JSON.parse(await pong).t, 'pong');

  const incoming = readLine(control);
  const device = await connect(port, cert.fp);
  const waiting = hello(device, {
    v: 1,
    role: 'device',
    token: 'device-token',
  });

  await incoming;

  const extra = await connect(port, cert.fp);

  assert.deepEqual(
    await hello(extra, {
      v: 1,
      role: 'device',
      token: 'device-token',
    }),
    {
      ok: false,
      error: 'busy',
    },
  );
  assert.deepEqual(await waiting, {
    ok: false,
    error: 'brain_timeout',
  });
  device.destroy();
  extra.destroy();
  control.destroy();
});

test('RL-16/RL-19/RL-27: бан, освобождение слотов и ограниченная IP-таблица', () => {
  let now = 0;
  const limiter = createIpLimiter({
    maxPerIp: 2,
    banThreshold: 3,
    banWindowMs: 100,
    now: () => now,
  });
  const first = limiter.acquire('ip');
  const second = limiter.acquire('ip');

  assert.equal(limiter.acquire('ip'), null);
  first.release();
  first.release();
  second.release();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    limiter.failure('ip');
  }

  assert.equal(limiter.banned('ip'), true);
  now = 101;
  limiter.sweep();
  assert.equal(limiter.banned('ip'), false);

  for (let index = 0; index < 5000; index += 1) {
    limiter.failure(`ip-${index}`);
  }

  assert.equal(limiter.size <= 4096, true);
  now = 202;
  limiter.sweep();
  assert.equal(limiter.size, 0);
});

test('RL-08/RL-18/RL-27: TCP без TLS ограничен и освобождается по handshake timeout', async (t) => {
  const { port, cert } = await fixture(t, {
    RELAY_MAX_PER_IP: '1',
    RELAY_HELLO_TIMEOUT_MS: '100',
  });
  const raw = net.connect(port, '127.0.0.1');

  raw.on('error', () => {});
  t.after(() => raw.destroy());
  await new Promise((resolve) => raw.once('connect', resolve));

  const closed = new Promise((resolve) => raw.once('close', resolve));

  await closed;

  const healthy = await connect(port, cert.fp);

  assert.deepEqual(
    await hello(healthy, {
      v: 1,
      role: 'health',
    }),
    { ok: true },
  );
  healthy.destroy();
});
