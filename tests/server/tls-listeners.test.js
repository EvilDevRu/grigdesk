// Область действия HTTP-сокета, когда рядом поднят HTTPS.
//
// Цена ошибки здесь несимметрична и велика в обе стороны: пустишь лишнее — данные (чаты, дифы,
// PTY-шелл) ходят по локалке открытым текстом; закроешь лишнее — кокпит недоступен из сети,
// а корень нечем установить, потому что качается он именно по http.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

import { LocalTls, decideHttpRequest, isPrivateAddress } from '../../server/src/lib/tls/local.js';
import { startHttpsListener } from '../../server/src/lib/tls/https-listener.js';
import { loadTlsSource } from '../../server/src/lib/tls/source.js';
import httpScopePlugin, { redirectHost } from '../../server/src/plugins/http-scope.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const websocketPlugin = requireFromServer('@fastify/websocket');
const WebSocket = requireFromServer('ws');

test('TLS-SCOPE-01: решение по запросу на http-сокете', () => {
  const lan = { remoteAddress: '192.168.50.20', routeUrl: '/api/tasks', httpsUp: true };

  // https не поднялся — всё работает как раньше, иначе кокпит пропадает из сети целиком.
  assert.equal(decideHttpRequest({ ...lan, httpsUp: false }), 'pass');

  // Внутренняя шина: MCP разрешений чата, bin/b24, bin/restart, vite, туннель шлюза.
  for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(decideHttpRequest({ ...lan, remoteAddress: addr }), 'pass');
  }

  // Из сети — только корень и QR к нему.
  assert.equal(decideHttpRequest({ ...lan, routeUrl: '/api/settings/tls/ca.crt' }), 'pass');
  assert.equal(decideHttpRequest({ ...lan, routeUrl: '/api/settings/tls/ca.svg' }), 'pass');

  // Всё остальное — на https.
  assert.equal(decideHttpRequest(lan), 'redirect');
  assert.equal(decideHttpRequest({ ...lan, routeUrl: '/api/chat/store' }), 'redirect');

  // Вебсокет по открытому http из сети — это шелл открытым текстом. Рвём.
  assert.equal(decideHttpRequest({ ...lan, routeUrl: '/api/terminal', upgrade: true }), 'drop');
  // Но с loopback терминал обязан работать: на нём же сидит dev-прокси vite.
  assert.equal(
    decideHttpRequest({ ...lan, remoteAddress: '127.0.0.1', routeUrl: '/api/terminal', upgrade: true }),
    'pass',
  );
});

test('TLS-SCOPE-02: приватность адреса и хост редиректа', () => {
  for (const addr of ['10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.50.10', '127.0.0.1', '::1', 'fd00::1']) {
    assert.equal(isPrivateAddress(addr), true, addr);
  }
  for (const addr of ['8.8.8.8', '172.32.0.1', '203.0.113.9', '2a00:1450::1', '', null]) {
    assert.equal(isPrivateAddress(addr), false, String(addr));
  }

  assert.equal(redirectHost('192.168.50.10:8140'), '192.168.50.10');
  assert.equal(redirectHost('cockpit.local'), 'cockpit.local');
  assert.equal(redirectHost('[fd00::1]:8140'), '[fd00::1]');
  // Заголовок Host приходит от клиента: мусор в Location превращает редирект в чужой сайт.
  assert.equal(redirectHost('evil.com/\\@real'), '');
  assert.equal(redirectHost(''), '');
});

test('TLS-SCOPE-03: хук редиректит из сети и пропускает с loopback', async (t) => {
  const tlsRuntime = { up: true, port: 8143, httpPort: 8140 };
  const app = Fastify();
  t.after(() => app.close());
  await app.register(httpScopePlugin, { tlsRuntime });
  app.get('/api/tasks', async () => ({ ok: true }));
  app.get('/api/settings/tls/ca.crt', async () => 'PEM');

  const fromLan = await app.inject({
    method: 'GET',
    url: '/api/tasks?a=1',
    remoteAddress: '192.168.50.20',
    headers: { host: '192.168.50.10:8140' },
  });
  assert.equal(fromLan.statusCode, 301);
  assert.equal(fromLan.headers.location, 'https://192.168.50.10:8143/api/tasks?a=1');

  const local = await app.inject({
    method: 'GET',
    url: '/api/tasks',
    remoteAddress: '127.0.0.1',
    headers: { host: 'localhost:8140' },
  });
  assert.equal(local.statusCode, 200);

  const ca = await app.inject({
    method: 'GET',
    url: '/api/settings/tls/ca.crt',
    remoteAddress: '192.168.50.20',
    headers: { host: '192.168.50.10:8140' },
  });
  assert.equal(ca.statusCode, 200, 'корень обязан отдаваться по http из сети — иначе его нечем поставить');

  // Пока https не поднялся, из сети должно работать всё: это единственный способ починиться.
  tlsRuntime.up = false;
  const degraded = await app.inject({
    method: 'GET',
    url: '/api/tasks',
    remoteAddress: '192.168.50.20',
    headers: { host: '192.168.50.10:8140' },
  });
  assert.equal(degraded.statusCode, 200);
});

