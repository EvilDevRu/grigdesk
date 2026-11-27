import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import authPlugin from '../../server/src/plugins/auth.ts';
import mobileModule from '../../server/src/modules/mobile/index.ts';
import { MobileService } from '../../server/src/lib/mobile/service.ts';
import { temporary } from '../relay/helpers.js';

const Fastify = createRequire(new URL('../../server/package.json', import.meta.url))('fastify');

/**
 * Защищённые настройки работают с настоящими закрытыми хранилищами.
 * Только сеть заменена, чтобы проверка не подключалась к чужим посредникам.
 */
async function admin(t, corrupt = false) {
  const directory = await temporary(t);
  const disconnected = [];
  const events = [];

  if (corrupt) {
    await writeFile(path.join(directory, 'relays.json'), 'повреждённый JSON');
  }

  const service = new MobileService({
    directory,
    vpnGate: async () => false,
    makeHub: () => ({
      sync() {},
      close() {},
      status: () => [],
    }),
    disconnectClient: (fp) => disconnected.push(fp),
    changed: () => events.push('mobile-changed'),
  });
  const app = Fastify({ logger: false });

  await app.register(authPlugin, {
    authStore: {
      isConfigured: () => true,
      isValidSession: (id) => id === 'test-session',
    },
  });
  await app.register(mobileModule, { service });
  await service.start();
  t.after(async () => {
    await service.close();
    await app.close();
  });

  const call = (method, url, payload, authenticated = true) =>
    app.inject({
      method,
      url,
      payload,
      headers: authenticated ? { cookie: 'grigdesk_sid=test-session' } : {},
    });

  return {
    call,
    service,
    disconnected,
    events,
  };
}

test('MB-18…MB-22, MB-31: настройки закрыты, env защищён, QR удалён, отзыв отключает клиент', async (t) => {
  const { call, service, disconnected, events } = await admin(t);

  for (const [method, url] of [
    ['GET', '/api/mobile/status'],
    ['POST', '/api/mobile/relays'],
    ['GET', '/api/mobile/relays/r12345678/env'],
    ['DELETE', '/api/mobile/relays/r12345678'],
    ['POST', '/api/mobile/devices/d12345678/revoke'],
  ]) {
    assert.equal((await call(method, url, {}, false)).statusCode, 401);
  }

  const added = await call('POST', '/api/mobile/relays', {
    name: 'Дом',
    host: '127.0.0.1',
    port: 443,
  });

  assert.equal(added.statusCode, 200);

  const { relay } = added.json();
  const stored = (await service.relays.list())[0];
  const status = await call('GET', '/api/mobile/status');

  assert.equal(status.statusCode, 200);
  assert.equal(status.json().server.up, undefined);
  assert.equal(status.json().server.port, undefined);
  assert.equal(status.json().devices, undefined);
  assert.match(status.json().server.fp, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(status.json()).includes(stored.brainToken), false);
  assert.equal(JSON.stringify(status.json()).includes(stored.deviceToken), false);

  const env = await call('GET', `/api/mobile/relays/${relay.id}/env`);

  assert.equal(env.statusCode, 200);
  assert.match(env.headers['content-disposition'], /relay\.env/);
  assert.equal(env.headers['cache-control'], 'no-store');
  assert.equal(env.body.includes(stored.deviceToken), false);

  const qr = await call('POST', `/api/mobile/relays/${relay.id}/qr`, { pair: true });

  assert.equal(qr.statusCode, 404);

  const device = await service.devices.add({
    name: 'Телефон',
    fp: 'a'.repeat(64),
    scope: 'client',
  });

  assert.equal((await call('POST', `/api/mobile/devices/${device.id}/revoke`)).statusCode, 200);
  assert.deepEqual(disconnected, [device.fp]);
  assert.equal((await service.devices.findByFp(device.fp)).revokedAt !== null, true);
  assert.equal((await call('DELETE', `/api/mobile/relays/${relay.id}`)).statusCode, 200);
  assert.ok(events.length >= 3);
});

test('MB-31: повреждённые настройки посредников видны в статусе', async (t) => {
  const { call } = await admin(t, true);
  const status = await call('GET', '/api/mobile/status');

  assert.equal(status.statusCode, 200);
  assert.equal(typeof status.json().server.error, 'string');
  assert.equal((await call('POST', '/api/mobile/relays', {})).statusCode, 503);
});
