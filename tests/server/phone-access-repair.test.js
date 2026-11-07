import assert from 'node:assert/strict';
import { once } from 'node:events';
import https from 'node:https';
import net from 'node:net';
import test from 'node:test';
import { readConfig } from '../../relay/src/config.ts';
import { parseHello } from '../../relay/src/protocol.ts';
import { createRelayServer } from '../../relay/src/relayServer.ts';
import { MobileService } from '../../server/src/lib/mobile/service.ts';
import { clientFailureText, connectionDetailText } from '../../shared/client/clientShell.ts';
import { connect, hello, makeCert, relayEnv, temporary } from '../relay/helpers.js';
import { clientRequest } from './helpers/clientAccess.js';
import { issuePhone, phoneAdmin, phoneFixture } from './helpers/phoneAccess.js';
import { configuredRelay, relayRequest } from './helpers/phoneRelay.js';
import { heldRequest } from './helpers/phoneSockets.js';
import { freePort } from './helpers/pluginBootFixture.js';

/**
 * Прямой доступ включён на конкретном адресе синтетической сети и случайном порту.
 * Сценарии ниже закрепляют исправления, найденные при приёмке задачи.
 */
async function ready(t, options = {}) {
  const f = await phoneFixture(t, options);
  const port = await freePort();
  const result = await phoneAdmin(f, 'PUT', '/api/devices/access/direct', {
    enabled: true,
    addresses: [{ host: f.host, port }],
  });

  assert.equal(result.statusCode, 200, result.body);

  return { ...f, port };
}

function decode(text) {
  return JSON.parse(Buffer.from(text.split(':').at(-1), 'base64url'));
}

/**
 * Проверка, принимает ли адрес TCP-соединение, без отправки данных.
 * Используется, чтобы отличить действующий wildcard-вход от закрытого.
 */
function accepts(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });

    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

test('PHONE-R1: pair закрывает bootstrap-соединение, hello приходит новым и аутентифицирован', async (t) => {
  const f = await ready(t);
  const issued = f.pairing.issuePhone();
  const agent = new https.Agent({
    keepAlive: true,
    key: f.client.keyPem,
    cert: f.client.certPem,
    rejectUnauthorized: false,
    maxSockets: 1,
  });

  t.after(() => agent.destroy());

  /**
   * Keep-alive агент с одним сокетом воспроизводит пул телефона: без Connection: close
   * hello ушёл бы тем же непривязанным соединением и получил device:null.
   */
  const ask = (path, body) => new Promise((resolve, reject) => {
    const request = https.request({
      host: f.host,
      port: f.port,
      path,
      agent,
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : {},
    }, (response) => {
      let data = '';

      response.on('data', (chunk) => {
        data += chunk;
      });
      response.on('end', () => resolve({
        body: JSON.parse(data),
        headers: response.headers,
        socket: request.socket,
      }));
    });

    request.on('error', reject);
    request.end(body ? JSON.stringify(body) : undefined);
  });
  const pair = await ask('/api/client/pair', { code: issued.code });
  const confirmed = await ask('/api/client/hello');

  assert.equal(pair.headers.connection, 'close');
  assert.notEqual(pair.socket, confirmed.socket);
  assert.equal(confirmed.body.device?.id, pair.body.device.id);
  assert.equal(f.pairing.phoneProgress(issued.attemptId).status, 'connected');
});

test('PHONE-R2: relay до возвращения control отвечает временным brain_offline', async (t) => {
  const cert = await makeCert(await temporary(t), 'relay');
  const relay = createRelayServer({ ...readConfig(relayEnv({ cert })), port: 0 }, { log: () => {} });
  const port = await relay.listen('127.0.0.1');

  t.after(() => relay.close());

  const device = await connect(port, cert.fp);

  t.after(() => device.destroy());
  assert.deepEqual(await hello(device, {
    v: 2,
    target: 'client',
    role: 'device',
    token: 'device-token',
  }), { ok: false, error: 'brain_offline' });

  const control = await connect(port, cert.fp);

  t.after(() => control.destroy());
  assert.equal((await hello(control, {
    v: 1,
    role: 'brain-control',
    token: 'brain-token',
    capabilities: ['client-v2'],
  })).ok, true);
});

