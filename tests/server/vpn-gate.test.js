import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import systemModule from '../../server/src/modules/system/index.ts';
import { VpnGateInputError, VpnGateService } from '../../server/src/lib/vpnGate.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

// Своя временную папку на тест: настоящий машинный .env не читается и не пишется.
async function tempEnv(t, initial = '') {
  const dir = await mkdtemp(path.join(tmpdir(), 'grigdesk-vpn-gate-'));
  const envPath = path.join(dir, '.env');

  if (initial) {
    await writeFile(envPath, initial, 'utf8');
  }
  t.after(() => rm(dir, { recursive: true, force: true }));

  return envPath;
}

function service(envPath, env = {}) {
  return new VpnGateService({ envPath, env });
}

test('read: без .env ворота выключены и совпадают с пустым окружением', async (t) => {
  const envPath = await tempEnv(t);
  const view = await service(envPath).read();

  assert.deepEqual(view, {
    requireVpn: false,
    iface: '',
    probe: '',
    defaults: { probe: '1.1.1.1' },
    restartRequired: false,
    active: { requireVpn: false, iface: '', probe: '' },
  });
});

test('read: сохранённая конфигурация отличается от действующей — нужен перезапуск', async (t) => {
  const envPath = await tempEnv(t, [
    'GRIGDESK_REQUIRE_VPN=1',
    'GRIGDESK_VPN_IFACE=wg0',
    'GRIGDESK_VPN_PROBE=8.8.8.8',
    '',
  ].join('\n'));
  // Процесс стартовал без ворот и с другим интерфейсом.
  const view = await service(envPath, { GRIGDESK_VPN_IFACE: 'singbox_tun' }).read();

  assert.equal(view.requireVpn, true);
  assert.equal(view.iface, 'wg0');
  assert.equal(view.probe, '8.8.8.8');
  assert.equal(view.restartRequired, true);
  assert.deepEqual(view.active, { requireVpn: false, iface: 'singbox_tun', probe: '' });
});

test('read: совпадающая конфигурация не требует перезапуска', async (t) => {
  const envPath = await tempEnv(t, 'GRIGDESK_REQUIRE_VPN=1\nGRIGDESK_VPN_IFACE=wg0\n');
  const view = await service(envPath, {
    GRIGDESK_REQUIRE_VPN: '1',
    GRIGDESK_VPN_IFACE: 'wg0',
  }).read();

  assert.equal(view.restartRequired, false);
});

test('write: создаёт явные ключи и удаляет пустые interface/probe', async (t) => {
  const envPath = await tempEnv(t, '# Комментарий человека\nGRIGDESK_VPN_IFACE=old0\n\n');

  const view = await service(envPath).write({ requireVpn: true, iface: 'wg0', probe: '' });

  assert.equal(view.requireVpn, true);
  assert.equal(view.iface, 'wg0');
  assert.equal(view.probe, '');
  const text = await readFile(envPath, 'utf8');

  assert.match(text, /# Комментарий человека/);
  assert.match(text, /^GRIGDESK_REQUIRE_VPN=1$/m);
  assert.match(text, /^GRIGDESK_VPN_IFACE=wg0$/m);
  assert.doesNotMatch(text, /old0/);
  assert.doesNotMatch(text, /GRIGDESK_VPN_PROBE/);
});

test('write: недопустимые interface и probe отклоняются своим кодом', async (t) => {
  const envPath = await tempEnv(t);
  const vpnGate = service(envPath);

  await assert.rejects(
    vpnGate.write({ requireVpn: false, iface: 'bad iface', probe: '' }),
    (error) => error instanceof VpnGateInputError && error.code === 'vpn_gate_iface_invalid',
  );
  await assert.rejects(
    vpnGate.write({ requireVpn: false, iface: '', probe: '1.1.1.1;rm' }),
    (error) => error instanceof VpnGateInputError && error.code === 'vpn_gate_probe_invalid',
  );

  const text = await readFile(envPath, 'utf8').catch(() => '');

  assert.equal(text, '', 'отказ проверки не создаёт файл');
});

// Приложение с настоящим сервисом на временной папке: маршрут проверяет весь путь
// от схемы тела до файла, без подмены самого сервиса. Ключи ворот убираются из
// окружения тест-раннера, чтобы «действующие» значения были предсказуемыми.
async function build(t, envPath) {
  const saved = ['GRIGDESK_REQUIRE_VPN', 'GRIGDESK_VPN_IFACE', 'GRIGDESK_VPN_PROBE']
    .map((key) => [key, process.env[key]]);

  for (const [key] of saved) {
    delete process.env[key];
  }
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  const app = Fastify({ logger: false });

  t.after(() => app.close());
  await app.register(systemModule, {
    system: { read: () => ({}) },
    config: { rootDir: '/tmp/noop', grigDeskUpdateStatePath: '/tmp/noop-state', envPath },
    releases: { async getStatus() { return {}; }, start() {}, stop() {} },
    updates: { async getJob() { return null; }, async assertIdle() {} },
    launcher: { async readState() { throw new Error('не используется'); } },
  });

  return app;
}

test('GET /api/system/vpn-gate отдаёт вид настроек ворот', async (t) => {
  const envPath = await tempEnv(t, 'GRIGDESK_REQUIRE_VPN=1\n');
  const app = await build(t, envPath);

  const response = await app.inject('/api/system/vpn-gate');
  const view = response.json();

  assert.equal(response.statusCode, 200);
  assert.equal(view.requireVpn, true);
  assert.equal(view.defaults.probe, '1.1.1.1');
  assert.equal(view.restartRequired, true);
});

test('PUT /api/system/vpn-gate пишет конфигурацию и возвращает вид', async (t) => {
  const envPath = await tempEnv(t);
  const app = await build(t, envPath);

  const ok = await app.inject({
    method: 'PUT',
    url: '/api/system/vpn-gate',
    payload: { requireVpn: true, iface: 'wg0', probe: '8.8.8.8' },
  });

  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().requireVpn, true);
  assert.equal(ok.json().restartRequired, true);

  const file = await readFile(envPath, 'utf8');

  assert.match(file, /^GRIGDESK_REQUIRE_VPN=1$/m);
  assert.match(file, /^GRIGDESK_VPN_IFACE=wg0$/m);
  assert.match(file, /^GRIGDESK_VPN_PROBE=8\.8\.8\.8$/m);
});

test('PUT отклоняет чужие поля, отсутствие флага и плохие значения', async (t) => {
  const envPath = await tempEnv(t);
  const app = await build(t, envPath);

  const cases = [
    { requireVpn: 'yes' },
    { iface: 'wg0' },
    { requireVpn: true, extra: 1 },
    { requireVpn: true, iface: 'bad name' },
    { requireVpn: true, probe: '1.1.1.1 x' },
  ];

  for (const payload of cases) {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/system/vpn-gate',
      payload,
    });

    assert.equal(response.statusCode, 400, JSON.stringify(payload));
  }

  const missing = await readFile(envPath, 'utf8').catch(() => '');

  assert.equal(missing, '', 'отказ схемы не создаёт файл');
});
