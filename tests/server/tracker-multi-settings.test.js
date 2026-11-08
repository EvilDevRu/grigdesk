import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createTrackerRuntime } from '../../server/src/lib/trackers/runtime.ts';
import { TrackerSettingsStore } from '../../server/src/lib/trackers/settingsStore.ts';
import { trackerFixture, writeTracker } from './helpers/trackerFixture.js';
import { IDS, driverContext, multiFixture, saveMulti } from './helpers/trackerMulti.js';

test('MD-SELECTION: новый выбор включает A+B, публикует default и legacy SSE alias', async (t) => {
  const fixture = await multiFixture(t);
  const saved = await saveMulti(fixture, IDS.slice(0, 2), 'fixture-b');

  assert.equal(saved.statusCode, 200, saved.body);

  const catalog = (await fixture.request('GET', '/api/trackers')).json();
  const settings = (await fixture.request('GET', '/api/trackers/settings')).json();
  const disk = JSON.parse(await readFile(fixture.config.trackerSettingsPath, 'utf8'));
  const event = fixture.events.filter((item) => item.name === 'trackers-changed').at(-1);

  assert.deepEqual(catalog.enabledIds, IDS.slice(0, 2));
  assert.equal(catalog.default, 'fixture-b');
  assert.equal(catalog.externalId, 'fixture-b');
  assert.deepEqual([...catalog.activeIds].sort(), ['fixture-a', 'fixture-b', 'own']);
  assert.ok(catalog.drivers.every((entry) => typeof entry.id === 'string'));
  assert.deepEqual(settings.drivers, IDS.slice(0, 2));
  assert.equal(settings.default, 'fixture-b');
  assert.deepEqual(disk.drivers, settings.drivers);
  assert.equal(disk.default, settings.default);
  assert.equal((await stat(fixture.config.trackerSettingsPath)).mode & 0o777, 0o600);
  assert.equal(event.payload.externalId, 'fixture-b');
  assert.equal(event.payload.revision, settings.revision);
});

for (const legacy of [
  { externalId: 'fixture-a', revision: 7 },
  { externalId: 'fixture-a' },
  { externalId: null, revision: 3 },
]) {
  test(`MD-MIGRATE: ${JSON.stringify(legacy)} сохраняется после повторного runtime`, async (t) => {
    let fixture;

    await assert.doesNotReject(async () => {
      fixture = await trackerFixture(t, {
        setup: async (config) => {
          await writeTracker(config, 'fixture-a');
          await mkdir(path.dirname(config.trackerSettingsPath), { recursive: true });
          await writeFile(config.trackerSettingsPath, JSON.stringify(legacy));
        },
      });
    }, 'Legacy-файл является допустимым входом миграции, включая отсутствие revision');

    const expected = legacy.externalId ? ['fixture-a'] : [];
    const catalog = fixture.runtime.catalog();

    assert.deepEqual(catalog.enabledIds, expected);
    assert.equal(catalog.default, legacy.externalId);
    assert.equal(catalog.revision, legacy.revision ?? 0);

    const canonical = JSON.parse(await readFile(fixture.config.trackerSettingsPath, 'utf8'));

    assert.deepEqual(canonical.drivers, expected);
    assert.equal(canonical.default, legacy.externalId);
    assert.equal((await stat(fixture.config.trackerSettingsPath)).mode & 0o777, 0o600);
    await fixture.runtime.close();

    const restarted = await createTrackerRuntime({
      ...fixture.moduleOptions,
      config: fixture.config,
      credsStore: fixture.credsStore,
    });

    try {
      assert.deepEqual(restarted.catalog().enabledIds, expected);
      assert.equal(restarted.catalog().default, legacy.externalId);
    } finally {
      await restarted.close();
    }
  });
}

test('MD-DEFAULT: выключение default выбирает первый оставшийся, затем null', async (t) => {
  const fixture = await multiFixture(t, { ids: IDS });

  for (const [drivers, requested, expected] of [
    [IDS, 'fixture-a', 'fixture-a'],
    [IDS.slice(1), null, 'fixture-b'],
    [IDS.slice(2), null, 'fixture-c'],
    [[], null, null],
  ]) {
    const response = await saveMulti(fixture, drivers, requested);

    assert.equal(response.statusCode, 200, response.body);
    assert.equal((await fixture.request('GET', '/api/trackers')).json().default, expected);
  }
});

test('MD-GENERATIONS: изменение B и пустой draft A сохраняют контекст A', async (t) => {
  const fixture = await multiFixture(t);
  const a = await driverContext(fixture, 'fixture-a');
  const b = await driverContext(fixture, 'fixture-b');
  const response = await saveMulti(fixture, IDS.slice(0, 2), 'fixture-a', {
    'fixture-a': {},
    'fixture-b': { endpoint: 'https://new-b.fixture' },
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(await driverContext(fixture, 'fixture-a'), a);
  assert.notEqual((await driverContext(fixture, 'fixture-b')).generation, b.generation);
  assert.notEqual((await driverContext(fixture, 'fixture-b')).source, b.source);
});

test('MD-SELECTION: массив read не изменяет сохранённый выбор', async (t) => {
  const fixture = await multiFixture(t);
  const response = await saveMulti(fixture, IDS.slice(0, 2), 'fixture-b');

  assert.equal(response.statusCode, 200, response.body);

  const store = new TrackerSettingsStore(fixture.config.trackerSettingsPath);
  const copy = store.read();

  copy.drivers.pop();
  assert.deepEqual(store.read().drivers, IDS.slice(0, 2));
});
