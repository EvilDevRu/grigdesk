import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { trackerCalls, trackerFixture, selectTracker, writeTracker } from './helpers/trackerFixture.js';

const pair = async (config) => {
  await writeTracker(config, 'fixture-a');
  await writeTracker(config, 'fixture-b');
};

test('TRACKER-REGISTRY-01: own постоянно активен, доска выбирает один внешний', async (t) => {
  const fixture = await trackerFixture(t, { setup: pair });
  const initial = await fixture.request('GET', '/api/trackers');

  assert.equal(initial.statusCode, 200);
  assert.equal((await fixture.request('GET', '/api/b24/dashboard')).statusCode, 404);
  assert.deepEqual(initial.json().activeIds, ['own']);
  assert.equal(initial.json().externalId, null);
  assert.deepEqual(initial.json().drivers.map((driver) => driver.id).sort(),
    ['fixture-a', 'fixture-b', 'own']);

  await selectTracker(fixture, 'fixture-a');
  await selectTracker(fixture, 'fixture-b');

  const selected = (await fixture.request('GET', '/api/trackers')).json();

  assert.deepEqual([...selected.activeIds].sort(), ['fixture-b', 'own']);
  assert.equal(selected.externalId, 'fixture-b');
});

test('TRACKER-REGISTRY-01: внутренний registry допускает own+A+B и TaskRef различает id', async (t) => {
  const fixture = await trackerFixture(t, { setup: pair });
  const catalog = await fixture.request('GET', '/api/trackers');

  assert.equal(catalog.statusCode, 200);

  const registry = fixture.runtime.registry;

  await registry.activate('fixture-a');
  await registry.activate('fixture-b');

  const a = await registry.taskDetail({ trackerId: 'fixture-a', id: '42' });
  const b = await registry.taskDetail({ trackerId: 'fixture-b', id: '42' });

  assert.equal(a.title, 'fixture-a');
  assert.equal(b.title, 'fixture-b');
  assert.ok(registry.activeIds.includes('own'));
  assert.ok(registry.activeIds.includes('fixture-a'));
  assert.ok(registry.activeIds.includes('fixture-b'));
});

test('TRACKER-CONSUMERS-01: прежний HTTP и identity используют выбранный B', async (t) => {
  const fixture = await trackerFixture(t, { setup: pair });

  await selectTracker(fixture, 'fixture-a');
  await selectTracker(fixture, 'fixture-b');

  const detail = await fixture.request('GET', '/api/tracker/task/42');
  const created = await fixture.request('POST', '/api/tracker/tasks', { title: 'Новая' });

  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().title, 'fixture-b');
  assert.equal(created.statusCode, 200);
  assert.deepEqual(await fixture.tracker.accountIdentity(), {
    baseUrl: 'https://tracker.fixture', userId: '7',
  });
  assert.deepEqual(await trackerCalls(fixture.config, 'fixture-a'), []);
  assert.deepEqual((await trackerCalls(fixture.config, 'fixture-b')).map((call) => call.method), [
    'taskDetail', 'createTask', 'accountIdentity',
  ]);
});

test('TRACKER-REGISTRY-02 / B-MIGRATION-01: старый файл реквизитов полностью игнорируется',
  async (t) => {
    const fixture = await trackerFixture(t, { legacy: true });
    const catalog = await fixture.request('GET', '/api/trackers');

    assert.equal(catalog.statusCode, 200);
    assert.equal(catalog.json().externalId, null);
    assert.deepEqual(catalog.json().activeIds, ['own']);
    assert.deepEqual(catalog.json().drivers.map((driver) => driver.id).sort(), ['own']);

    const dashboard = await fixture.request('GET', '/api/tracker/dashboard');

    assert.equal(dashboard.statusCode, 400);
    assert.equal(dashboard.json().error, 'tracker_unavailable');

    assert.equal(existsSync(fixture.config.trackerCredentialsPath), false);

    const previous = JSON.parse(await readFile(path.join(fixture.root, 'state/b24-creds.json'), 'utf8'));

    assert.equal(previous.login, 'fixture-user');
    assert.equal(previous.password, 'fixture-password');
  });