for (const capabilities of [{ includes: 'client-v2' }, [1], null]) {
  test(`PHONE-R2: capabilities ${JSON.stringify(capabilities)} отклонены до смены control`, () => {
    assert.throws(() => parseHello(JSON.stringify({
      v: 1,
      role: 'brain-control',
      token: 'brain-token',
      capabilities,
    })), /bad_hello/);
  });
}

for (const host of ['RELAY.Example', '2001:db8::1']) {
  test(`PHONE-R3: ретранслятор ${host} не ломает direct QR`, async (t) => {
    const f = await ready(t);
    const record = await f.mobile.relays.add({
      name: 'Ретранслятор',
      host,
      port: 443,
    });
    const link = {
      compatibility: 'supported',
      state: 'online',
      lastError: null,
    };

    f.mobile.status = async () => ({ relays: [{ ...record, link }] });

    const response = await phoneAdmin(f, 'POST', '/api/devices/phone-pairing', {});

    assert.equal(response.statusCode, 200, response.body);

    const payload = decode(response.json().text);

    if (host.includes(':')) {
      const status = (await phoneAdmin(f, 'GET', '/api/devices/access')).json();

      assert.equal(payload.relay, undefined);
      assert.equal(response.json().includedRelayId, null);
      assert.equal(status.relays[0].phoneError, 'unsupported_address');
    } else {
      assert.equal(payload.relay.host, 'relay.example');
    }
  });
}

test('PHONE-R4: отказ старого входа виден, повторный start без второго hub', async (t) => {
  const directory = await temporary(t);
  const logs = [];
  let hubs = 0;
  const mobile = new MobileService({
    directory,
    port: 0,
    log: (event) => logs.push(event),
    makeServer: async () => {
      throw new Error('EADDRINUSE');
    },
    makeHub: () => {
      hubs += 1;

      return {
        sync() {},
        status() {
          return [];
        },
        close() {},
      };
    },
  });

  mobile.setClientTarget(async () => 12345);
  t.after(() => mobile.close());
  await mobile.start();
  await mobile.start();

  const status = await mobile.status();

  assert.equal(status.server.up, false);
  assert.match(status.server.error ?? '', /Прежний мобильный вход недоступен/);
  assert.ok(logs.includes('mobile_v1_start_failed'));
  assert.equal(hubs, 1);
});

