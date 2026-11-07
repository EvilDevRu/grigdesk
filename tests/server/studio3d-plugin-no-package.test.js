import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import test from 'node:test';

import { SYSTEM } from '../../server/src/lib/pluginsRegistry.ts';
import { studioPluginFixture } from './helpers/studio3dPluginFixture.js';

test('NO-PACKAGE15 полный SYSTEM и настоящий каталог не содержат встроенный studio3d', async (t) => {
  const f = await studioPluginFixture(t, { noPackage: true });
  const response = await f.request('GET', '/api/plugins');

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(SYSTEM.some((item) => item.id === 'studio3d'), false);
  assert.deepEqual(response.json().plugins.filter((item) => item.id === 'studio3d'), []);
  assert.equal(f.probe.runtimePort.isLoaded('studio3d'), false);
  assert.equal(f.runtime(), null);
  assert.equal(f.prefsStore.read().plugins.studio3d, true);
  await assert.rejects(access(f.config.studio3dDir), { code: 'ENOENT' });
  assert.equal(f.fake.requests.length, 0);
});

test('NO-PACKAGE15 старые API возвращают404 без прокси и без provider POST', async (t) => {
  const f = await studioPluginFixture(t, { noPackage: true });
  const before = JSON.stringify(f.prefsStore.read());

  for (const [method, url] of [
    ['GET', '/api/studio3d/state'],
    ['POST', '/api/studio3d/run'],
    ['POST', '/api/studio3d/batches/run'],
  ]) {
    const response = await f.request(method, url, method === 'POST' ? { values: {} } : undefined);

    assert.equal(response.statusCode, 404, `${url}: ${response.body}`);
  }

  assert.equal(JSON.stringify(f.prefsStore.read()), before);
  assert.equal(f.fake.requests.length, 0);
  assert.equal(f.probe.runtimePort.isLoaded('studio3d'), false);
});
