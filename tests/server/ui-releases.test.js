import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import staticPlugin from '../../server/src/plugins/static.ts';
import authPlugin from '../../server/src/plugins/auth.ts';
import { publishUiRelease, sealUiRelease } from '../../desktop/src/uiRelease.ts';

const require = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = require('fastify');
const cookie = 'cockpit_sid=fixture-session';

/**
 * Настоящие static/auth плагины обслуживают две разные сборки и собственное состояние.
 * Удаление working dist не должно менять ответы версии, которую уже открыл desktop.
 */
async function fixture(t, working = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ui-static-'));
  const webDist = path.join(root, 'working');
  const source = path.join(root, 'bundle');
  const uiReleasesDir = path.join(root, 'releases');
  const app = Fastify();

  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(source, 'assets'), { recursive: true });
  await writeFile(path.join(source, 'index.html'), '<p>упакованный интерфейс</p>');
  await writeFile(path.join(source, 'assets/panel.js'), 'export default "панель";');

  const release = await sealUiRelease(source);

  await publishUiRelease(source, uiReleasesDir);

  if (working) {
    await mkdir(webDist);
    await writeFile(path.join(webDist, 'index.html'), '<p>рабочий интерфейс</p>');
  }

  await app.register(authPlugin, {
    authStore: { isValidSession: (id) => id === 'fixture-session' },
  });
  await app.register(staticPlugin, {
    webDist,
    uiReleasesDir,
    stateDir: path.join(root, 'state'),
  });

  const get = (url, headers = { cookie }) => app.inject({ url, headers });

  return {
    app,
    get,
    webDist,
    base: '/ui/' + release.id + '/',
  };
}

for (const working of [true, false]) {
  test(`релиз работает без зависимости от рабочей сборки: working=${working}`, async (t) => {
    const { get, webDist, base } = await fixture(t, working);

    if (working) {
      assert.match((await get('/chats')).body, /рабочий интерфейс/);
      await rm(webDist, { recursive: true });
    }

    const document = await get(base);
    const asset = await get(base + 'assets/panel.js');

    assert.equal(document.statusCode, 200);
    assert.match(document.body, /упакованный интерфейс/);
    assert.equal(asset.statusCode, 200);
    assert.match(asset.headers['content-type'], /javascript/);
    assert.match(asset.headers['cache-control'], /immutable/);
    assert.equal((await get(base + '?window=settings')).statusCode, 200);
  });
}

test('ресурсы и staging не подменяются SPA, новая статика требует сессию', async (t) => {
  const { get, base } = await fixture(t);

  for (const url of [base, base + 'release.json', base + 'assets/panel.js', '/%75i/' + base.slice(4)]) {
    assert.equal((await get(url, {})).statusCode, 401, url);
  }

  for (const url of ['/assets/missing.js', '/%61ssets/missing.js', '/missing.js',
    '/ui/.pending-fixture/index.html', '/ui/' + 'b'.repeat(64) + '/', base + 'assets/missing.js',
    '/api/missing']) {
    const response = await get(url);

    assert.equal(response.statusCode, 404, url);
    assert.doesNotMatch(response.headers['content-type'], /html/);
  }
});
