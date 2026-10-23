import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { privateWrite } from '../../server/src/lib/mobile/files.ts';
import { clientRequest } from './helpers/clientAccess.js';
import { phoneAdmin, phoneFixture } from './helpers/phoneAccess.js';
import { freePort } from './helpers/pluginBootFixture.js';
import { heldRequest } from './helpers/phoneSockets.js';
/**
 * Включение запрашивает конкретный IPv4 выбранной сети, как пользовательский диалог.
 * Случайный порт исключает зависимость от установленных служб и номера из .env.example.
 */
async function enable(f, port) {
  return phoneAdmin(f, 'PUT', '/api/devices/access/direct', {
    enabled: true,
    addresses: [{ host: f.host, port }],
  });
}
/**
 * Доступность подтверждает реальный pinned TLS, а не только административный снимок.
 * Клиент пока не привязан и должен получить ограниченный bootstrap hello.
 */
async function hello(f, port) {
  const result = await clientRequest({ ...f, port }, '/api/client/hello');

  assert.equal(result.status, 200);
  assert.equal(result.body.fp, f.identity.fp);
  assert.equal(result.body.device, null);
}
/**
 * Закрытый вход проверяется отдельным TCP-соединением с ограниченным ожиданием.
 * Случайный listener этого теста не должен оставаться доступным после отката.
 */
async function assertClosed(host, port) {
  const socket = net.connect({ host, port });

  socket.setTimeout(1000, () => socket.destroy(new Error('connect_timeout')));

  const result = await new Promise((resolve) => {
    socket.once('connect', () => resolve('open'));
    socket.once('error', () => resolve('closed'));
  });

  socket.destroy();
  assert.equal(result, 'closed', `${host}:${port} остался открыт`);
}

test('PHONE-02: включение без рестарта HTTP сохраняется', async (t) => {
  const directory = await mkdtemp(path.join(
    process.env.GRIGDESK_TEST_ARTIFACTS_DIR || tmpdir(), 'phone-durable-'));

  t.after(() => rm(directory, { recursive: true, force: true }));

  const f = await phoneFixture(t, { directory });
  const initial = await phoneAdmin(f, 'GET', '/api/devices/access');

  assert.equal(initial.statusCode, 200, initial.body);
  assert.equal(initial.json().source, 'off');
  await assert.rejects(readFile(path.join(directory, 'phone-access.json')), { code: 'ENOENT' });

  const httpAddress = f.app.server.address();
  const port = await freePort();
  const result = await enable(f, port);

  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(f.app.server.address(), httpAddress);
  assert.equal(httpAddress.address, '127.0.0.1');
  await hello(f, port);

  const saved = await readFile(path.join(directory, 'phone-access.json'), 'utf8');

  assert.equal(JSON.parse(saved).version, 1);
  assert.ok(saved.includes(f.host));
  assert.ok(saved.includes(String(port)));
  assert.equal((await phoneAdmin(f, 'GET', '/api/devices/access')).json().source, 'saved');
  await f.listener.close();
  await f.app.close();

  const envPort = await freePort();
  const restored = await phoneFixture(t, {
    directory,
    env: { GRIGDESK_CLIENT_LISTEN: `127.0.0.1:${envPort}` },
  });

  await hello(restored, port);
  await assertClosed('127.0.0.1', envPort);
  assert.equal((await phoneAdmin(restored, 'GET', '/api/devices/access')).json().source, 'saved');
});
test('PHONE-03: отказ нового bind сохраняет прежний доступ', async (t) => {
  const f = await phoneFixture(t);
  const port = await freePort();
  const enabled = await enable(f, port);

  assert.equal(enabled.statusCode, 200, enabled.body);

  const file = path.join(f.directory, 'phone-access.json');
  const saved = await readFile(file, 'utf8');
  const occupied = net.createServer();

  occupied.listen(0, f.host);
  await once(occupied, 'listening');
  t.after(() => new Promise((resolve) => occupied.close(resolve)));

  const stagedPort = await freePort();
  const denied = await phoneAdmin(f, 'PUT', '/api/devices/access/direct', {
    enabled: true,
    addresses: [{ host: f.host, port: stagedPort }, { host: f.host, port: occupied.address().port }],
  });

  assert.ok(denied.statusCode >= 400, denied.body);
  assert.equal(await readFile(file, 'utf8'), saved);
  await hello(f, port);
  await assertClosed(f.host, stagedPort);
  assert.equal((await phoneAdmin(f, 'GET', '/api/devices')).statusCode, 200);
  assert.equal(f.app.server.address().address, '127.0.0.1');
});
test('PHONE-04: адреса выбранного сервера и неоднозначность', async (t) => {
  const f = await phoneFixture(t, { name: 'Удалённый сервер' });
  const status = await phoneAdmin(f, 'GET', '/api/devices/access', undefined, {
    cookie: f.cookie,
    host: 'browser-on-another-pc.example',
    'x-forwarded-host': 'browser-on-another-pc.example',
  });

  assert.equal(status.statusCode, 200, status.body);
  assert.ok(status.body.includes('Удалённый сервер'));
  assert.ok(status.body.includes(f.host));
  assert.equal(status.body.includes('browser-on-another-pc.example'), false);

  for (const host of ['127.0.0.1', '0.0.0.0', 'localhost', 'phone.localhost', '224.0.0.1']) {
    const result = await phoneAdmin(f, 'POST', '/api/devices/phone-pairing', {
      direct: [{ host, port: 443 }],
    });

    assert.ok(result.statusCode >= 400 && result.statusCode < 500, result.body);
    assert.equal(result.json().text, undefined);
  }
});
test('PHONE-04: повреждённая настройка не открывает вход и не переписывается', async (t) => {
  const directory = await mkdtemp(path.join(
    process.env.GRIGDESK_TEST_ARTIFACTS_DIR || tmpdir(), 'phone-corrupt-'));
  const file = path.join(directory, 'phone-access.json');
  const corrupt = '{"version":1,"direct":';

  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(file, corrupt);

  const f = await phoneFixture(t, { directory });
  const response = await phoneAdmin(f, 'GET', '/api/devices/access');

  assert.equal(response.statusCode, 200, response.body);
  assert.match(response.body, /error|corrupt/);
  assert.equal(await readFile(file, 'utf8'), corrupt);
  assert.equal((await phoneAdmin(f, 'POST', '/api/devices/phone-pairing', {})).statusCode, 409);
});
test('PHONE-R3: параллельные настройки direct согласуют файл и runtime', {
  timeout: 15000,
}, async (t) => {
  let release;
  let entered;
  let blocked = false;
  let rejectWrite = false;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const pause = new Promise((resolve) => {
    release = resolve;
  });
  const f = await phoneFixture(t, {
    dependencies: {
      /**
       * Задерживает durable commit первой операции до поступления второй.
       * Отказ записи инъецируется без изменения прав реальных файлов машины.
       */
      async writeConfig(file, contents) {
        if (rejectWrite) {
          throw new Error('Синтетический отказ durable writer');
        }
        if (blocked) {
          blocked = false;
          entered();
          await pause;
        }

        return privateWrite(file, contents);
      },
    },
  });
  const initialPort = await freePort();
  const initial = await enable(f, initialPort);

  assert.equal(initial.statusCode, 200, initial.body);

  const firstPort = await freePort();
  const secondPort = await freePort();

  blocked = true;

  const first = enable(f, firstPort);

  await started;

  const second = enable(f, secondPort);

  release();
  assert.equal((await first).statusCode, 200);
  assert.equal((await second).statusCode, 200);
  await hello(f, secondPort);
  await assertClosed(f.host, firstPort);
  await assertClosed(f.host, initialPort);

  const file = path.join(f.directory, 'phone-access.json');
  const saved = await readFile(file, 'utf8');
  const status = await phoneAdmin(f, 'GET', '/api/devices/access');

  assert.ok(saved.includes(String(secondPort)));
  assert.ok(status.body.includes(String(secondPort)));
  rejectWrite = true;

  const failedPort = await freePort();
  const failed = await enable(f, failedPort);

  assert.ok(failed.statusCode >= 400, failed.body);
  assert.equal(await readFile(file, 'utf8'), saved);
  await assertClosed(f.host, failedPort);
  await hello(f, secondPort);
  assert.equal((await phoneAdmin(f, 'GET', '/api/devices')).statusCode, 200);
});

