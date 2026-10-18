import assert from 'node:assert/strict';
import net from 'node:net';

import { createMobileSeed } from '../../helpers/mobileSeed.mjs';
import { createRelayServer } from '../../../relay/src/relayServer.ts';
import { readConfig } from '../../../relay/src/config.ts';

/**
 * Порт выделяется в loopback до выдачи административного QR, реальное состояние не читается.
 * Контрольная TLS-связь поднимается обычным RelayHub из изолированного MobileService.
 */
export async function localStack(t) {
  const seed = await createMobileSeed(t);
  const reservation = net.createServer();

  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));

  const port = reservation.address().port;

  await new Promise((resolve) => reservation.close(resolve));

  const admin = async (method, url, payload) =>
    seed.core.inject({
      method,
      url,
      payload,
      headers: { 'x-grigdesk-internal': 'test' },
    });
  const added = await admin('POST', '/api/mobile/relays', {
    name: 'Локальный тестовый посредник',
    host: '127.0.0.1',
    port,
  });

  assert.equal(added.statusCode, 200, added.body);

  const relayInfo = added.json().relay;
  const env = await admin('GET', '/api/mobile/relays/' + relayInfo.id + '/env');
  const values = Object.fromEntries(
    env.body
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const position = line.indexOf('=');

        return [line.slice(0, position), line.slice(position + 1)];
      }),
  );
  const config = {
    ...readConfig(values),
    port,
  };
  const relay = createRelayServer(config, { log: () => {} });

  await relay.listen('127.0.0.1');
  t.after(() => relay.close());

  const deadline = Date.now() + 5000;

  while ((await seed.service.status()).relays[0].link.state !== 'online') {
    assert.equal(Date.now() < deadline, true, 'Мозг не подключился к тестовому посреднику');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const qr = await admin('POST', '/api/mobile/relays/' + relayInfo.id + '/qr', { pair: true });

  assert.equal(qr.statusCode, 200, qr.body);

  return {
    ...seed,
    relay,
    relayInfo,
    relayConfig: config,
    qr: qr.json().text,
    admin,
  };
}
