import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import pluginsModule from '../../server/src/modules/plugins/index.ts';
import authPlugin from '../../server/src/plugins/auth.ts';
import { AuthStore } from '../../server/src/lib/authStore.ts';
import { createPluginRepo } from './helpers/pluginRepo.js';
import { serviceFixture } from './helpers/pluginServiceFixture.js';
import { requireFromServer } from './helpers/pluginInstallHttpFixture.js';

/**
 * Версии отличаются зависимостью ESM, а server.js остаётся байтово одинаковым.
 * onClose моделирует legacy-плагин с ресурсами, но без prepareReplace.
 */
function release(version) {
  return {
    manifest: {
      api: 1,
      contributes: { panels: [{}] },
      entrypoints: { server: 'server.js', web: {
        dir: 'ui',
        entry: 'panel.js',
        background: 'background.js',
        css: ['panel.css'],
        locales: { ru: 'ru.json' },
      } },
    },
    files: {
      'package.json': '{"type":"module"}',
      'value.js': `export const version = ${JSON.stringify(version)};`,
      'server.js': [
        'import { version } from "./value.js";',
        'export default async function plugin(app, options) {',
        '  app.hotProbe.imports.push(version);',
        '  options.lifecycle.busyReason = () => app.hotProbe.busy;',
        '  app.addHook("onClose", async () => app.hotProbe.closed.push(version));',
        '  app.get("/version", async () => ({ version }));',
        '  app.post("/echo", async (request) => ({ body: request.body, auth: request.authKind }));',
        '}',
      ].join('\n'),
      'ui/panel.js': `import { version } from './helper.js'; export default { version };`,
      'ui/helper.js': `export const version = ${JSON.stringify(version)};`,
      'ui/background.js': `export const start = () => ${JSON.stringify(version)};`,
      'ui/panel.css': `/* ${version} */`,
      'ui/ru.json': JSON.stringify({ version }),
    },
  };
}

/**
 * Installer и настоящий auth/loader разделяют только временные каталоги этого теста.
 * Все проверки ниже используют один экземпляр сервера без повторного boot.
 */
async function fixture(t, enabled = true) {
  const repo = await createPluginRepo(t);

  await repo.release('1.0.0', release('1.0.0'));
  await repo.release('1.1.0', release('1.1.0'));

  const f = await serviceFixture(t);
  const { service } = f;

  await service.startInstall({ url: repo.url, version: '1.0.0' });
  await service.whenIdle();

  const ready = await service.currentJob();

  assert.equal((await service.apply(ready.id, ready.reviewToken)).status, 'done');

  const app = requireFromServer('fastify')({ logger: false });
  const authStore = new AuthStore({
    legacyAccountPath: path.join(f.root, 'auth/account.json'),
    sessionsPath: path.join(f.root, 'auth/sessions.json'),
  });
  const probe = {
    imports: [],
    closed: [],
    busy: null,
  };
  let data = { plugins: { demo: enabled } };

  app.decorate('hotProbe', probe);
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('x-fixture-global', 'preserved');
  });
  await app.register(authPlugin, { authStore });
  await app.register(pluginsModule, {
    config: { userPluginsDir: f.pluginsDir, userPluginsDataDir: path.join(f.root, 'data') },
    prefs: {
      read: () => data,
      write: (patch) => {
        data = { ...data, ...patch };
      },
    },
    installs: service,
  });
  await app.ready();
  t.after(() => app.close());

  const headers = { cookie: `grigdesk_sid=${authStore.createSession().id}` };
  const request = (url, payload) => app.inject({
    url,
    headers,
    method: payload === undefined ? 'GET' : 'POST',
    ...(payload === undefined ? {} : { payload }),
  });

  return {
    ...f,
    app,
    probe,
    request,
    toggle: (enabled) => request('/api/plugins/demo/toggle', { enabled }),
    card: async () => (await request('/api/plugins')).json().plugins.find((plugin) => plugin.id === 'demo'),
  };
}

/**
 * Подготовка проходит обычный Git/update путь, без подмены runtime binding.
 * Apply остаётся отдельным явным подтверждением полученного reviewToken.
 */
async function update(f) {
  await f.service.startUpdate('demo', { version: '1.1.0' });
  await f.service.whenIdle();

  const ready = await f.service.currentJob();

  assert.equal(ready.status, 'ready', JSON.stringify(ready.error));

  return ready;
}

