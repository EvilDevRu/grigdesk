import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { installHttpFixture, writeHttpPlugin } from './helpers/pluginInstallHttpFixture.js';

const url = (id = 'demo') => `/api/plugin-installs/plugins/${id}/remove`;

/**
 * Настоящий модуль и установщик работают только с временным пользовательским пакетом.
 * Данные и prefs отделены от удаляемой папки, как при обычном запуске приложения.
 */
async function fixture(t, enabled = false, replaceable = false) {
  const events = [];
  const result = await installHttpFixture(t, {
    realService: true,
    withPlugins: true,
    prefs: { plugins: { demo: enabled }, pluginSettings: { demo: { token: 'saved-value' } } },
    setup: ({ pluginsDir }) => writeHttpPlugin(pluginsDir, 'demo', { name: 'Демо' }, enabled ? {
      'server.js': `export default async function (app, options) {
        app.get('/ping', async () => ({ ok: true }));
        ${replaceable ? 'options.lifecycle.prepareReplace = async () => ({ async finish() {} });' : ''}
      }`,
    } : {}),
    configure(app) {
      app.decorate('sse', {
        broadcast(name, data) {
          events.push({ name, data });
        },
      });
    },
  });

  return { ...result, events };
}

test('Удаление ручного плагина убирает пакет из каталога, сохраняя данные и prefs', async (t) => {
  const f = await fixture(t);
  const dataDir = path.join(f.userPluginsDataDir, 'demo');
  const prefs = structuredClone(f.prefs.read());

  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, 'saved.json'), 'saved-data');

  const response = await f.app.inject({
    method: 'POST',
    url: url(),
    payload: {},
    headers: f.session,
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { id: 'demo', restartRequired: true });
  assert.equal(existsSync(path.join(f.pluginsDir, 'demo')), false);
  assert.equal(await readFile(path.join(dataDir, 'saved.json'), 'utf8'), 'saved-data');
  assert.deepEqual(f.prefs.read(), prefs);
  assert.deepEqual(f.events, [{ name: 'state-change', data: { plugins: true } }]);
  assert.equal((await f.app.inject({ url: '/api/plugins', headers: f.session }))
    .json().plugins.some((entry) => entry.id === 'demo'), false);
  assert.equal((await f.app.inject({
    method: 'POST',
    url: url(),
    payload: {},
    headers: f.session,
  }))
    .statusCode, 404);
});

test('Удаление плагина требует session, JSON, свой Origin и пустое тело', async (t) => {
  const f = await fixture(t);

  for (const [headers, payload, status] of [
    [{}, {}, 401],
    [f.cli, {}, 403],
    [f.internal, {}, 403],
    [{ ...f.session, origin: 'http://foreign.invalid' }, {}, 403],
    [{ ...f.session, 'content-type': 'text/plain' }, '{}', 415],
    [f.session, { extra: true }, 400],
  ]) {
    const response = await f.app.inject({
      method: 'POST',
      url: url(),
      payload,
      headers,
    });

    assert.equal(response.statusCode, status, response.body);
    assert.equal(existsSync(path.join(f.pluginsDir, 'demo')), true);
  }

  for (const id of ['code', 'unknown']) {
    assert.equal((await f.app.inject({
      method: 'POST',
      url: url(id),
      payload: {},
      headers: f.session,
    })).statusCode, 404);
  }
});

test('Загруженный сервер плагина без hook требует перезапуска до удаления', async (t) => {
  const f = await fixture(t, true);
  const response = await f.app.inject({
    method: 'POST',
    url: url(),
    payload: {},
    headers: f.session,
  });

  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error, 'plugin_stop_required');
  assert.equal(existsSync(path.join(f.pluginsDir, 'demo')), true);
  assert.equal((await f.app.inject({ url: '/api/ext/demo/ping', headers: f.session })).statusCode, 200);
  assert.equal(f.events.length, 0);
});

test('Загруженный плагин с lease удаляется и закрывает прежние маршруты до перезапуска', async (t) => {
  const f = await fixture(t, true, true);
  const response = await f.app.inject({
    method: 'POST',
    url: url(),
    payload: {},
    headers: f.session,
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(existsSync(path.join(f.pluginsDir, 'demo')), false);

  const ping = await f.app.inject({ url: '/api/ext/demo/ping', headers: f.session });

  assert.equal(ping.statusCode, 409, ping.body);
  assert.equal(ping.json().error, 'plugin_restart_required');
  assert.deepEqual(f.events, [{ name: 'state-change', data: { plugins: true } }]);
});