test('PHONE-04: несколько сетей требуют выбора, DNS loopback не публикуется', async (t) => {
  const f = await phoneFixture(t, {
    dependencies: {
      networkInterfaces: () => ({
        first: [{
          address: '192.0.2.10',
          family: 'IPv4',
          internal: false
        }],
        second: [{
          address: '192.0.2.20',
          family: 'IPv4',
          internal: false
        }],
      }),
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    },
    env: { GRIGDESK_CLIENT_LISTEN: `0.0.0.0:${await freePort()}` },
  });
  const status = await phoneAdmin(f, 'GET', '/api/devices/access');

  assert.equal(status.statusCode, 200, status.body);
  assert.ok(status.body.includes('192.0.2.10'));
  assert.ok(status.body.includes('192.0.2.20'));

  const noSelection = await phoneAdmin(f, 'POST', '/api/devices/phone-pairing', {});
  const dns = await phoneAdmin(f, 'POST', '/api/devices/phone-pairing', {
    direct: [{ host: 'only-loopback.example', port: 443 }],
  });

  assert.equal(noSelection.statusCode, 409);
  assert.ok(dns.statusCode >= 400 && dns.statusCode < 500);
  assert.equal(dns.json().text, undefined);
});


test('PHONE-09: общие бюджеты 24 cert и 16 bootstrap действуют на разных direct входах', {
  timeout: 15000,
}, async (t) => {
  const f = await phoneFixture(t);
  const first = await freePort();
  const second = await freePort();
  const enabled = await phoneAdmin(f, 'PUT', '/api/devices/access/direct', {
    enabled: true,
    addresses: [{ host: f.host, port: first }, { host: f.host, port: second }],
  });

  assert.equal(enabled.statusCode, 200, enabled.body);

  const device = await f.devices.add({
    name: 'Телефон',
    fp: f.client.fp,
    scope: 'client'
  });
  const connected = [];

  for (let index = 0; index < 25; index += 1) {
    const request = await heldRequest(t, f, index % 2 ? first : second, f.client);

    assert.equal(request.status, index < 24 ? 200 : 403);
    connected.push(request.socket);
  }

  for (let index = 0; index < 17; index += 1) {
    const request = await heldRequest(t, f, index % 2 ? first : second, f.stranger, '/api/client/hello');

    assert.equal(request.status, index < 16 ? 200 : 403);
  }

  const closed = connected.slice(0, 24).map((socket) => once(socket, 'close'));

  assert.equal((await phoneAdmin(f, 'POST', `/api/devices/${device.id}/revoke`)).statusCode, 200);
  await Promise.all(closed);
  assert.equal((await clientRequest({ ...f, port: first }, '/api/private')).status, 403);
});
