import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import pluginsModule from '../../server/src/modules/plugins/index.ts';
import { scanUserPlugins } from '../../server/src/lib/pluginsRegistry.ts';
import { validatePluginPackage } from '../../server/src/lib/pluginInstall/validatePackage.ts';
import { sensitivePluginFile } from '../../server/src/lib/pluginInstall/serviceSnapshots.ts';
import { createPluginRepo } from './helpers/pluginRepo.js';
import { installHttpFixture } from './helpers/pluginInstallHttpFixture.js';
import { Fastify, runtimeFixture } from './helpers/pluginRuntimeFixture.js';

const expected = {
  version: '1.0.0',
  expectedId: null,
  reservedIds: new Set(['code']),
  grigDeskVersion: '1.0.0',
};
const conflict = 'У плагина есть server.js и server.ts. Оставьте один серверный файл.';

test('ENTRY-01: scanner и validator выбирают js-only/ts-only/no-server одинаково', async (t) => {
  const f = await runtimeFixture(t, [
    { id: 'javascript' },
    { id: 'typescript', entry: 'server.ts' },
    { id: 'empty', staticOnly: true },
  ]);
  const scanned = await scanUserPlugins(f.config.userPluginsDir, { warn() {} });

  for (const [id, entry] of [
    ['typescript', 'server.ts'], ['javascript', 'server.js'], ['empty', null],
  ]) {
    const descriptor = scanned.find((item) => item.id === id);
    const preview = await validatePluginPackage(path.join(f.config.userPluginsDir, id), expected);

    assert.equal(descriptor.hasServer, entry !== null, id);
    assert.equal(descriptor.serverEntry ?? null, entry, id);
    assert.equal(preview.hasServer, entry !== null, id);
  }
});

test('ENTRY-01: server.ts с типом, относительным импортом и TLA обслуживает маршрут', async (t) => {
  const f = await runtimeFixture(t, [{
    id: 'demo',
    entry: 'server.ts',
    files: {
      'lib/value.ts': 'export const value: number = 42;',
      'server.ts': [
        "import { value } from './lib/value.ts';",
        "const marker: string = await Promise.resolve('ts-tla');",
        'export default async function plugin(app) {',
        '  app.get("/typed", async () => ({ value, marker }));',
        '}',
      ].join('\n'),
    },
  }]);
  const response = await f.request('GET', '/api/ext/demo/typed');

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { value: 42, marker: 'ts-tla' });
});

test('ENTRY-02: конфликт сохраняет карточку, не исполняет код и не раздаёт страницу', async (t) => {
  const f = await runtimeFixture(t, [{
    id: 'demo',
    web: true,
    files: { 'server.ts': 'throw new Error("Нельзя исполнять конфликтный плагин");' },
  }]);
  const scanned = await scanUserPlugins(f.config.userPluginsDir, { warn() {} });
  const descriptor = scanned.find((item) => item.id === 'demo');

  assert.equal(descriptor.serverError, conflict);
  assert.equal((await f.card('demo')).serverError, conflict);
  assert.equal((await f.card('demo')).needsRestart, false);
  assert.equal(await f.imported('demo'), false);
  assert.equal((await f.request('GET', '/api/ext/demo/x')).statusCode, 404);
  assert.equal((await f.request('GET', '/api/ext/demo/web/')).statusCode, 404);
  await assert.rejects(validatePluginPackage(path.join(f.config.userPluginsDir, 'demo'), expected),
    (error) => error.code === 'manifest_invalid' && error.message.includes(conflict));
  assert.equal((await f.toggle('demo', false)).statusCode, 200);

  const before = structuredClone(f.prefs.read());
  const response = await f.toggle('demo', true);

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'plugin_server_conflict');
  assert.deepEqual(f.prefs.read(), before);
});

test('ENTRY-03: server.ts чувствителен внутри web, документация и asset прежние', () => {
  assert.equal(sensitivePluginFile('web/server.ts', 'web'), true);
  assert.equal(sensitivePluginFile('web/server.js', 'web'), true);
  assert.equal(sensitivePluginFile('web/app.js', 'web'), false);
  assert.equal(sensitivePluginFile('docs/README.md', 'web'), false);
});

test('ENTRY-04: настоящий Git/service ставит dormant TS, refresh без import, новый boot работает',
  async (t) => {
    const repo = await createPluginRepo(t);
    const marker = path.join(repo.root, 'imported');

    await repo.release('1.0.0', { files: {
      'package.json': '{"type":"module"}',
      'server.ts': [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(marker)}, 'imported');`,
        'const value: number = 42;',
        'export default async function plugin(app) {',
        '  app.get("/typed", async () => ({ value }));',
        '}',
      ].join('\n'),
    } });

    const f = await installHttpFixture(t, { withPlugins: true, realService: true });

    await f.installs.startInstall({ url: repo.url, version: '1.0.0' });
    await f.installs.whenIdle();

    const ready = await f.installs.currentJob();

    assert.equal(ready.status, 'ready');
    assert.equal(ready.preview.hasServer, true);
    assert.equal((await f.installs.apply(ready.id, ready.reviewToken)).status, 'done');
    assert.equal(await access(marker).then(() => true, () => false), false);
    assert.equal(f.installs.runtime.isLoaded('demo'), false);
    assert.equal((await f.app.inject({
      method: 'POST',
      url: '/api/plugins/demo/toggle',
      payload: { enabled: true },
      headers: f.session,
    })).statusCode, 200);
    assert.equal(await access(marker).then(() => true, () => false), false);

    const reboot = Fastify({ logger: false });

    t.after(() => reboot.close());
    await reboot.register(pluginsModule, {
      config: { userPluginsDir: f.pluginsDir, userPluginsDataDir: f.userPluginsDataDir },
      prefs: f.prefs,
    });

    const response = await reboot.inject('/api/ext/demo/typed');

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { value: 42 });
    assert.equal(await access(marker).then(() => true, () => false), true);
  });
