// Своя страница пользовательского плагина: манифест называет папку `web` с index.html,
// GrigDesk раздаёт её под /api/ext/<id>/web/ только включённому плагину и не исполняет
// её код. Абсолютный путь, выход за каталог и папка без index.html — не страница.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { scanUserPlugins } from '../../server/src/lib/pluginsRegistry.ts';
import pluginsModule from '../../server/src/modules/plugins/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

async function pluginDir(root, id, manifest, files = {}) {
  const dir = path.join(root, id);

  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'plugin.json'), JSON.stringify({ id, name: id, ...manifest }));

  for (const [file, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), body, 'utf8');
  }

  return dir;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-plugin-web-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  return root;
}

test('скан принимает папку страницы с index.html и отбрасывает кривые объявления', async (t) => {
  const root = await fixture(t);

  await pluginDir(root, 'viewer', { web: 'web' }, { 'web/index.html': '<h1>viewer</h1>' });
  await pluginDir(root, 'absolute', { web: '/etc' });
  await pluginDir(root, 'escape', { web: '../viewer/web' });
  await pluginDir(root, 'empty', { web: 'web' }, { 'web/readme.txt': 'без index' });
  await pluginDir(root, 'plain', {});

  const warnings = [];
  const plugins = await scanUserPlugins(root, { warn: (meta, message) => warnings.push({ meta, message }) });
  const byId = Object.fromEntries(plugins.map((plugin) => [plugin.id, plugin]));

  assert.deepEqual(byId.viewer.web, { dir: path.join(root, 'viewer', 'web'), url: '/api/ext/viewer/web/' });
  assert.equal(byId.absolute.web, null);
  assert.equal(byId.escape.web, null);
  assert.equal(byId.empty.web, null);
  assert.equal(byId.plain.web, null);
  assert.deepEqual(
    warnings.map((entry) => entry.meta.plugin).sort(),
    ['absolute', 'empty', 'escape'],
    'каждое отброшенное объявление названо в журнале',
  );
});

test('страница включённого плагина раздаётся под /api/ext/<id>/web/, выключенного — нет', async (t) => {
  const root = await fixture(t);

  await pluginDir(root, 'viewer', { web: 'web', nav: { path: '/ext/viewer', label: 'Обзор', group: 'dock' } }, {
    'web/index.html': '<!doctype html><title>Обзор</title>',
    'web/app.js': 'console.log("viewer")',
  });
  await pluginDir(root, 'sleeper', { web: 'web' }, { 'web/index.html': '<title>sleeper</title>' });

  const app = Fastify({ logger: false });
  let prefsData = { plugins: { viewer: true } };
  const prefs = {
    read: () => prefsData,
    write(patch) {
      prefsData = { ...prefsData, ...structuredClone(patch) };
    },
  };

  await app.register(pluginsModule, { config: { userPluginsDir: root }, prefs });
  t.after(() => app.close());

  const list = (await app.inject({ method: 'GET', url: '/api/plugins' })).json().plugins;
  const viewer = list.find((plugin) => plugin.id === 'viewer');
  const sleeper = list.find((plugin) => plugin.id === 'sleeper');

  assert.match(viewer.web, /^\/api\/ext\/viewer\/web\/[a-f0-9-]+\/$/);
  assert.equal(viewer.needsRestart, false, 'загруженная страница переключается без рестарта');
  assert.equal(sleeper.web, '/api/ext/sleeper/web/');
  assert.equal(sleeper.enabled, false);

  const index = await app.inject({ method: 'GET', url: viewer.web });

  assert.equal(index.statusCode, 200);
  assert.match(index.headers['content-type'], /text\/html/);
  assert.match(index.body, /Обзор/);

  const script = await app.inject({ method: 'GET', url: viewer.web + 'app.js' });

  assert.equal(script.statusCode, 200);
  assert.match(script.headers['content-type'], /javascript/);

  const escape = await app.inject({ method: 'GET', url: '/api/ext/viewer/web/../plugin.json' });

  assert.notEqual(escape.statusCode, 200, 'выход за папку страницы закрыт');

  const off = await app.inject({ method: 'GET', url: '/api/ext/sleeper/web/' });

  assert.equal(off.statusCode, 404);

  await app.inject({ method: 'POST', url: '/api/plugins/viewer/toggle', payload: { enabled: false } });
  await app.inject({ method: 'POST', url: '/api/plugins/viewer/toggle', payload: { enabled: true } });

  const changed = (await app.inject('/api/plugins')).json().plugins.find((plugin) => plugin.id === 'viewer');

  assert.notEqual(changed.web, viewer.web, 'iframe получает новый src при включении');
  assert.equal((await app.inject(changed.web)).statusCode, 200);
  assert.equal((await app.inject(viewer.web + 'app.js')).statusCode, 404);
});