test('TLS-SCOPE-04: второй сокет несёт тот же роутер и тот же вебсокет', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-tls.'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const localTls = new LocalTls({
    dir: path.join(root, 'state', 'tls'),
    caDir: path.join(root, 'ca'),
  });
  await localTls.generate({ addresses: ['192.168.50.10'] });
  const pair = localTls.load();
  const ca = localTls.caCertificate().pem;

  const app = Fastify();
  t.after(() => app.close());
  // Плагин вебсокета вешает СВОЙ upgrade на app.server при регистрации; ради него и написан
  // перенос слушателей — без него терминал по wss:// молча не подключается.
  await app.register(websocketPlugin, {});
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/terminal', { websocket: true }, (socket) => {
    socket.on('message', (raw) => socket.send(`эхо:${raw}`));
  });
  await app.listen({ port: 0, host: '127.0.0.1' });

  const started = await startHttpsListener({
    app, key: pair.key, cert: pair.cert, port: 0, host: '127.0.0.1',
  });
  assert.equal(started.ok, true, started.error);
  t.after(() => new Promise((resolve) => started.server.close(resolve)));

  // Сертификат выписан на IP, поэтому подключаемся по localhost c явным servername:
  // адрес машины в тест зашивать нельзя, а `DNS:localhost` в SAN есть всегда.
  const tlsOpts = { ca, servername: 'localhost' };

  const body = await new Promise((resolve, reject) => {
    const req = https.request(
      { host: 'localhost', port: started.port, path: '/api/health', ...tlsOpts },
      (r) => {
        let out = '';
        r.on('data', (c) => { out += c; });
        r.on('end', () => resolve({ status: r.statusCode, out }));
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(body.status, 200);
  assert.deepEqual(JSON.parse(body.out), { ok: true });

  const echo = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://localhost:${started.port}/api/terminal`, tlsOpts);
    ws.on('error', reject);
    ws.on('open', () => ws.send('привет'));
    ws.on('message', (data) => { resolve(String(data)); ws.close(); });
  });
  assert.equal(echo, 'эхо:привет', 'wss:// обязан работать — иначе терминал доступен только по http');
});

test('TLS-SCOPE-05: занятый порт не роняет процесс — http остаётся', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-tls.'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const localTls = new LocalTls({
    dir: path.join(root, 'state', 'tls'),
    caDir: path.join(root, 'ca'),
  });
  await localTls.generate({ addresses: ['192.168.50.10'] });
  const pair = localTls.load();

  // Кто-то уже сидит на этом порту (соседний экземпляр, недобитый прошлый процесс).
  const squatter = Fastify();
  t.after(() => squatter.close());
  await squatter.listen({ port: 0, host: '127.0.0.1' });
  const taken = squatter.server.address().port;

  const app = Fastify();
  t.after(() => app.close());
  app.get('/api/health', async () => ({ ok: true }));
  await app.listen({ port: 0, host: '127.0.0.1' });

  const started = await startHttpsListener({
    app, key: pair.key, cert: pair.cert, port: taken, host: '127.0.0.1',
  });
  // Не исключение: под Restart=always падение здесь — вечный крэш-луп, устроенный кнопкой
  // в браузере, а чинить его можно только с консоли мозга.
  assert.equal(started.ok, false);
  assert.match(started.error, /EADDRINUSE/);

  const alive = await app.inject({ method: 'GET', url: '/api/health', remoteAddress: '127.0.0.1' });
  assert.equal(alive.statusCode, 200, 'http обязан пережить неудачу https');
});

test('TLS-SRC-01: тумблер режима решает, поднимать ли https', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-tls-src-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const localTls = new LocalTls({
    dir: path.join(root, 'state', 'tls'),
    caDir: path.join(root, 'ca'),
  });
  await localTls.generate({ addresses: ['192.168.50.10'] });

  // Режим включён — берём выпущенное из «Настроек».
  const on = loadTlsSource({ keyPath: '', certPath: '', modeEnabled: true, localTls });
  assert.equal(on.source, 'state');
  assert.ok(on.key && on.cert);

  // Режим выключен — сокета нет, хотя сертификат на диске лежит и годен. Это и есть смысл
  // тумблера: спрятать настройки мало, режим должен реально не работать.
  const off = loadTlsSource({ keyPath: '', certPath: '', modeEnabled: false, localTls });
  assert.equal(off.source, 'none');
  assert.equal(off.key, undefined);
  // Не ошибка, а осознанный выбор человека: в лог ругаться не на что.
  assert.equal(off.error, '');

  // И ничего не стёрли — обратное включение не требует ни выпуска, ни установки корня заново.
  assert.equal(localTls.load().ok, true);
});

test('TLS-SRC-02: сертификат из окружения тумблером не гасится', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-tls-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'state', 'tls');
  const localTls = new LocalTls({ dir, caDir: path.join(root, 'ca') });
  await localTls.generate({ addresses: ['192.168.50.10'] });

  // COCKPIT_TLS_KEY/CERT — настройка машины, а не режим в UI: галка в браузере её не отменяет.
  const env = loadTlsSource({
    keyPath: path.join(dir, 'key.pem'),
    certPath: path.join(dir, 'cert.pem'),
    modeEnabled: false,
    localTls,
  });
  assert.equal(env.source, 'env');
  assert.ok(env.key && env.cert);
  assert.match(env.fingerprint, /^[0-9A-F]{2}(:[0-9A-F]{2})+$/);

  // Битые пути в env — явное намерение оператора, молча игнорировать нельзя.
  assert.throws(
    () => loadTlsSource({
      keyPath: path.join(dir, 'key.pem'),
      certPath: path.join(root, 'нет-такого.crt'),
      modeEnabled: true,
      localTls,
    }),
    /COCKPIT_TLS_KEY/,
  );

  // Неполная env-пара не должна тихо проваливаться в локальный сертификат или http.
  assert.throws(
    () => loadTlsSource({
      keyPath: path.join(dir, 'key.pem'),
      certPath: '',
      modeEnabled: true,
      localTls,
    }),
    /должны быть заданы вместе/,
  );
  assert.throws(
    () => loadTlsSource({
      keyPath: '',
      certPath: path.join(dir, 'cert.pem'),
      modeEnabled: true,
      localTls,
    }),
    /должны быть заданы вместе/,
  );
});