for (const kind of ['corrupt', 'contract', 'duplicate', 'shadow', 'symlink']) {
  test(`TRACKER-REGISTRY-02: ${kind} не исполняется и не отключает own`, async (t) => {
    const fixture = await trackerFixture(t, {
      setup: async (config) => {
        const id = kind === 'shadow' ? 'own' : 'invalid-driver';
        const directory = await writeTracker(config, id, {
          manifest: kind === 'contract' ? { contract: 99 } : {},
        });

        if (kind === 'corrupt') {
          await writeFile(path.join(directory, 'driver.json'), '{bad json');
        }

        if (kind === 'duplicate') {
          await writeTracker(config, 'other-directory', { manifest: { id } });
        }

        if (kind === 'symlink') {
          await mkdir(path.join(config.driversDir, 'linked'));
          await symlink(path.join(directory, 'driver.ts'), path.join(config.driversDir, 'linked/driver.ts'));
          await writeFile(path.join(config.driversDir, 'linked/driver.json'), JSON.stringify({
            id: 'linked',
            name: 'Ссылка',
            version: '1.0.0',
            contract: 1,
            settings: {},
          }));
        }
      },
    });
    const catalog = await fixture.request('GET', '/api/trackers');

    assert.equal(catalog.statusCode, 200);
    assert.ok(catalog.json().activeIds.includes('own'));

    if (kind !== 'shadow') {
      const externalId = kind === 'symlink' ? 'linked' : 'invalid-driver';
      const selection = await fixture.request('POST', '/api/trackers/settings', {
        externalId,
        expectedRevision: catalog.json().revision,
      });
      const after = (await fixture.request('GET', '/api/trackers')).json();
      const rejected = after.drivers.find((driver) => driver.id === externalId);

      assert.ok([200, 400, 409].includes(selection.statusCode));
      assert.equal(rejected.status, 'unavailable');
      assert.ok(rejected.reason || rejected.error);
      assert.equal(after.activeIds.includes(externalId), false);
      assert.equal(existsSync(path.join(fixture.config.driversDir, externalId, 'imported')), false);
    }

    if (kind !== 'symlink') {
      const id = kind === 'shadow' ? 'own' : 'invalid-driver';

      assert.equal(existsSync(path.join(fixture.config.driversDir, id, 'imported')), false);
    }

    const own = await fixture.app.inject({
      method: 'GET',
      url: '/api/grigdesk-tasks',
      headers: fixture.headers,
    });

    assert.equal(own.statusCode, 200);
    assert.deepEqual(own.json().tasks, []);
  });
}

test('TRACKER-NUMBER-01: missing selected driver не доказывает отсутствие номера', async (t) => {
  const fixture = await trackerFixture(t, {
    setup: async (config) => {
      await mkdir(path.dirname(config.trackerSettingsPath), { recursive: true });
      await writeFile(config.trackerSettingsPath, JSON.stringify({
        externalId: 'missing-driver',
        revision: 1,
      }));
    },
  });
  const catalog = await fixture.request('GET', '/api/trackers');

  assert.equal(catalog.statusCode, 200);

  const response = await fixture.request('POST', '/api/grigdesk-tasks', {
    title: 'Своя задача',
    description: 'Текст',
    projectId: 'beta',
    clientOrigin: 'http://client.test',
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error, 'task_number_unverified');

  await selectTracker(fixture, null);

  const local = await fixture.request('POST', '/api/grigdesk-tasks', {
    title: 'Своя задача',
    description: 'Текст',
    projectId: 'beta',
    clientOrigin: 'http://client.test',
  });

  assert.equal(local.statusCode, 201);
});
