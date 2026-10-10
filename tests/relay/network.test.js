import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import test from 'node:test';
import { promisify } from 'node:util';

import { readConfig } from '../../relay/src/config.ts';
import { createRelayServer } from '../../relay/src/relayServer.ts';
import { connect, hello, makeCert, readLine, relayEnv, temporary } from './helpers.js';

const execute = promisify(execFile);

/**
 * Изолированный TLS relay слушает только loopback и имеет свои синтетические ключи.
 * Таймауты короткие, а cleanup всегда закрывает принадлежащие тесту соединения.
 */
async function networkFixture(t, overrides = {}) {
  const cert = await makeCert(await temporary(t), 'relay-network');
  const server = createRelayServer(
    {
      ...readConfig(
        relayEnv({
          cert,
          overrides,
        }),
      ),
      port: 0,
    },
    { log: () => {} },
  );
  const port = await server.listen('127.0.0.1');

  t.after(() => server.close());

  return {
    cert,
    server,
    port,
  };
}

/**
 * Дожидается close с ограниченным сроком, не оставляя висящего listener тесту.
 * Resume нужен для доставки TLS close_notify у приостановленного клиента.
 */
async function closed(socket) {
  if (socket.destroyed) {
    return;
  }

  const deadline = AbortSignal.timeout(2500);
  const result = once(socket, 'close', { signal: deadline });

  socket.resume();
  await result;
}

test('RL-26: отдельный healthcheck успешно проверяет TLS и отказывает на закрытом порту', async (t) => {
  const { port } = await networkFixture(t);
  const script = new URL('../../relay/src/healthcheck.ts', import.meta.url).pathname;

  await execute(process.execPath, [script], {
    env: {
      PATH: process.env.PATH,
      RELAY_PORT: String(port),
    },
  });

  const unused = net.createServer();

  await new Promise((resolve) => unused.listen(0, '127.0.0.1', resolve));

  const unavailable = unused.address().port;

  await new Promise((resolve) => unused.close(resolve));
  await assert.rejects(
    () =>
      execute(process.execPath, [script], {
        env: {
          PATH: process.env.PATH,
          RELAY_PORT: String(unavailable),
        },
        timeout: 4000,
      }),
    (error) => error.code === 1,
  );
});

test('RL-16/RL-18: реальные TCP слоты и бан неверного токена ограничивают одну IP', async (t) => {
  const limited = await networkFixture(t, {
    RELAY_MAX_PER_IP: '2',
    RELAY_HELLO_TIMEOUT_MS: '1000',
  });
  const raw = [net.connect(limited.port, '127.0.0.1'), net.connect(limited.port, '127.0.0.1')];

  for (const socket of raw) {
    socket.on('error', () => {});
    t.after(() => socket.destroy());
  }

  await Promise.all(raw.map((socket) => once(socket, 'connect')));

  const third = net.connect(limited.port, '127.0.0.1');

  third.on('error', () => {});
  await closed(third);
  assert.equal(
    raw.every((socket) => !socket.destroyed),
    true,
  );
  raw.forEach((socket) => socket.destroy());

  const banned = await networkFixture(t, {
    RELAY_BAN_THRESHOLD: '2',
    RELAY_BAN_WINDOW_MS: '100',
  });

  for (let index = 0; index < 2; index += 1) {
    const socket = await connect(banned.port, banned.cert.fp);

    assert.deepEqual(
      await hello(socket, {
        v: 1,
        role: 'device',
        token: 'неверный',
      }),
      {
        ok: false,
        error: 'unauthorized',
      },
    );
    await closed(socket);
  }

  const blocked = await connect(banned.port, banned.cert.fp);

  assert.deepEqual(
    await hello(blocked, {
      v: 1,
      role: 'health',
    }),
    {
      ok: false,
      error: 'banned',
    },
  );
  await closed(blocked);
  await new Promise((resolve) => setTimeout(resolve, 130));

  const healthy = await connect(banned.port, banned.cert.fp);

  assert.deepEqual(
    await hello(healthy, {
      v: 1,
      role: 'health',
    }),
    { ok: true },
  );
  healthy.destroy();
});

test('RL-28: фрагментированный control, замена pending и запрет байтов до helloReply', async (t) => {
  const { port, cert } = await networkFixture(t, { RELAY_PING_MS: '5000' });
  const control = await connect(port, cert.fp);

  await hello(control, {
    v: 1,
    role: 'brain-control',
    token: 'brain-token',
  });

  const pong = readLine(control);

  for (const part of ['{"t":', '"ping"}', '\n']) {
    control.write(part);
  }

  assert.equal(JSON.parse(await pong).t, 'pong');

  const incoming = readLine(control);
  const device = await connect(port, cert.fp);
  const waiting = hello(device, {
    v: 1,
    role: 'device',
    token: 'device-token',
  });
  const oldId = JSON.parse(await incoming).id;
  const replacement = await connect(port, cert.fp);

  await hello(replacement, {
    v: 1,
    role: 'brain-control',
    token: 'brain-token',
  });
  assert.equal((await waiting).ok, false);

  const stale = await connect(port, cert.fp);

  assert.deepEqual(
    await hello(stale, {
      v: 1,
      role: 'brain-data',
      token: 'brain-token',
      id: oldId,
    }),
    {
      ok: false,
      error: 'unknown_id',
    },
  );

  const early = await connect(port, cert.fp);
  const refusal = readLine(early);

  early.write('{"v":1,"role":"health"}\nлишние байты');
  assert.deepEqual(JSON.parse(await refusal), {
    ok: false,
    error: 'bad_hello',
  });
  [control, replacement, device, stale, early].forEach((socket) => socket.destroy());
});
