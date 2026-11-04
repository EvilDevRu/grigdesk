import assert from 'node:assert/strict';
import { rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { runtimeFixture } from './helpers/pluginRuntimeFixture.js';
import { legacyManifest, manifestV1, v1Files } from '../helpers/pluginV1.js';

test('V1-ENTRY: declared TS с relative import/TLA получает расширенный core при api1', async (t) => {
  const f = await runtimeFixture(t, [{
    id: 'demo',
    manifest: manifestV1(),
    files: v1Files
  }], { runtimeServices: { project: async (id) => ({ id }) } });
  const response = await f.request('GET', '/api/ext/demo/status');

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), {
    value: 42,
    marker: 'declared',
    core: 'v1'
  });
  assert.equal(await f.imported('demo'), false, 'необъявленный server.js не исполняется');
  assert.equal((await f.request('GET', '/api/ext/demo/web/')).statusCode, 404);
});

for (const [id, legacy] of [
  ['performance-audit', { api: 1, web: 'web' }],
  ['old-module', { api: 2, webModule: { dir: 'ui', entry: 'panel.js' } }],
  ['old-empty', { api: 1 }],
]) {
  test(`V1-LEGACY-SCAN: ${id} виден, имеет причину и не исполняется`, async (t) => {
    const f = await runtimeFixture(t, [{
      id,
      manifest: legacyManifest(legacy),
      files: {
      ...v1Files,
      'web/index.html': '<p>Старый пакет</p>',
    }
    }]);
    const card = await f.card(id);

    assert.equal(card?.compatibility?.status, 'incompatible');
    assert.equal(card.compatibility.code, 'manifest_incompatible');
    assert.ok(card.compatibility.reason);
    assert.equal(card.enabled, false);
    assert.equal(card.nav, null);
    assert.equal(card.needsRestart, false);
    assert.equal(await f.imported(id), false);

    const before = structuredClone(f.prefs.read());
    const writes = f.writes.length;

    assert.equal((await f.toggle(id, true)).statusCode, 409);
    assert.deepEqual(f.prefs.read(), before);
    assert.equal(f.writes.length, writes);

    for (const suffix of ['x', 'web/', 'module/panel.js']) {
      assert.equal((await f.request('GET', `/api/ext/${id}/${suffix}`)).statusCode, 404);
    }
  });
}

for (const kind of ['missing', 'escape', 'link']) {
  test(`V1-ENTRY: ${kind} сохраняет несовместимую карточку и работающего соседа`, async (t) => {
    const bad = manifestV1({ id: 'bad' });

    if (kind === 'missing') {
      bad.entrypoints.server = 'runtime/missing.ts';
    } else if (kind === 'escape') {
      bad.entrypoints.server = '../outside.ts';
    }

    const files = { ...v1Files };

    if (kind === 'link') {
      delete files['runtime/main.ts'];
    }

    const f = await runtimeFixture(t, [
      {
        id: 'bad',
        manifest: bad,
        files
      },
      {
        id: 'demo',
        manifest: manifestV1(),
        files: v1Files
      },
    ]);

    if (kind === 'link') {
      const outside = path.join(f.root, 'outside.ts');

      await writeFile(outside, v1Files['runtime/main.ts']);
      await rm(path.join(f.config.userPluginsDir, 'bad/runtime/main.ts'), { force: true });
      await symlink(outside, path.join(f.config.userPluginsDir, 'bad/runtime/main.ts'));
      await f.port.runtime.refresh();
    }

    assert.equal((await f.card('bad'))?.compatibility?.status, 'incompatible');
    assert.equal(await f.imported('bad'), false);
    assert.equal((await f.request('GET', '/api/ext/demo/status')).statusCode, 200);
  });
}

test('V1-ENTRY: объявленный вход работает рядом с обоими необъявленными server.js/server.ts', async (t) => {
  const f = await runtimeFixture(t, [{
    id: 'demo',
    manifest: manifestV1(),
    files: {
      ...v1Files,
      'server.ts': 'throw new Error("Необъявленный сервер нельзя исполнять");',
    },
  }]);
  const response = await f.request('GET', '/api/ext/demo/status');

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().marker, 'declared');
  assert.equal(await f.imported('demo'), false);
});

test('V1-ENGINES: boot и refresh получают ту же фактическую версию, что installer', async (t) => {
  const manifest = manifestV1({ engines: { grigdesk: '>=1.0.0' } });
  const f = await runtimeFixture(t, [{
    id: 'demo',
    manifest,
    files: v1Files
  }], {
    grigDeskVersion: '1.0.0',
  });

  assert.equal((await f.card('demo'))?.compatibility?.status, 'compatible');
  assert.equal((await f.request('GET', '/api/ext/demo/status')).statusCode, 200);
  await f.port.runtime.refresh();
  assert.equal((await f.card('demo')).compatibility.status, 'compatible');
});
