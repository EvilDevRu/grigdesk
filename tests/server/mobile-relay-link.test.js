import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import tls from 'node:tls';

import { nextDelay, normalizeRelayIp, RelayLink } from '../../server/src/lib/mobile/relayLink.ts';
import { dialRelay } from '../../server/src/lib/mobile/transport.ts';
import { connect, hello, makeCert, relayFixture, temporary } from '../relay/helpers.js';

/**
 * Ждёт наблюдаемое состояние вместо фиксированной задержки сети.
 * Дедлайн ограничивает ошибку теста и не оставляет reconnect в фоне.
 */
async function waitFor(predicate) {
  const deadline = Date.now() + 3000;

  while (!predicate()) {
    assert.equal(Date.now() < deadline, true, 'состояние не достигнуто');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('MB-15/MB-16: backoff и точная классификация IPv4, IPv6, mapped', () => {
  assert.deepEqual(
    Array.from({ length: 7 }, (_, attempt) => nextDelay(attempt, () => 0.5)),
    [1000, 2000, 4000, 8000, 16000, 30000, 30000],
  );

  for (const ip of ['127.0.0.1', '10.1.2.3', '172.31.2.3', '192.168.1.2', '::1', 'fd00::1']) {
    assert.equal(normalizeRelayIp(ip).private, true);
  }

  assert.deepEqual(normalizeRelayIp('::ffff:7f00:1'), {
    ip: '127.0.0.1',
    private: true,
  });
  assert.equal(normalizeRelayIp('0:0:0:0:0:0:0:1').private, true);
  assert.equal(normalizeRelayIp('203.0.113.1').private, false);
  assert.throws(() => normalizeRelayIp('fe80::1%eth0'));
  assert.throws(() => normalizeRelayIp('224.0.0.1'));
});

test('MB-14/MB-16: отказ VPN исключает connect, несовпадающий пин исключает hello', async (t) => {
  const blocked = new RelayLink({
    relay: {
      id: 'r12345678',
      host: '203.0.113.1',
      port: 443,
      fp: 'a'.repeat(64),
      brainToken: 'secret',
    },
    vpnGate: async () => false,
  });

  t.after(() => blocked.stop());
  blocked.start();
  await waitFor(() => blocked.status().state === 'waiting_vpn');
  assert.equal(blocked.status().pipes, 0);

  const cert = await makeCert(await temporary(t), 'pin');
  let bytes = 0;
  const remote = tls.createServer(
    {
      key: cert.keyPem,
      cert: cert.certPem,
    },
    (socket) => {
      socket.on('data', (chunk) => {
        bytes += chunk.length;
      });
      socket.on('error', () => {});
    },
  );

  await new Promise((resolve) => remote.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => remote.close(resolve)));
  await assert.rejects(() =>
    dialRelay({
      ip: '127.0.0.1',
      port: remote.address().port,
      fp: 'a'.repeat(64),
    }),
  );
  assert.equal(bytes, 0);
});

test('MB-17: incoming без target не открывает локальный порт, client-v2 идёт в clientTarget', async (t) => {
  const directory = await temporary(t);
  const cert = await makeCert(directory, 'relay');
  const { port } = await relayFixture(t, cert);

  let v1Hits = 0;
  const trap = net.createServer(() => {
    v1Hits += 1;
  });

  await new Promise((resolve) => trap.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => trap.close(resolve)));

  let clientHits = 0;
  const target = net.createServer(() => {
    clientHits += 1;
  });

  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => target.close(resolve)));

  const link = new RelayLink({
    relay: {
      id: 'r12345678',
      host: '127.0.0.1',
      port,
      fp: cert.fp,
      brainToken: 'brain-token',
    },
    mobilePort: trap.address().port,
    clientTarget: async () => target.address().port,
    vpnGate: async () => true,
  });

  t.after(() => link.stop());
  link.start();
  await waitFor(() => link.status().state === 'online');
  assert.equal(link.status().compatibility, 'supported');

  // Устройство v1 (без target): hello пишем без ожидания ACK — после правки мозг
  // не открывает пару и посредник не отвечает устройству до BrainTimeout.
  const oldDevice = await connect(port, cert.fp);
  const legacyHello = {
    v: 1,
    role: 'device',
    token: 'device-token',
  };

  t.after(() => oldDevice.destroy());
  oldDevice.write(`${JSON.stringify(legacyHello)}\n`);

  // Детерминированно ждём: на базе ловушка получает соединение быстро; после правки
  // соединения нет — выжидаем дедлайн и проверяем отсутствие.
  const deadline = Date.now() + 3000;

  while (v1Hits === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.equal(v1Hits, 0);

  // Устройство нового клиента (target client): соединение доходит до clientTarget.
  const newDevice = await connect(port, cert.fp);

  t.after(() => newDevice.destroy());
  await hello(newDevice, {
    v: 2,
    target: 'client',
    role: 'device',
    token: 'device-token',
  });
  await waitFor(() => clientHits >= 1);
  assert.equal(v1Hits, 0);
});