test('PHONE-R5: неудачная сборка QR не оставляет действующий код', async (t) => {
  const f = await ready(t);
  const long = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}`;
  const direct = Array.from({ length: 8 }, (_, index) => ({
    host: `${index}.${long}.example`,
    port: f.port,
  }));
  const before = f.pairing.codes.size;
  const response = await phoneAdmin(f, 'POST', '/api/devices/phone-pairing', { direct });

  assert.equal(response.json().error, 'qr_too_large');
  assert.equal(f.pairing.codes.size, before);
});

test('PHONE-R5: ручной DNS-адрес не зависит от регистра', async (t) => {
  const f = await ready(t);
  const response = await phoneAdmin(f, 'POST', '/api/devices/phone-pairing', {
    direct: [{ host: 'Desk.Example', port: f.port }],
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(decode(response.json().text).direct[0].host, 'desk.example');
});

test('PHONE-R5: настроенный ретранслятор виден до подключения hub и не годен для QR', async (t) => {
  const f = await ready(t);
  const relay = await f.mobile.relays.add({
    name: 'Ожидающий ретранслятор',
    host: 'relay.example',
    port: 443,
  });
  const status = (await phoneAdmin(f, 'GET', '/api/devices/access')).json();

  assert.equal(status.relays.length, 1);
  assert.equal(status.relays[0].id, relay.id);
  assert.equal(status.relays[0].link.compatibility, 'unknown');
  assert.equal(status.relays[0].phoneEligible, false);
});

test('PHONE-R6: коды пути телефона имеют собственный текст RU/EN', () => {
  for (const locale of ['ru', 'en']) {
    assert.match(clientFailureText('device_unknown', locale), /QR/);
    assert.equal(connectionDetailText({ code: 'device_unknown' }, locale),
      clientFailureText('device_unknown', locale));

    for (const code of ['relay_pin_mismatch', 'relay_unauthorized', 'relay_upgrade_required']) {
      assert.notEqual(clientFailureText(code, locale), clientFailureText('offline', locale), code);
      assert.equal(connectionDetailText({ code }, locale), clientFailureText(code, locale));
    }
  }
});

test('PHONE-R7: выключение закрывает действующий direct, relay продолжает API', async (t) => {
  const f = await ready(t);
  const relay = await configuredRelay(t, f);
  const issued = (await phoneAdmin(f, 'POST', '/api/devices/phone-pairing', {})).json();

  const paired = await clientRequest(f, '/api/client/pair', { code: decode(issued.text).pair.code });

  assert.equal(paired.status, 200);

  const held = await heldRequest(t, f, f.port, f.client);
  const closed = once(held.socket, 'close');

  assert.equal(held.status, 200);

  const disabled = await phoneAdmin(f, 'PUT', '/api/devices/access/direct', { enabled: false });

  assert.equal(disabled.statusCode, 200);
  await Promise.race([closed, new Promise((_, reject) => {
    setTimeout(() => reject(new Error('direct не закрыт')), 1500).unref();
  })]);
  assert.equal((await relayRequest(f, relay, '/api/private')).status, 200);
  assert.equal((await phoneAdmin(f, 'GET', '/api/devices/access')).json().direct.state, 'disabled');
});

test('PHONE-R8: сужение входа «все сети» до одной сети на том же порту не даёт «Порт занят»', async (t) => {
  const port = await freePort();
  const f = await phoneFixture(t, { env: { GRIGDESK_CLIENT_LISTEN: `0.0.0.0:${port}` } });

  assert.equal(await accepts('127.0.0.1', port), true, 'wildcard из окружения слушает loopback');

  const result = await phoneAdmin(f, 'PUT', '/api/devices/access/direct', {
    enabled: true,
    addresses: [{ host: f.host, port }],
  });

  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(result.json().direct.addresses, [{ host: f.host, port }]);
  assert.equal(await accepts(f.host, port), true);
  assert.equal(await accepts('127.0.0.1', port), false, 'wildcard закрыт после сужения');
  assert.deepEqual((await issuePhone(f)).payload.direct, [{ host: f.host, port }]);
});

test('PHONE-R8: отказ записи после освобождения wildcard возвращает прежний вход', async (t) => {
  const port = await freePort();
  const f = await phoneFixture(t, {
    env: { GRIGDESK_CLIENT_LISTEN: `0.0.0.0:${port}` },
    dependencies: {
      writeConfig: async () => {
        throw new Error('disk_full');
      },
    },
  });
  const result = await phoneAdmin(f, 'PUT', '/api/devices/access/direct', {
    enabled: true,
    addresses: [{ host: f.host, port }],
  });
  const status = (await phoneAdmin(f, 'GET', '/api/devices/access')).json();

  assert.equal(result.statusCode, 503, result.body);
  assert.equal(await accepts('127.0.0.1', port), true, 'wildcard восстановлен');
  assert.equal(status.source, 'env');
  assert.equal(status.direct.state, 'online');
});

test('PHONE-R8: сохранённая настройка важнее GRIGDESK_CLIENT_ADDRESS окружения', async (t) => {
  const envPort = await freePort();
  const f = await ready(t, {
    env: {
      GRIGDESK_CLIENT_LISTEN: `0.0.0.0:${envPort}`,
      GRIGDESK_CLIENT_ADDRESS: `env.example:${envPort}`,
    },
  });
  const issued = await issuePhone(f);

  assert.deepEqual(issued.payload.direct, [{ host: f.host, port: f.port }]);
});
