import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import staticPlugin from '../../server/src/plugins/static.ts';
import authPlugin from '../../server/src/plugins/auth.ts';
import pluginsModule from '../../server/src/modules/plugins/index.ts';

const require = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = require('fastify');
const cookie = 'grigdesk_sid=fixture-session';

/**
 * На диске намеренно лежат прежние UI-сборки: сервер не должен раздать их даже с сессией.
 * Настоящие plugins/auth/static сохраняют доступ к снимкам и странице включённого плагина.
 */
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-api-static-'));
  const webDist = path.join(root, 'working');
  const uiReleasesDir = path.join(root, 'releases');
  const base = '/ui/' + 'a'.repeat(64) + '/';
  const app = Fastify();

  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(webDist, 'assets'), { recursive: true });
  await writeFile(path.join(webDist, 'index.html'), '<p>СЕКРЕТНЫЙ_СТАРЫЙ_UI</p>');
  await writeFile(path.join(webDist, 'assets/x.js'), 'const OLD_UI = true;');
  await mkdir(path.join(uiReleasesDir, base.slice(4)), { recursive: true });
  await writeFile(path.join(uiReleasesDir, base.slice(4), 'index.html'), '<p>СТАРЫЙ_ПАКЕТ</p>');
  await mkdir(path.join(root, 'plugins/viewer/web'), { recursive: true });
  await writeFile(path.join(root, 'plugins/viewer/plugin.json'), JSON.stringify({
    id: 'viewer',
    name: 'Фикстура',
    web: 'web',
  }));
  await writeFile(path.join(root, 'plugins/viewer/web/index.html'), '<h1>Страница плагина</h1>');
  await app.register(authPlugin, {
    authStore: { isValidSession: (id) => id === 'fixture-session' },
  });
  await app.register(pluginsModule, {
    config: { userPluginsDir: path.join(root, 'plugins') },
    prefs: { read: () => ({ plugins: { viewer: true } }) },
  });
  await app.register(staticPlugin, {
    webDist,
    uiReleasesDir,
    stateDir: path.join(root, 'state'),
  });
  await writeFile(path.join(root, 'state/shots/fixture.txt'), 'закрытый снимок');

  return { app, base };
}

test('сервер сообщает об приложении и не раздаёт прежние UI и assets', async (t) => {
  const { app, base } = await fixture(t);

  for (const url of ['/', '/chats', '/unknown-document']) {
    for (const headers of [{ accept: 'text/html' }, { cookie, accept: 'text/html' }]) {
      const response = await app.inject({ url, headers });

      assert.equal(response.statusCode, 200);
      assert.match(response.body, /GrigDesk открывается в приложении/);
      assert.doesNotMatch(response.body, /СЕКРЕТНЫЙ_СТАРЫЙ_UI|СТАРЫЙ_ПАКЕТ/);
      assert.equal(response.headers['cache-control'], 'no-store');
    }
  }

  for (const url of ['/assets/x.js', '/assets/missing.js', '/%61ssets/x.js', base,
    base + 'index.html', '/ui/.pending/index.html', '/api/missing', '/missing.js']) {
    const response = await app.inject({ url, headers: { cookie, accept: 'text/html' } });

    assert.equal(response.statusCode, 404, url);
    assert.doesNotMatch(response.body, /СЕКРЕТНЫЙ_СТАРЫЙ_UI|СТАРЫЙ_ПАКЕТ/);
    assert.doesNotMatch(response.headers['content-type'], /html/);
  }
});

test('снимки и страницы плагинов остаются под общим гардом', async (t) => {
  const { app } = await fixture(t);

  for (const url of ['/shots/fixture.txt', '/%73hots/fixture.txt', '/api/ext/viewer/web/']) {
    assert.equal((await app.inject({ url })).statusCode, 401, url);
    assert.equal((await app.inject({ url, headers: { cookie } })).statusCode, 200, url);
  }
});
