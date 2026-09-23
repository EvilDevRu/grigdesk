import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import systemModule from '../../server/src/modules/system/index.ts';
import { LauncherError } from '../../server/src/lib/launcher.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

const AUTOSTART = { unit: 'enabled', active: true, linger: true, mode: 'boot' };
const SHORTCUT = { desktopDir: '/home/test/Desktop', desktop: false, menu: false };

// Модуль с подменённым лаунчером: systemctl и файлы ярлыка в тесте не трогаются.
async function build(t, launcher) {
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  await app.register(systemModule, {
    system: { read: () => ({}) },
    config: { rootDir: '/tmp/noop', cockpitUpdateStatePath: '/tmp/noop-state' },
    releases: { async getStatus() { return {}; }, start() {}, stop() {} },
    updates: { async getJob() { return null; }, async assertIdle() {} },
    launcher,
  });
  return app;
}

test('GET /api/system/launcher отдаёт состояние автозапуска и ярлыка', async (t) => {
  const app = await build(t, {
    async readState() { return { autostart: AUTOSTART, shortcut: SHORTCUT }; },
  });

  const response = await app.inject('/api/system/launcher');

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { autostart: AUTOSTART, shortcut: SHORTCUT });
});

test('PUT autostart принимает только boolean enabled и возвращает новое состояние', async (t) => {
  const calls = [];
  const app = await build(t, {
    async setAutostart(enabled) {
      calls.push(enabled);
      return { ...AUTOSTART, unit: enabled ? 'enabled' : 'disabled' };
    },
  });

  const ok = await app.inject({
    method: 'PUT', url: '/api/system/launcher/autostart', payload: { enabled: false },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().autostart.unit, 'disabled');
  assert.deepEqual(calls, [false]);

  const bad = await app.inject({
    method: 'PUT', url: '/api/system/launcher/autostart', payload: { enabled: 'yes' },
  });
  assert.equal(bad.statusCode, 400);
  const extra = await app.inject({
    method: 'PUT', url: '/api/system/launcher/autostart', payload: { enabled: true, unit: 'other.service' },
  });
  assert.equal(extra.statusCode, 400, 'имя юнита снаружи не принимается');
  assert.deepEqual(calls, [false]);
});

test('отказ лаунчера уходит своим статусом и кодом, чужая ошибка — 500', async (t) => {
  const app = await build(t, {
    async setAutostart() { throw new LauncherError('unit_missing', 'Юнит не установлен.', 409); },
    async installShortcut() { throw new Error('внезапно'); },
  });

  const missing = await app.inject({
    method: 'PUT', url: '/api/system/launcher/autostart', payload: { enabled: true },
  });
  assert.equal(missing.statusCode, 409);
  assert.equal(missing.json().error, 'unit_missing');

  const crash = await app.inject({ method: 'POST', url: '/api/system/launcher/shortcut' });
  assert.equal(crash.statusCode, 500);
});

test('POST и DELETE shortcut создают и убирают ярлык', async (t) => {
  const calls = [];
  const app = await build(t, {
    async installShortcut() { calls.push('install'); return { ...SHORTCUT, desktop: true, menu: true }; },
    async removeShortcut() { calls.push('remove'); return SHORTCUT; },
  });

  const created = await app.inject({ method: 'POST', url: '/api/system/launcher/shortcut' });
  assert.equal(created.statusCode, 200);
  assert.equal(created.json().shortcut.desktop, true);

  const removed = await app.inject({ method: 'DELETE', url: '/api/system/launcher/shortcut' });
  assert.equal(removed.statusCode, 200);
  assert.equal(removed.json().shortcut.desktop, false);
  assert.deepEqual(calls, ['install', 'remove']);
});
