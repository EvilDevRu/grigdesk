import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { createClientRuntime } from '../../desktop/src/clientRuntime.ts';
import { normalizeSettings } from '../../desktop/src/settings.ts';
import { loadServerRuntime } from '../../desktop/src/runtimeConfig.ts';
import { temporary } from '../relay/helpers.js';

/**
 * Недоступный сервер принадлежит тесту и не может обратиться к рабочей установке.
 * Проверяем выбор и запуск supervisor отдельно от завершения сетевого подключения.
 */
async function startupFixture(t, { available = true, profiles = [], selected = null } = {}) {
  const root = await temporary(t);
  const server = createServer((_request, response) => response.writeHead(503).end());

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = `http://127.0.0.1:${server.address().port}`;
  const settings = normalizeSettings({
    version: 2,
    profiles,
    selected,
  });
  const saved = [];
  const prepared = [];
  let identityReads = 0;
  const client = createClientRuntime({
    settings,
    save: async () => saved.push(structuredClone(settings)),
    uiDir: root,
    secret: 'startup-fixture-only',
    identity: {
      load: async () => {
        identityReads += 1;

        throw new Error('Удалённый ключ недоступен в фикстуре.');
      },
    },
    identityDirectory: root,
    localAvailable: () => available,
    localAddress: () => address,
    windowKey: async () => '',
    prepareLocal: (profile) => prepared.push(profile.id),
    onOrigin: () => {},
    navigate: async () => {},
  });

  t.after(async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  return {
    client,
    settings,
    address,
    saved,
    prepared,
    identityReads: () => identityReads,
  };
}

test('старт: установленный локальный GrigDesk выбирается без экрана машин', async (t) => {
  const fixture = await startupFixture(t);
  const origin = await fixture.client.start();
  const state = fixture.client.shell.state();

  assert.equal(state.profile?.kind, 'local');
  assert.equal(state.profile?.address, fixture.address);
  assert.equal(fixture.settings.selected, state.profile?.id);
  assert.equal(new URL(origin).port === '47100', false);
  assert.deepEqual(fixture.prepared, [state.profile.id]);
  assert.equal(fixture.saved.at(-1).selected, state.profile.id);
  assert.equal(fixture.identityReads(), 0);
});

test('старт: существующий локальный профиль выбирается без дубликата', async (t) => {
  const local = {
    id: 'local-fixture',
    name: 'Мой компьютер',
    kind: 'local',
    address: 'http://127.0.0.1:9',
    fp: null,
    port: 47183,
    createdAt: 0,
  };
  const fixture = await startupFixture(t, { profiles: [local] });

  fixture.settings.profiles[0].address = fixture.address;
  await fixture.client.start();
  assert.equal(fixture.settings.selected, local.id);
  assert.equal(fixture.settings.profiles.length, 1);
  assert.equal(fixture.settings.profiles[0].name, local.name);
  assert.deepEqual(fixture.prepared, [local.id]);
});

test('старт: сохранённая удалённая машина не заменяется локальной', async (t) => {
  const remote = {
    id: 'remote-fixture',
    name: 'Рабочая машина',
    kind: 'remote',
    address: 'https://machine.example',
    fp: '1'.repeat(64),
    port: 47184,
    createdAt: 0,
  };
  const fixture = await startupFixture(t, { profiles: [remote], selected: remote.id });

  await fixture.client.start();
  assert.equal(fixture.settings.selected, remote.id);
  assert.equal(fixture.settings.profiles.length, 1);
  assert.deepEqual(fixture.prepared, []);
  assert.equal(fixture.identityReads(), 1);
});

test('старт: без локальной установки профиль не придумывается', async (t) => {
  const fixture = await startupFixture(t, { available: false });
  const origin = await fixture.client.start();

  assert.equal(fixture.client.shell.state().profile, null);
  assert.equal(new URL(origin).port, '47100');
  assert.deepEqual(fixture.saved, []);
  assert.deepEqual(fixture.prepared, []);
});

test('SB24-main-inspect: загрузка адреса для UI не вызывает prepareBinary', async () => {
  let calls = 0;
  const loaded = await loadServerRuntime({
    purpose: 'inspect',
    env: {},
    home: '/fixture/home',
    deps: {
      readText: async (file) => file.endsWith('runtime.json') ? JSON.stringify({
        version: 4,
        kind: 'binary',
        binary: '/fixture/bin/grigdesk-server',
        home: '/fixture/data',
        cliPaths: [],
      }) : 'GRIGDESK_PORT=9311\n',
      exists: async () => false,
      nodeVersion: async () => null,
      checkRelease: async () => false,
      prepareBinary: async () => {
        calls += 1;

        throw new Error('inspect не должен готовить runtime');
      },
    },
  });

  assert.equal(calls, 0);
  assert.equal(loaded.inspection.origin, 'http://127.0.0.1:9311');
  assert.equal('runtime' in loaded, false);
});
