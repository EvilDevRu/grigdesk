import assert from 'node:assert/strict';
import https from 'node:https';
import test from 'node:test';
import tls from 'node:tls';

import { readConfig } from '../../relay/src/config.ts';
import { createRelayServer } from '../../relay/src/relayServer.ts';
import { ensureBrainIdentity } from '../../server/src/lib/mobile/identity.ts';
import { startMobileServer } from '../../server/src/lib/mobile/mobileServer.ts';
import { PairingCodes } from '../../server/src/lib/mobile/pairing.ts';
import { nextDelay, normalizeRelayIp, RelayLink } from '../../server/src/lib/mobile/relayLink.ts';
import { DeviceStore } from '../../server/src/lib/mobile/store.ts';
import { dialRelay, relayHello } from '../../server/src/lib/mobile/transport.ts';
import { makeCert, relayEnv, temporary } from '../relay/helpers.js';

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

test('MB-13: внешний TLS → посредник → внутренний TLS → мобильный hello', async (t) => {
  const directory = await temporary(t);
  const cert = await makeCert(directory, 'relay');
  const relay = createRelayServer(
    {
      ...readConfig(relayEnv({ cert })),
      port: 0,
    },
    { log: () => {} },
  );
  const port = await relay.listen('127.0.0.1');

  t.after(() => relay.close());

  const identity = await ensureBrainIdentity(directory);
  const devices = new DeviceStore(directory);
  const mobile = await startMobileServer({
    identity,
    directory,
    deviceStore: devices,
    pairing: new PairingCodes({ devices }),
    port: 0,
  });

  t.after(() => mobile.close());

  let gates = 0;
  const link = new RelayLink({
    relay: {
      id: 'r12345678',
      host: '127.0.0.1',
      port,
      fp: cert.fp,
      brainToken: 'brain-token',
    },
    mobilePort: mobile.port,
    vpnGate: async () => {
      gates += 1;

      return true;
    },
  });

  t.after(() => link.stop());
  link.start();
  await waitFor(() => link.status().state === 'online');

  const outer = await dialRelay({
    ip: '127.0.0.1',
    port,
    fp: cert.fp,
  });

  await relayHello(outer, {
    v: 1,
    role: 'device',
    token: 'device-token',
  });

  const inner = tls.connect({
    socket: outer,
    rejectUnauthorized: false,
    minVersion: 'TLSv1.3',
  });

  await new Promise((resolve, reject) => {
    inner.once('secureConnect', resolve);
    inner.once('error', reject);
  });
  assert.equal(
    inner.getPeerX509Certificate().fingerprint256.replaceAll(':', '').toLowerCase(),
    identity.fp,
  );

  const agent = new https.Agent();

  agent.createConnection = () => inner;

  const answer = await new Promise((resolve, reject) => {
    const request = https.get(
      {
        host: '127.0.0.1',
        path: '/api/mobile/v1/hello',
        agent,
      },
      (response) => {
        let text = '';

        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () => resolve(JSON.parse(text)));
      },
    );

    request.once('error', reject);
  });

  agent.destroy();
  outer.destroy();
  assert.equal(answer.api, 1);
  assert.equal(gates, 0);
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
    mobilePort: 1,
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