test('HOT: legacy update → off/on → rollback, новые ESM зависимости и панель без рестарта', async (t) => {
  const f = await fixture(t);
  const before = await f.card();
  const ready = await update(f);

  assert.equal((await f.request('/api/ext/demo/version')).json().version, '1.0.0');
  assert.equal((await f.request('/api/ext/demo/version')).headers['x-fixture-global'], 'preserved');
  assert.equal((await f.service.apply(ready.id, ready.reviewToken)).status, 'done');
  assert.deepEqual(f.probe.closed, ['1.0.0']);
  assert.deepEqual(f.probe.imports, ['1.0.0', '1.1.0']);
  assert.equal((await f.request('/api/ext/demo/version')).json().version, '1.1.0');

  const after = await f.card();

  assert.equal(after.needsRestart, false);
  assert.equal(after.install.restartRequired, false);
  assert.notEqual(after.entrypoints.web.entry, before.entrypoints.web.entry);
  assert.equal((await f.request(before.entrypoints.web.entry)).statusCode, 404);
  assert.notEqual(after.entrypoints.web.background, before.entrypoints.web.background);
  assert.equal(after.entrypoints.web.background,
    after.entrypoints.web.entry.replace('panel.js', 'background.js'));
  assert.equal((await f.request(before.entrypoints.web.background)).statusCode, 404);
  assert.match((await f.request(after.entrypoints.web.background)).body, /1\.1\.0/u);

  const helper = await f.request(after.entrypoints.web.entry.replace('panel.js', 'helper.js'));

  assert.match(helper.body, /1\.1\.0/u);
  assert.equal((await f.request(after.entrypoints.web.locales.ru)).json().version, '1.1.0');
  assert.deepEqual((await f.request('/api/ext/demo/echo', { value: 'тело' })).json(), {
    body: { value: 'тело' }, auth: 'session',
  });
  assert.equal((await f.toggle(false)).json().needsRestart, false);
  assert.equal((await f.request('/api/ext/demo/version')).statusCode, 404);
  assert.equal((await f.toggle(true)).json().needsRestart, false);
  assert.equal((await f.request('/api/ext/demo/version')).json().version, '1.1.0');
  assert.notEqual((await f.card()).entrypoints.web.entry, after.entrypoints.web.entry);
  assert.notEqual((await f.card()).entrypoints.web.background, after.entrypoints.web.background);

  const installed = await f.service.describe('demo');
  const restored = await f.service.rollback('demo', {
    requestId: randomUUID(),
    expectedRevision: installed.revision,
    expectedPreviousDigest: installed.previous.payloadDigest,
  });

  assert.equal(restored.status, 'done');
  assert.equal((await f.request('/api/ext/demo/version')).json().version, '1.0.0');
  assert.equal((await f.card()).needsRestart, false);
  assert.match((await f.request((await f.card()).entrypoints.web.background)).body, /1\.0\.0/u);
  assert.equal((await f.request(after.entrypoints.web.background)).statusCode, 404);
  assert.equal(f.service.restartRequired('demo'), false);
  assert.deepEqual(f.probe.closed, ['1.0.0', '1.1.0']);
});

for (const initiallyEnabled of [true, false]) {
  test(`HOT: обновление выключенного плагина после boot enabled=${initiallyEnabled}`, async (t) => {
    const f = await fixture(t, initiallyEnabled);

    await f.toggle(false);

    const ready = await update(f);

    assert.equal((await f.service.apply(ready.id, ready.reviewToken)).status, 'done');
    assert.equal((await f.card()).enabled, false);
    assert.equal((await f.card()).needsRestart, false);
    assert.equal((await f.request('/api/ext/demo/version')).statusCode, 404);
    assert.equal((await f.toggle(true)).json().needsRestart, false);
    assert.equal((await f.request('/api/ext/demo/version')).json().version, '1.1.0');
    assert.deepEqual(f.probe.imports, initiallyEnabled ? ['1.0.0', '1.1.0'] : ['1.1.0']);
  });
}

test('HOT: busy запрещает замену, испорченный candidate восстанавливает прежний router', async (t) => {
  const f = await fixture(t);
  const ready = await update(f);

  f.probe.busy = 'Работает проверка';
  await assert.rejects(f.service.apply(ready.id, ready.reviewToken), { code: 'plugin_busy' });
  assert.deepEqual(f.probe.closed, []);
  assert.equal((await f.request('/api/ext/demo/version')).json().version, '1.0.0');
  f.probe.busy = null;
  await writeFile(path.join(f.service.workDir, 'jobs', ready.id, 'package/value.js'), 'изменён');
  await assert.rejects(f.service.apply(ready.id, ready.reviewToken), { code: 'preview_stale' });
  assert.equal((await f.request('/api/ext/demo/version')).json().version, '1.0.0');
  assert.equal((await f.card()).needsRestart, false);
  assert.deepEqual(f.probe.closed, ['1.0.0']);
});
