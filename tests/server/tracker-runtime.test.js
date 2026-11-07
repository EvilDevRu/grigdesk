import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { importRuntimeModule } from '../../server/src/lib/runtimeImport.ts';
import { selectTracker, trackerCalls, trackerFixture, writeTracker } from './helpers/trackerFixture.js';

for (const outcome of ['installed', 'reverted', 'blocked']) {
  test(`DRIVER-RUNTIME-01: lease drain и ${outcome} управляют admission`, async (t) => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const globalName = `__trackerLease${outcome}`;
    const calls = [];
    const fixture = await trackerFixture(t, {
      setup: async (config) => {
        await writeTracker(config, 'fixture-driver', {
          code: `export default () => globalThis.${globalName};`,
        });
      },
    });

    globalThis[globalName] = {
      id: 'fixture-driver',
      capabilities: { create: true },
      isConfigured: () => true,
      /**
       * Единственный принятый вызов удерживается на границе драйвера.
       * Lease обязан дождаться его завершения перед разрешением замены пакета.
       */
      async taskDetail(id) {
        calls.push(id);
        entered.resolve();
        await release.promise;

        return { id, title: 'Принятый вызов' };
      },
      dispose: async () => {},
    };
    t.after(() => {
      release.resolve();
      delete globalThis[globalName];
    });
    await selectTracker(fixture, 'fixture-driver');

    const registry = fixture.runtime.registry;
    const accepted = fixture.tracker.taskDetail('42');

    await entered.promise;

    let drained = false;
    const replacing = registry.prepareReplace('fixture-driver', new AbortController().signal)
      .then((lease) => {
        drained = true;

        return lease;
      });

    await Promise.resolve();
    assert.equal(drained, false);
    release.resolve();
    assert.equal((await accepted).title, 'Принятый вызов');

    const lease = await replacing;

    assert.equal(registry.isLoaded('fixture-driver'), true);
    await lease.finish(outcome);
    await registry.refresh();
    assert.equal(registry.isLoaded('fixture-driver'), true);

    if (outcome === 'reverted') {
      assert.equal((await fixture.tracker.taskDetail('43')).title, 'Принятый вызов');
      assert.deepEqual(calls, ['42', '43']);
    } else {
      await assert.rejects(fixture.tracker.taskDetail('43'));
      assert.deepEqual(calls, ['42']);

      const catalog = (await fixture.request('GET', '/api/trackers')).json();
      const descriptor = catalog.drivers.find((driver) => driver.id === 'fixture-driver');

      assert.equal(descriptor.status, outcome === 'installed' ? 'restartRequired' : 'unavailable');
      assert.ok(catalog.activeIds.includes('own'));
    }
  });
}

test('DRIVER-RUNTIME-01: неудачный import тоже sticky loaded и не повторяется после refresh', async (t) => {
  const name = '__trackerImportAttempts';

  globalThis[name] = 0;
  t.after(() => delete globalThis[name]);

  const fixture = await trackerFixture(t, {
    setup: (config) => writeTracker(config, 'broken-driver', {
      code: `globalThis.${name} += 1; throw new Error('fixture import failed'); export default () => ({});`,
    }),
  });
  const catalog = await fixture.request('GET', '/api/trackers');

  assert.equal(catalog.statusCode, 200);
  await fixture.request('POST', '/api/trackers/settings', {
    externalId: 'broken-driver', expectedRevision: catalog.json().revision,
  });
  assert.equal(globalThis[name], 1);
  assert.equal(fixture.runtime.registry.isLoaded('broken-driver'), true);
  await fixture.runtime.registry.refresh();
  assert.equal(globalThis[name], 1);
});

test('DRIVER-RUNTIME-01: source и SEA bridge импортируют один driver.ts без сборки', async (t) => {
  const fixture = await trackerFixture(t);
  const directory = path.join(fixture.root, 'package with space');
  const bridgeDir = path.join(fixture.root, 'server/runtime');
  const file = path.join(directory, 'driver.ts');

  await mkdir(directory);
  await mkdir(bridgeDir, { recursive: true });
  await writeFile(file, 'export default () => ({ id: "fixture-driver" });');
  await writeFile(path.join(fixture.root, 'server/package.json'), '{}');
  await writeFile(path.join(bridgeDir, 'esmBridge.cjs'), 'exports.importUrl = (url) => import(url);');

  const source = await importRuntimeModule(file, { kind: 'source', root: fixture.root });
  const sea = await importRuntimeModule(file, { kind: 'packaged', root: fixture.root });

  assert.equal(source.default().id, 'fixture-driver');
  assert.equal(sea, source);
});


test('TRACKER-DELETE-01: неподдерживаемое удаление отклонено до вызова драйвера', async (t) => {
  const fixture = await trackerFixture(t, {
    setup: (config) => writeTracker(config, 'fixture-driver'),
  });

  await selectTracker(fixture, 'fixture-driver');

  const before = await trackerCalls(fixture.config, 'fixture-driver');
  const response = await fixture.request('DELETE', '/api/tracker/task/42');

  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().error, 'unsupported');
  assert.deepEqual(await trackerCalls(fixture.config, 'fixture-driver'), before);
  await assert.rejects(fixture.tracker.deleteTask('42'), { code: 'unsupported', status: 400 });
});

test('TRACKER-DELETE-02: маршрут вызывает deleteTask выбранного драйвера ровно один раз', async (t) => {
  const fixture = await trackerFixture(t, {
    setup: (config) => writeTracker(config, 'fixture-driver', {
      code: `import { appendFileSync } from 'node:fs';
        export default () => ({
          id: 'fixture-driver',
          capabilities: { delete: true },
          isConfigured: () => true,
          taskDetail: async (id) => ({ id, title: 'Задача' }),
          deleteTask: async (id) => {
            appendFileSync(new URL('./calls.jsonl', import.meta.url),
              JSON.stringify({ method: 'deleteTask', args: [id] }) + '\\n');
            return { ok: true };
          },
        });`,
    }),
  });
  const catalog = await selectTracker(fixture, 'fixture-driver');
  const response = await fixture.request('DELETE', '/api/tracker/task/42', undefined, {
    'x-grigdesk-tracker-generation': String(catalog.revision),
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { ok: true });
  assert.deepEqual(await trackerCalls(fixture.config, 'fixture-driver'), [
    { method: 'deleteTask', args: ['42'] },
  ]);

  const stale = await fixture.request('DELETE', '/api/tracker/task/42', undefined, {
    'x-grigdesk-tracker-generation': String(catalog.revision - 1),
  });
  const invalid = await fixture.request('DELETE', '/api/tracker/task/invalid');

  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error, 'tracker_context_changed');
  assert.equal(invalid.statusCode, 400);
  assert.equal((await trackerCalls(fixture.config, 'fixture-driver')).length, 1);
});
