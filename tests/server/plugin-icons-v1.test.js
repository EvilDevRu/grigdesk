import assert from 'node:assert/strict';
import { rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { runtimeFixture } from './helpers/pluginRuntimeFixture.js';
import { manifestV1, png, v1Files } from '../helpers/pluginV1.js';

for (const enabled of [false, true]) {
  test(`V1-ICON-HTTP: enabled=${enabled}, авторизация, MIME и ровно объявленные байты`, async (t) => {
    const f = await runtimeFixture(t, [{
      id: 'demo',
      manifest: manifestV1(),
      files: v1Files
    }], {
      prefs: { plugins: { demo: enabled } },
    });
    const card = await f.card('demo');

    assert.equal(typeof card.icon, 'string', 'каталог публикует URL файловой иконки');
    assert.match(card.icon, /^\/api\/plugins\/demo\/icon\/[a-f0-9]+$/u);
    assert.equal((await f.request('GET', card.icon, undefined, {})).statusCode, 401);

    const response = await f.request('GET', card.icon);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.rawPayload, png);
    assert.match(response.headers['content-type'], /^image\/png/u);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.match(response.headers['cache-control'], /no-cache|no-store/u);
    assert.equal((await f.request('GET', `${card.icon}/other.png`)).statusCode, 404);

    if (!enabled) {
      assert.equal(await f.imported('demo'), false);
    }
  });
}

test('V1-ICON-HTTP: подмена bytes, ссылка и старый digest не раздают другой файл', async (t) => {
  const f = await runtimeFixture(t, [{
    id: 'demo',
    manifest: manifestV1(),
    files: v1Files
  }], {
    prefs: { plugins: { demo: false } },
  });
  const card = await f.card('demo');

  assert.equal(typeof card.icon, 'string');
  await writeFile(path.join(f.config.userPluginsDir, 'demo/assets/icon.png'), Buffer.concat([png, png]));
  assert.equal((await f.request('GET', card.icon)).statusCode, 404);
  await f.port.runtime.refresh();

  const fresh = await f.card('demo');

  assert.notEqual(fresh.icon, card.icon);
  assert.equal((await f.request('GET', fresh.icon)).statusCode, 200);

  const target = path.join(f.root, 'outside.png');

  await writeFile(target, png);
  await rm(path.join(f.config.userPluginsDir, 'demo/assets/icon.png'));
  await symlink(target, path.join(f.config.userPluginsDir, 'demo/assets/icon.png'));
  assert.equal((await f.request('GET', fresh.icon)).statusCode, 404);
});
