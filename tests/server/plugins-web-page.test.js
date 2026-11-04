import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { scanUserPlugins } from '../../server/src/lib/pluginsRegistry.ts';
import { manifestV1, png } from '../helpers/pluginV1.js';
import pluginsModule from '../../server/src/modules/plugins/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

async function pluginDir(root, id, manifest, files = {}) {
  const dir = path.join(root, id);

  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'plugin.json'), JSON.stringify(manifestV1({
    id,
    name: id,
    entrypoints: {},
    contributes: {},
    ...manifest,
  })));

  for (const [file, body] of Object.entries({ 'assets/icon.png': png, ...files })) {
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

test('скан принимает объявленный модуль и объясняет неверные входы', async (t) => {
  const root = await fixture(t);

  for (const [id, dir] of [['viewer', 'ui'], ['absolute', '/etc'], ['escape', '../viewer/ui'],
    ['empty', 'missing']]) {
    await pluginDir(root, id, {
      entrypoints: { web: { dir, entry: 'panel.js' } },
      contributes: { panels: [{}] },
    }, { 'ui/panel.js': 'export default {};' });
  }

  await pluginDir(root, 'plain', {});

  const plugins = await scanUserPlugins(root);
  const byId = Object.fromEntries(plugins.map((plugin) => [plugin.id, plugin]));

  assert.equal(byId.viewer.compatibility.status, 'compatible');
  assert.equal(byId.plain.nav, null);

  for (const id of ['absolute', 'escape', 'empty']) {
    assert.equal(byId[id].compatibility.status, 'incompatible');
    assert.ok(byId[id].compatibility.reason);
  }
});

test('модуль включённого плагина раздаётся, выключенного нет; старое поколение отозвано', async (t) => {
  const root = await fixture(t);

  for (const id of ['viewer', 'sleeper']) {
    await pluginDir(root, id, {
      entrypoints: { web: { dir: 'ui', entry: 'panel.js' } },
      contributes: { panels: [{ title: 'Обзор', group: 'dock' }] },
    }, { 'ui/panel.js': 'export default {};' });
  }

  const app = Fastify({ logger: false });
  let prefsData = { plugins: { viewer: true } };
  const prefs = {
    read: () => prefsData,
    write(patch) {
      prefsData = { ...prefsData, ...structuredClone(patch) };
    },
  };

  t.after(() => app.close());
  await app.register(pluginsModule, { config: { userPluginsDir: root }, prefs });

  const list = (await app.inject('/api/plugins')).json().plugins;
  const viewer = list.find((plugin) => plugin.id === 'viewer');
  const sleeper = list.find((plugin) => plugin.id === 'sleeper');
  const entry = viewer.entrypoints.web.entry;

  assert.equal(viewer.needsRestart, false);
  assert.equal(sleeper.enabled, false);
  assert.equal((await app.inject(entry)).statusCode, 200);
  assert.equal((await app.inject(sleeper.entrypoints.web.entry)).statusCode, 404);
  assert.equal((await app.inject('/api/ext/viewer/web/')).statusCode, 404);
  assert.notEqual((await app.inject('/api/ext/viewer/module/../plugin.json')).statusCode, 200);
  await app.inject({ method: 'POST', url: '/api/plugins/viewer/toggle', payload: { enabled: false } });
  await app.inject({ method: 'POST', url: '/api/plugins/viewer/toggle', payload: { enabled: true } });

  const changed = (await app.inject('/api/plugins')).json().plugins.find((plugin) => plugin.id === 'viewer');

  assert.notEqual(changed.entrypoints.web.entry, entry);
  assert.equal((await app.inject(changed.entrypoints.web.entry)).statusCode, 200);
  assert.equal((await app.inject(entry)).statusCode, 404);
});
