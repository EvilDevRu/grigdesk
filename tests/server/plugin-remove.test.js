import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { installedSnapshot } from '../../server/src/lib/packageInstall/serviceSnapshots.ts';
import { installHttpFixture, writeHttpPlugin } from './helpers/pluginInstallHttpFixture.js';
import { installedRecord } from './helpers/pluginInstallState.js';

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
  assert.deepEqual(response.json(), { id: 'demo', restartRequired: false });
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

test('Старый пакет удаляется с node_modules и ссылками, сохраняя их внешние цели', async (t) => {
  const f = await installHttpFixture(t, {
    realService: true,
    withPlugins: true,
    /**
     * Legacy-пакет воспроизводит зависимости и ссылки, запрещённые при новой установке.
     * Внешний sentinel подтверждает удаление ссылки без чтения или удаления её цели.
     */
    async setup({ root, pluginsDir }) {
      const directory = await writeHttpPlugin(pluginsDir, 'demo', { api: 0 });
      const dependencies = path.join(directory, 'node_modules');
      const external = path.join(root, 'external');

      await mkdir(path.join(dependencies, 'dependency'), { recursive: true });
      await mkdir(external);
      await writeFile(path.join(dependencies, 'dependency/index.js'), 'export default 1;');
      await writeFile(path.join(external, 'saved.txt'), 'preserve');
      await symlink(external, path.join(dependencies, 'external'));
      await symlink('../missing-config', path.join(directory, '.npmrc'));
    },
  });
  const catalog = await f.app.inject({ url: '/api/plugins', headers: f.session });

  assert.equal(catalog.json().plugins.find((entry) => entry.id === 'demo').compatibility.status,
    'incompatible');

  const response = await f.app.inject({
    method: 'POST',
    url: url(),
    payload: {},
    headers: f.session,
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(existsSync(path.join(f.pluginsDir, 'demo')), false);
  assert.equal(await readFile(path.join(f.root, 'external/saved.txt'), 'utf8'), 'preserve');
  assert.deepEqual(await readdir(path.join(f.installs.workDir, 'transactions')), []);
  assert.deepEqual((await f.installs.store.read()).cleanup, []);
});

test('Удаление отвергает подмену корня пакета ссылкой и сохраняет внешнее дерево', async (t) => {
  const f = await fixture(t);
  const directory = path.join(f.pluginsDir, 'demo');
  const external = path.join(f.root, 'external');

  await rename(directory, external);
  await symlink(external, directory);

  const response = await f.app.inject({
    method: 'POST',
    url: url(),
    payload: {},
    headers: f.session,
  });

  assert.equal(response.statusCode, 503, response.body);
  assert.equal(response.json().error, 'recovery_required');
  assert.equal(existsSync(path.join(external, 'plugin.json')), true);
  assert.equal((await f.installs.store.read()).removal ?? null, null);
});

test('Managed-пакет удаляется вместе с повреждённой предыдущей версией', async (t) => {
  const f = await installHttpFixture(t, {
    realService: true,
    withPlugins: true,
    /**
     * Журнал и предыдущая версия создаются до recovery настоящего модуля.
     * Повреждения обеих копий не должны требовать успешной установки для удаления.
     */
    async setup({ installs, pluginsDir }) {
      const record = installedRecord();

      record.previous = installedSnapshot(installedRecord('0.9.0'));
      await installs.store.mutate((state) => {
        state.plugins.demo = record;
        state.nextRevision = 2;
      });

      const current = await writeHttpPlugin(pluginsDir, 'demo');
      const previous = path.join(installs.workDir, 'previous/demo');

      await mkdir(previous, { recursive: true });
      await writeFile(path.join(previous, 'plugin.json'), '{broken');
      await writeFile(path.join(previous, '.git'), 'gitdir: missing');
      await mkdir(path.join(current, 'node_modules'), { recursive: true });
    },
  });
  const response = await f.app.inject({
    method: 'POST',
    url: url(),
    payload: {},
    headers: f.session,
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(existsSync(path.join(f.pluginsDir, 'demo')), false);
  assert.equal(existsSync(path.join(f.installs.workDir, 'previous/demo')), false);
  assert.equal((await f.installs.store.read()).plugins.demo, undefined);
  assert.deepEqual((await f.installs.store.read()).cleanup, []);
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

test('Загруженный сервер без prepareReplace закрывается собственным router перед удалением', async (t) => {
  const f = await fixture(t, true);
  const response = await f.app.inject({
    method: 'POST',
    url: url(),
    payload: {},
    headers: f.session,
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().restartRequired, false);
  assert.equal(existsSync(path.join(f.pluginsDir, 'demo')), false);
  assert.equal((await f.app.inject({ url: '/api/ext/demo/ping', headers: f.session })).statusCode, 404);
  assert.equal(f.events.length, 1);
});

test('Загруженный плагин с lease удаляется вместе с прежними маршрутами без перезапуска', async (t) => {
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

  assert.equal(ping.statusCode, 404, ping.body);
  assert.equal(response.json().restartRequired, false);
  assert.deepEqual(f.events, [{ name: 'state-change', data: { plugins: true } }]);
});
