import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { PluginInstallService } from '../../server/src/lib/packageInstall/service.ts';
import { PluginAdmission, createPluginLifecycle } from '../../server/src/modules/plugins/lifecycle.ts';
import pluginsModule from '../../server/src/modules/plugins/index.ts';
import { createPluginRepo } from './helpers/pluginRepo.js';
import { serviceFixture } from './helpers/pluginServiceFixture.js';
import { requireFromServer } from './helpers/pluginInstallHttpFixture.js';

/**
 * Две версии проходят настоящий Git installer, а загруженный legacy runtime — общий gate.
 * Отсутствие prepareReplace нельзя подменить диагностикой свободного плагина.
 */
async function scheduledFixture(t) {
  const repo = await createPluginRepo(t);
  const files = {
    'package.json': '{"type":"module"}',
    'server.js': [
      'export default async function plugin(app, options) {',
      '  app.get("/version", async () => ({ version: options.plugin.version }));',
      '}',
    ].join('\n'),
  };

  await repo.release('1.0.0', { files });
  await repo.release('1.1.0', { files });

  const fixture = await serviceFixture(t);
  const { service } = fixture;

  await service.startInstall({ url: repo.url, version: '1.0.0' });
  await service.whenIdle();

  const initial = await service.currentJob();

  assert.equal((await service.apply(initial.id, initial.reviewToken)).status, 'done');

  const lifecycle = createPluginLifecycle();
  const gate = new PluginAdmission({ lifecycle, hasServer: true });

  service.bindRuntime({
    isLoaded: () => true,
    prepareReplace: (id, signal) => gate.prepare(signal),
    refresh: async () => {},
  });
  await service.startUpdate('demo', { version: '1.1.0' });
  await service.whenIdle();

  const ready = await service.currentJob();

  assert.equal(ready.status, 'ready');

  return {
    ...fixture,
    repo,
    ready,
    gate,
    lifecycle,
  };
}

/**
 * Новый владелец получает только durable state; старый runtime уже закрыт.
 * Повторный recover того же instance не должен повторять подтверждённую замену.
 */
async function successor(fixture, use) {
  await fixture.service.close();

  const next = new PluginInstallService(fixture.service.options);

  try {
    await use(next);
  } finally {
    await next.close();
  }
}

test('SCHEDULE: legacy update сохраняется без замены файлов и применяется до import за один запуск',
  async (t) => {
    const fixture = await scheduledFixture(t);
    const { service, ready, pluginsDir } = fixture;
    const current = path.join(pluginsDir, 'demo/plugin.json');
    const scheduled = await service.apply(ready.id, ready.reviewToken);

    assert.equal(scheduled.status, 'awaiting_restart');
    assert.equal(JSON.parse(await readFile(current, 'utf8')).version, '1.0.0');
    assert.equal(fixture.gate.obsolete, false);
    assert.equal((await service.describe('demo')).version, '1.0.0');
    assert.equal((await service.store.read()).apply, null);
    assert.deepEqual(await service.apply(ready.id, ready.reviewToken), scheduled);
    await service.checkUpdates();
    await assert.rejects(service.apply(ready.id, 'f'.repeat(64)), { code: 'preview_stale' });
    await assert.rejects(service.startUpdate('demo'), { code: 'install_busy' });

    await successor(fixture, async (next) => {
      const app = requireFromServer('fastify')({ logger: false });
      const prefs = { read: () => ({ plugins: { demo: true } }) };

      try {
        await app.register(pluginsModule, {
          config: { userPluginsDir: pluginsDir, userPluginsDataDir: path.join(fixture.root, 'data') },
          prefs,
          installs: next,
        });
        await app.ready();

        const response = await app.inject('/api/ext/demo/version');
        const done = await next.currentJob();

        assert.equal(response.statusCode, 200);
        assert.equal(response.json().version, '1.1.0');
        assert.equal(done.id, scheduled.id);
        assert.equal(done.status, 'done');
        assert.equal((await next.describe('demo')).previous.version, '1.0.0');
        assert.equal(next.restartRequired('demo'), false);
        assert.deepEqual(await next.recover(), { blockedIds: [], error: null });
        assert.equal((await next.currentJob()).revision, done.revision);
        assert.equal(prefs.read().plugins.demo, true);
      } finally {
        await app.close();
      }
    });
  });

test('SCHEDULE: отмена подтверждённого обновления сохраняется после перезапуска', async (t) => {
  const fixture = await scheduledFixture(t);
  const { service, ready } = fixture;

  await service.apply(ready.id, ready.reviewToken);
  assert.equal((await service.cancel(ready.id)).status, 'cancelled');
  await successor(fixture, async (next) => {
    assert.deepEqual(await next.recover(), { blockedIds: [], error: null });
    assert.equal((await next.currentJob()).status, 'cancelled');
    assert.equal((await next.describe('demo')).version, '1.0.0');
  });
});

for (const target of ['candidate', 'current']) {
  test(`SCHEDULE: изменение ${target} после подтверждения запрещает замену при boot`, async (t) => {
    const fixture = await scheduledFixture(t);
    const { service, ready, pluginsDir } = fixture;

    await service.apply(ready.id, ready.reviewToken);

    const directory = target === 'candidate' ? path.join(service.workDir, 'jobs', ready.id, 'package')
      : path.join(pluginsDir, 'demo');

    await writeFile(path.join(directory, 'server.js'), 'Ручные изменения');
    await successor(fixture, async (next) => {
      assert.deepEqual(await next.recover(), { blockedIds: [], error: null });
      assert.equal((await next.currentJob()).status, 'failed');
      assert.equal((await next.currentJob()).error.code, 'preview_stale');
      assert.equal((await next.describe('demo')).version, '1.0.0');
      assert.equal(await readFile(path.join(directory, 'server.js'), 'utf8'), 'Ручные изменения');
    });
  });
}

test('SCHEDULE: занятый legacy runtime не ставит обновление в очередь', async (t) => {
  const fixture = await scheduledFixture(t);
  const { service, ready, lifecycle } = fixture;

  lifecycle.busyReason = () => 'Выполняется задание';
  await assert.rejects(service.apply(ready.id, ready.reviewToken), { code: 'plugin_busy' });
  assert.equal((await service.currentJob()).status, 'ready');
  assert.equal((await service.store.read()).apply, null);
});

test('SCHEDULE: испорченный candidate не подтверждается даже для legacy runtime', async (t) => {
  const fixture = await scheduledFixture(t);
  const { service, ready } = fixture;
  const candidate = path.join(service.workDir, 'jobs', ready.id, 'package/server.js');

  await writeFile(candidate, 'Ручные изменения');
  await assert.rejects(service.apply(ready.id, ready.reviewToken), { code: 'preview_stale' });
  assert.equal((await service.currentJob()).status, 'ready');
});
