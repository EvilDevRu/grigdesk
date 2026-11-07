import assert from 'node:assert/strict';
import test from 'node:test';

import { installedRecord as fixtureRecord } from './helpers/pluginInstallState.js';
import { installHttpFixture } from './helpers/pluginInstallHttpFixture.js';

const base = '/api/plugin-installs';

test('HTTP: awaiting_restart возвращается как подтверждённый исход apply и current', async (t) => {
  const fixture = await installHttpFixture(t);
  const queued = { ...fixture.stub.job, status: 'awaiting_restart' };

  fixture.installs.apply = async () => queued;
  fixture.installs.currentJob = async () => queued;

  const apply = await fixture.app.inject({
    method: 'POST',
    url: `${base}/jobs/${queued.id}/apply`,
    payload: { reviewToken: queued.reviewToken },
    headers: fixture.session,
  });
  const current = await fixture.app.inject({
    url: `${base}/jobs/current`,
    headers: fixture.session,
  });

  assert.equal(apply.statusCode, 200);
  assert.equal(apply.json().job.status, 'awaiting_restart');
  assert.equal(current.json().job.status, 'awaiting_restart');
});

test('R2: versions закрыт локальным strict AJV, production defaults прежних routes сохранены', async (t) => {
  const fixture = await installHttpFixture(t, {
    configure: (app) => {
      app.post('/api/legacy', {
        schema: { body: {
          type: 'object',
          properties: { flag: { type: 'boolean' } },
          required: ['flag'],
          additionalProperties: false,
        } },
      }, async (request) => request.body);
    },
  });
  const input = { url: 'file:///fixture-plugin.git' };
  const valid = await fixture.app.inject({
    method: 'POST',
    url: base + '/versions',
    payload: input,
    headers: fixture.session,
  });

  assert.equal(valid.statusCode, 200);
  assert.equal(valid.json().versions.length, 1);

  const extra = await fixture.app.inject({
    method: 'POST',
    url: base + '/versions',
    payload: { ...input, unknown: true },
    headers: fixture.session,
  });

  assert.equal(extra.statusCode, 400, 'additionalProperties нельзя молча удалить');
  assert.equal(fixture.stub.calls.length, 1);

  const legacy = await fixture.app.inject({
    method: 'POST',
    url: '/api/legacy',
    payload: { flag: 'true', unknown: true },
    headers: fixture.session,
  });

  assert.equal(legacy.statusCode, 200);
  assert.deepEqual(legacy.json(), { flag: true });
});

test('R3: строгие inputs/params без coercion, unknown полей и prototype id', async (t) => {
  const fixture = await installHttpFixture(t);
  const id = fixture.stub.job.id;
  const validRollback = {
    requestId: '00000000-0000-4000-8000-000000000002',
    expectedRevision: 1,
    expectedPreviousDigest: 'b'.repeat(64),
  };
  const cases = [
    ['/jobs', {}], ['/jobs', { url: 42 }], ['/jobs', { url: '' }], ['/jobs', { url: 'x'.repeat(513) }],
    ['/jobs', { url: 'file:///fixture', version: 'v1.0.0' }],
    ['/jobs', { url: 'file:///fixture', version: '1.0.0-beta' }],
    ['/jobs', { url: 'file:///fixture', replaceModified: 'true' }],
    ['/jobs', { url: 'file:///fixture', expectedId: '../bad' }],
    ['/jobs', { url: 'file:///fixture', expectedId: '__proto__' }],
    ['/jobs', { url: 'file:///fixture', expectedId: 'constructor' }],
    ['/jobs', { url: 'file:///fixture', unknown: true }],
    [`/jobs/${id}/apply`, {}], [`/jobs/${id}/apply`, { reviewToken: 'a'.repeat(63) }],
    [`/jobs/${id}/apply`, { reviewToken: 'z'.repeat(64) }],
    ['/jobs/not-a-uuid/cancel', {}], [`/jobs/${id}/cancel`, { extra: true }],
    ['/plugins/demo/update', { version: '01.2.3' }], ['/plugins/demo/update', { replaceModified: 1 }],
    ['/plugins/constructor/update', {}], ['/plugins/demo/update', { url: 'file:///fixture' }],
    ['/plugins/demo/rollback', {}],
    ['/plugins/demo/rollback', { ...validRollback, requestId: 'bad' }],
    ['/plugins/demo/rollback', { ...validRollback, expectedRevision: '1' }],
    ['/plugins/demo/rollback', { ...validRollback, expectedRevision: -1 }],
    ['/plugins/demo/rollback', { ...validRollback, expectedRevision: 1.5 }],
    ['/plugins/demo/rollback', { ...validRollback, expectedRevision: Number.MAX_SAFE_INTEGER + 1 }],
    ['/plugins/demo/rollback', { ...validRollback, expectedPreviousDigest: 'bad' }],
    ['/check', { extra: true }],
  ];

  for (const [url, payload] of cases) {
    const response = await fixture.app.inject({
      method: 'POST',
      url: base + url,
      payload,
      headers: fixture.session,
    });

    assert.equal(response.statusCode, 400, JSON.stringify({
      url,
      payload,
      body: response.body,
    }));
  }

  const badGet = await fixture.app.inject({ url: base + '/jobs/invalid', headers: fixture.cli });

  assert.equal(badGet.statusCode, 400);
  assert.equal(fixture.stub.calls.length, 0);
});

test('R4: PluginInstallError сохраняет status/code/message, health отдельно', async (t) => {
  const { installError } = await import('../../server/src/lib/packageInstall/errors.ts');
  const fixture = await installHttpFixture(t);

  for (const code of ['source_url_invalid', 'plugin_busy', 'recovery_required', 'state_invalid']) {
    const error = installError(code);

    fixture.installs.listVersions = async () => {
      throw error;
    };

    const response = await fixture.app.inject({
      method: 'POST',
      url: base + '/versions',
      payload: { url: 'file:///fixture' },
      headers: fixture.session,
    });

    assert.equal(response.statusCode, error.statusCode);
    assert.deepEqual(response.json(), { error: code, message: error.message });
  }

  fixture.installs.health = () => ({ code: 'state_invalid', message: 'Состояние повреждено.' });

  const current = await fixture.app.inject({ url: base + '/jobs/current', headers: fixture.session });

  assert.equal(current.statusCode, 200);
  assert.equal(current.json().recoveryError.code, 'state_invalid');
});

test('R5: неизвестная Error с fixture-secret не попадает в body или server log', async (t) => {
  const fixture = await installHttpFixture(t, { captureLogs: true });

  fixture.installs.listVersions = async () => {
    throw new Error('fixture-secret private command output');
  };

  const response = await fixture.app.inject({
    method: 'POST',
    url: base + '/versions',
    payload: { url: 'file:///fixture' },
    headers: fixture.session,
  });

  assert.equal(response.statusCode, 500);
  assert.equal(response.json().error, 'internal');
  assert.equal(response.body.includes('fixture-secret'), false);
  assert.equal(fixture.logs.join('').includes('fixture-secret'), false);
});

test('R6: API передаёт token/rollback preconditions и возвращает job с HTTP202 для подготовки', async (t) => {
  const fixture = await installHttpFixture(t);
  const id = fixture.stub.job.id;
  const rollback = {
    requestId: '00000000-0000-4000-8000-000000000006',
    expectedRevision: 7,
    expectedPreviousDigest: 'b'.repeat(64),
  };
  const cases = [
    ['/jobs', {
      url: 'file:///fixture',
      version: '1.1.0',
      expectedId: 'demo',
      replaceModified: true,
    }, 202],
    ['/plugins/demo/update', { version: '1.1.0', replaceModified: true }, 202],
    [`/jobs/${id}/apply`, { reviewToken: 'd'.repeat(64) }, 200],
    [`/jobs/${id}/cancel`, {}, 200],
    ['/plugins/demo/rollback', rollback, 200],
    ['/check', {}, 200],
  ];

  for (const [url, payload, status] of cases) {
    const response = await fixture.app.inject({
      method: 'POST',
      url: base + url,
      payload,
      headers: fixture.session,
    });

    assert.equal(response.statusCode, status);
    assert.equal(Object.hasOwn(response.json(), url === '/check' ? 'plugins' : 'job'), true);
    assert.equal(Object.hasOwn(response.json(), 'install'), false);
  }

  assert.deepEqual(fixture.stub.calls.map((call) => call.args), [
    [cases[0][1]], ['demo', cases[1][1]], [id, 'd'.repeat(64)], [id], ['demo', rollback], [],
  ]);

  const current = await fixture.app.inject({ url: base + '/jobs/current', headers: fixture.session });

  assert.deepEqual(current.json(), { job: fixture.stub.job, recoveryError: null });
});

test('R7: каталог отдаёт install только user, без installs сохраняется API и installer404', async (t) => {
  const { writeHttpPlugin } = await import('./helpers/pluginInstallHttpFixture.js');

  for (const withoutInstalls of [false, true]) {
    const fixture = await installHttpFixture(t, {
      withPlugins: true,
      withoutInstalls,
      setup: async ({ pluginsDir, installs }) => {
        await writeHttpPlugin(pluginsDir, 'demo');
        installs.describe = async () => ({
          ...fixtureRecord(),
          updateAvailable: false,
          localChanges: false,
          restartRequired: false,
          rollbackAvailable: false,
          rollbackError: null,
        });
      },
    });
    const response = await fixture.app.inject({ url: '/api/plugins', headers: fixture.session });
    const plugins = response.json().plugins;

    assert.equal(response.statusCode, 200);
    assert.equal(plugins.find((plugin) => plugin.id === 'code').install, null);
    assert.equal(plugins.find((plugin) => plugin.id === 'demo').install?.version ?? null,
      withoutInstalls ? null : '1.0.0');
    assert.equal(plugins.find((plugin) => plugin.id === 'demo').enabled, false);
    assert.equal((await fixture.app.inject({ url: base + '/jobs/current', headers: fixture.session }))
      .statusCode,
      withoutInstalls ? 404 : 200);
    assert.equal((await fixture.app.inject({
      method: 'POST',
      url: '/api/plugins/demo/toggle',
      payload: { enabled: true },
      headers: fixture.session,
    })).statusCode, 200);
  }
});

/**
 * Native transaction barrier фиксирует границу между закрытием runtime и rename.
 * Владельцем held promise является fixture, который освобождает его в finally.
 */
function runtimeBarrier() {
  let release;
  const promise = new Promise((resolve) => release = resolve);

  return { promise, release };
}

test('R8: Git/service закрывает API/static до rename и удерживает blocked', async (t) => {
  const { createPluginRepo } = await import('./helpers/pluginRepo.js');
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');

  for (const blocked of [false, true]) {
    const repo = await createPluginRepo(t);
    const key = `fixture_runtime_${path.basename(repo.root)}`;
    const entered = runtimeBarrier();
    const held = runtimeBarrier();
    const controls = {
      entered,
      held,
      finishes: [],
    };
    const server = `export default async function plugin(app, options) {
      options.lifecycle.prepareReplace = async () => {
        const controls = globalThis[${JSON.stringify(key)}];
        controls.entered.release();
        await controls.held.promise;
        return { async finish(outcome) { controls.finishes.push(outcome); } };
      };
      app.get('/value', async () => ({ version: 'old' }));
    }`;

    globalThis[key] = controls;
    await repo.release('1.0.0', { manifest: { web: 'web' }, files: {
      'web/index.html': 'old static',
      'server.js': server,
    } });

    const fixture = await installHttpFixture(t, {
      withPlugins: true,
      realService: true,
      blockedClose: blocked,
      prefs: { plugins: { demo: true } },
      setup: async ({ installs }) => {
        await installs.recover();
        installs.bindRuntime({
          isLoaded: () => false,
          prepareReplace: async () => ({ async finish() {} }),
          refresh: async () => {},
        });
        await installs.startInstall({ url: repo.url, version: '1.0.0' });
        await installs.whenIdle();

        const ready = await installs.currentJob();

        assert.equal((await installs.apply(ready.id, ready.reviewToken)).status, 'done');
      },
    });

    assert.equal((await fixture.app.inject({ url: '/api/ext/demo/value', headers: fixture.session }))
      .statusCode, 200);
    assert.equal((await fixture.app.inject({ url: '/api/ext/demo/web/', headers: fixture.session }))
      .statusCode, 200);
    await repo.release('1.1.0', { manifest: { web: 'web' }, files: {
      'web/index.html': 'new static',
      'server.js': server,
    } });
    await fixture.installs.startUpdate('demo');
    await fixture.installs.whenIdle();

    const ready = await fixture.installs.currentJob();
    const native = fixture.installs.filesystem();
    const rename = native.rename;
    const current = path.join(fixture.pluginsDir, 'demo');
    const before = await readFile(path.join(current, 'web/index.html'), 'utf8');
    let renames = 0;

    native.rename = async (from, to) => {
      renames += 1;

      if (blocked && to === current) {
        throw Object.assign(new Error('fixture blocked rename'), { code: 'EIO' });
      }

      await rename(from, to);
    };
    fixture.installs.filesystem = () => native;

    const applying = fixture.app.inject({
      method: 'POST',
      url: `${base}/jobs/${ready.id}/apply`,
      payload: { reviewToken: ready.reviewToken },
      headers: fixture.session,
    });

    await entered.promise;

    try {
      for (const url of ['/api/ext/demo/value', '/api/ext/demo/web/']) {
        const response = await fixture.app.inject({ url, headers: fixture.session });

        assert.equal(response.statusCode, 409);
        assert.equal(response.json().error, 'plugin_replacing');
      }

      assert.equal(renames, 0);
      assert.equal(await readFile(path.join(current, 'web/index.html'), 'utf8'), before);
    } finally {
      held.release();
    }

    const result = await applying;

    assert.equal(result.statusCode, 200);
    assert.equal(result.json().job.status, blocked ? 'recovery_required' : 'done');
    assert.deepEqual(controls.finishes, [blocked ? 'blocked' : 'installed']);

    for (const url of ['/api/ext/demo/value', '/api/ext/demo/web/']) {
      const response = await fixture.app.inject({ url, headers: fixture.session });

      assert.equal(response.statusCode, blocked ? 503 : 200);

      if (blocked) {
        assert.equal(response.json().error, 'recovery_required');
      } else if (url.endsWith('/web/')) {
        assert.equal(response.body, 'new static');
      }
    }

    delete globalThis[key];
  }
});

test('R9: dataDir0700 вне заменяемого дерева, same lifecycle, loaded static/server и dormant', async (t) => {
  const { writeHttpPlugin } = await import('./helpers/pluginInstallHttpFixture.js');
  const { lstat, mkdir, symlink } = await import('node:fs/promises');
  const path = await import('node:path');
  const key = 'fixture_plugin_lifecycle';
  const fixture = await installHttpFixture(t, {
    withPlugins: true,
    prefs: { plugins: { demo: true, page: true } },
    setup: async ({ pluginsDir }) => {
      await writeHttpPlugin(pluginsDir, 'demo', {}, { 'server.js': `
        export default async function plugin(app, options) {
          globalThis.${key} = options.lifecycle;
          app.get('/data', async () => ({ dataDir: options.dataDir }));
        }
      ` });
      await writeHttpPlugin(pluginsDir, 'page', { web: 'web' }, { 'web/index.html': 'page' });
      await writeHttpPlugin(pluginsDir, 'sleeper', { web: 'web' }, { 'web/index.html': 'sleep' });
    },
  });
  const data = path.join(fixture.userPluginsDataDir, 'demo');
  const info = await lstat(data).catch(() => null);

  assert.equal(Boolean(info?.isDirectory()), true, 'dataDir создан до server import');
  assert.equal(info.mode & 0o777, 0o700);
  assert.equal(path.relative(fixture.pluginsDir, data).startsWith('..'), true);
  assert.equal((await fixture.app.inject({ url: '/api/ext/demo/data', headers: fixture.session }))
    .json().dataDir,
    data);
  assert.equal(fixture.installs.runtime.isLoaded('demo'), true);
  assert.equal(fixture.installs.runtime.isLoaded('page'), true);
  assert.equal(fixture.installs.runtime.isLoaded('sleeper'), false);
  globalThis[key].busyReason = async () => 'fixture busy';
  await assert.rejects(fixture.installs.runtime.prepareReplace('demo', new AbortController().signal),
    { code: 'plugin_busy' });
  globalThis[key].busyReason = null;
  globalThis[key].prepareReplace = async () => ({ async finish() {} });
  await (await fixture.installs.runtime.prepareReplace('demo', new AbortController().signal))
    .finish('reverted');
  delete globalThis[key];

  for (const mode of ['inside', 'symlink', 'file']) {
    await assert.rejects(installHttpFixture(t, {
      withPlugins: true,
      setup: async ({ root, pluginsDir, config }) => {
        if (mode === 'inside') {
          config.userPluginsDataDir = path.join(pluginsDir, 'runtime-data');
        } else if (mode === 'symlink') {
          const target = path.join(root, 'outside');

          await mkdir(target);
          await symlink(target, path.join(root, 'link'));
          config.userPluginsDataDir = path.join(root, 'link/data');
        } else {
          await import('node:fs/promises').then(({ writeFile }) =>
            writeFile(path.join(root, 'file'), 'file'));
          config.userPluginsDataDir = path.join(root, 'file/data');
        }
      },
    }));
  }
});

test('R10: refresh атомарно меняет каталог/byId, новый server импортируется при включении', async (t) => {
  const { writeHttpPlugin } = await import('./helpers/pluginInstallHttpFixture.js');
  const { lstat, rename, symlink, unlink } = await import('node:fs/promises');
  const path = await import('node:path');
  const fixture = await installHttpFixture(t, {
    withPlugins: true,
    setup: async ({ pluginsDir }) => writeHttpPlugin(pluginsDir, 'demo'),
  });
  const marker = path.join(fixture.root, 'import-marker');

  await writeHttpPlugin(fixture.pluginsDir, 'added', {}, { 'server.js': `
    import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(marker)}, 'imported');
    export default async function plugin(app) { app.get('/value', async () => ({})); }
  ` });
  await fixture.installs.runtime.refresh();

  const list = await fixture.app.inject({ url: '/api/plugins', headers: fixture.session });
  const added = list.json().plugins.find((plugin) => plugin.id === 'added');

  assert.equal(Boolean(added), true);
  assert.equal(added.enabled, false);
  assert.equal(await lstat(marker).catch(() => null), null);
  assert.equal(fixture.installs.runtime.isLoaded('added'), false);
  assert.equal((await fixture.app.inject({
    method: 'POST',
    url: '/api/plugins/added/toggle',
    payload: { enabled: true },
    headers: fixture.session,
  })).statusCode, 200);
  assert.equal((await lstat(marker)).isFile(), true);
  assert.equal((await fixture.app.inject({
    url: '/api/ext/added/value', headers: fixture.session,
  })).statusCode, 200);

  const saved = path.join(fixture.root, 'saved-plugins');

  await rename(fixture.pluginsDir, saved);
  await symlink(saved, fixture.pluginsDir);

  try {
    await assert.rejects(fixture.installs.runtime.refresh());
    assert.equal((await fixture.app.inject({
      method: 'POST',
      url: '/api/plugins/added/toggle',
      payload: { enabled: false },
      headers: fixture.session,
    })).statusCode, 200);
    assert.equal((await fixture.app.inject({ url: '/api/plugins', headers: fixture.session }))
      .json().plugins.some((plugin) => plugin.id === 'added'), true,
      'неудачный scan не публикует полукаталог');
  } finally {
    await unlink(fixture.pluginsDir);
    await rename(saved, fixture.pluginsDir);
  }
});

test('R11: recover до scan, blocked user не импортирован, остальные и ядро работают', async (t) => {
  const { createApplyFixture } = await import('./helpers/pluginApplyFixture.js');
  const { writeHttpPlugin } = await import('./helpers/pluginInstallHttpFixture.js');
  const { lstat, mkdir, writeFile } = await import('node:fs/promises');
  const path = await import('node:path');

  for (const mode of ['recovered', 'blocked', 'bad-state']) {
    const fixture = await installHttpFixture(t, {
      withPlugins: true,
      realService: true,
      blockedClose: mode !== 'recovered',
      prefs: { plugins: { demo: true, other: true } },
      setup: async ({ root, pluginsDir, installs }) => {
        const native = await createApplyFixture(t, {
          root,
          workInside: true,
          kind: 'update',
          importMarker: true,
        });
        const state = await native.store.read();

        await native.fs.ensureDir(native.transaction);
        await native.fs.rename(native.current, path.join(native.transaction, 'parked'));
        state.apply = native.intent;
        state.job.status = 'applying';
        await writeFile(installs.options.statePath, JSON.stringify(state));

        if (mode !== 'recovered') {
          await mkdir(native.current);
          await writeFile(path.join(native.current, 'plugin.json'), '{"id":"demo","version":"2.0.0"}');
          await writeFile(path.join(native.current, 'server.js'), `
            import { writeFileSync } from 'node:fs';
            writeFileSync(${JSON.stringify(path.join(root, 'wrong-marker'))}, 'bad import');
            export default async function plugin() {}
          `);
        }

        if (mode === 'bad-state') {
          await writeFile(installs.options.statePath, '{invalid');
        }

        await writeHttpPlugin(pluginsDir, 'other', { web: 'web' }, { 'web/index.html': 'other available' });
      },
    });
    const catalog = await fixture.app.inject({ url: '/api/plugins', headers: fixture.session });

    assert.equal(catalog.statusCode, 200, 'health warning не ломает каталог ядра');

    const demo = catalog.json().plugins.find((plugin) => plugin.id === 'demo');
    const health = (await fixture.app.inject({ url: base + '/jobs/current', headers: fixture.session }))
      .json();

    if (mode === 'recovered') {
      assert.equal(demo?.version, '1.0.0', 'scan видит current, восстановленный из parked');
      assert.equal(health.job.status, 'failed');
      assert.equal(health.recoveryError, null);
      assert.equal((await lstat(path.join(fixture.root, 'import-marker'))).isFile(), true);
    } else {
      assert.equal(demo, undefined);
      assert.equal(await lstat(path.join(fixture.root, 'wrong-marker')).catch(() => null), null);
      assert.equal(await lstat(path.join(fixture.root, 'import-marker')).catch(() => null), null);
      assert.equal(health.recoveryError.code, mode === 'blocked' ? 'recovery_required' : 'state_invalid');
      assert.equal((await fixture.app.inject({ url: '/api/ext/other/web/', headers: fixture.session }))
    .statusCode,
        mode === 'blocked' ? 200 : 404);
    }

    assert.equal(catalog.json().plugins.some((plugin) => plugin.id === 'code'), true);
  }
});

test('R12: настоящий Git HTTP versions→jobs202→ready token→apply done→каталог без import', async (t) => {
  const { createPluginRepo } = await import('./helpers/pluginRepo.js');
  const { lstat, readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const repo = await createPluginRepo(t);
  const marker = path.join(repo.root, 'server-import-marker');

  await repo.release('1.0.0', { files: { 'server.js': `
    import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(marker)}, 'imported');
    export default async function plugin() {}
  ` } });

  const fixture = await installHttpFixture(t, { withPlugins: true, realService: true });
  const request = (url, payload) => fixture.app.inject({
    method: 'POST',
    url: base + url,
    payload,
    headers: fixture.session,
  });
  const versions = await request('/versions', { url: repo.url });

  assert.equal(versions.statusCode, 200);
  assert.equal(versions.json().versions[0].version, '1.0.0');

  const start = await request('/jobs', { url: repo.url });

  assert.equal(start.statusCode, 202);
  assert.equal(start.json().job.status, 'running');
  await fixture.installs.whenIdle();

  const current = await fixture.app.inject({ url: base + '/jobs/current', headers: fixture.session });
  const ready = current.json().job;

  assert.equal(ready.status, 'ready');
  assert.equal(ready.reviewToken.length, 64);
  assert.equal(await lstat(marker).catch(() => null), null);

  const done = await request(`/jobs/${ready.id}/apply`, { reviewToken: ready.reviewToken });

  assert.equal(done.statusCode, 200);
  assert.equal(done.json().job.status, 'done');

  const catalog = await fixture.app.inject({ url: '/api/plugins', headers: fixture.session });
  const demo = catalog.json().plugins.find((plugin) => plugin.id === 'demo');

  assert.equal(demo?.version, '1.0.0');
  assert.equal(demo.install.source.url, repo.url);
  assert.equal(demo.install.revision > 0, true);
  assert.equal(demo.install.restartRequired, false);
  assert.equal(demo.enabled, false);
  assert.equal(await lstat(marker).catch(() => null), null);

  const statePath = fixture.installs.options.statePath;
  const before = await readFile(statePath, 'utf8');
  const again = await request(`/jobs/${ready.id}/apply`, { reviewToken: ready.reviewToken });

  assert.deepEqual(again.json(), done.json());
  assert.equal(await readFile(statePath, 'utf8'), before);
});

test('R14: native HTTP теряет ответ после commit; jobById/receipt при активном B возвращают A', async (t) => {
  const { createPluginRepo } = await import('./helpers/pluginRepo.js');
  const { readFile } = await import('node:fs/promises');
  const http = await import('node:http');

  for (const rollback of [false, true]) {
    const repo = await createPluginRepo(t);
    const entered = runtimeBarrier();
    const held = runtimeBarrier();
    const bEntered = runtimeBarrier();
    const bHeld = runtimeBarrier();
    let armed = false;

    await repo.release('1.0.0');
    await repo.release('1.1.0');

    const fixture = await installHttpFixture(t, {
      withPlugins: true,
      realService: true,
      configure: (app) => {
        app.addHook('onSend', async (request, reply, payload) => {
          if (armed && reply.statusCode === 200 && /\/(apply|rollback)$/u.test(request.url)) {
            armed = false;
            entered.release();
            await held.promise;
          }

          return payload;
        });
      },
      setup: async ({ installs }) => {
        await installs.recover();
        installs.bindRuntime({
          isLoaded: () => false,
          prepareReplace: async () => ({ async finish() {} }),
          refresh: async () => {},
        });

        for (const version of ['1.0.0', '1.1.0']) {
          await installs.startInstall({ url: repo.url, version });
          await installs.whenIdle();

          const ready = await installs.currentJob();

          assert.equal((await installs.apply(ready.id, ready.reviewToken)).status, 'done');
        }
      },
    });
    const record = (await fixture.installs.store.read()).plugins.demo;
    let url;
    let input;

    if (rollback) {
      url = base + '/plugins/demo/rollback';
      input = {
        requestId: '00000000-0000-4000-8000-000000000014',
        expectedRevision: record.revision,
        expectedPreviousDigest: record.previous.payloadDigest,
      };
    } else {
      await repo.release('1.2.0');
      await fixture.installs.startUpdate('demo');
      await fixture.installs.whenIdle();

      const ready = await fixture.installs.currentJob();

      url = `${base}/jobs/${ready.id}/apply`;
      input = { reviewToken: ready.reviewToken };
    }

    const address = await fixture.app.listen({ host: '127.0.0.1', port: 0 });

    armed = true;

    const client = http.request(address + url, {
      method: 'POST',
      headers: { ...fixture.session, 'content-type': 'application/json' },
    });

    client.on('error', () => {});
    client.end(JSON.stringify(input));
    await entered.promise;

    const committed = await fixture.installs.store.read();
    const a = committed.job;
    const source = fixture.installs.sources.get('git');
    const originalFetch = source.fetch;

    try {
      assert.equal(a.status, 'done');
      assert.equal(committed.apply, null);

      if (rollback) {
        assert.equal(committed.lastRollback.demo.requestId, input.requestId);
      }

      const closed = new Promise((resolve) => client.once('close', resolve));

      client.destroy();
      await closed;
      held.release();
      source.fetch = async (request) => {
        bEntered.release();
        await bHeld.promise;
        await originalFetch(request);
      };

      const b = await fixture.installs.startInstall({
        url: repo.url,
        version: '1.0.0',
        replaceModified: true,
      });

      await bEntered.promise;

      const known = await fixture.app.inject({ url: `${base}/jobs/${a.id}`, headers: fixture.session });
      const current = await fixture.app.inject({ url: `${base}/jobs/current`, headers: fixture.session });
      const before = await readFile(fixture.installs.options.statePath, 'utf8');
      const again = await fixture.app.inject({
        method: 'POST',
        url,
        payload: input,
        headers: fixture.session,
      });

      assert.equal(known.statusCode, 200);
      assert.equal(known.json().job.id, a.id);
      assert.equal(known.json().job.status, 'done');
      assert.equal(current.json().job.id, b.id);
      assert.equal(current.json().job.status, 'running');
      assert.equal(again.statusCode, 200);
      assert.equal(again.json().job.id, a.id);
      assert.equal(await readFile(fixture.installs.options.statePath, 'utf8'), before);
      bHeld.release();
      await fixture.installs.cancel(b.id);
      source.fetch = originalFetch;

      const versions = await source.listVersions(repo.url);
      const originalList = source.listVersions;

      source.listVersions = async () => versions;

      for (let index = 0; index < 33; index += 1) {
        await fixture.installs.startInstall({ url: repo.url, version: '9.9.9' });
        await fixture.installs.whenIdle();
        assert.equal((await fixture.installs.currentJob()).status, 'failed');
      }

      source.listVersions = originalList;

      const forgotten = await fixture.app.inject({ url: `${base}/jobs/${a.id}`, headers: fixture.session });

      assert.equal(forgotten.statusCode, 404);
      assert.equal(forgotten.json().error, 'job_not_found');
    } finally {
      client.destroy();
      held.release();
      bHeld.release();
      source.fetch = originalFetch;
      await fixture.installs.whenIdle();
    }
  }
});

test('R10: GET повторяет неудачный refresh и сохраняет prefs без import', async (t) => {
  const { writeHttpPlugin } = await import('./helpers/pluginInstallHttpFixture.js');
  const { rename, symlink, unlink, lstat } = await import('node:fs/promises');
  const path = await import('node:path');
  const fixture = await installHttpFixture(t, {
    withPlugins: true,
    realService: true,
    prefs: { plugins: { demo: true }, pluginSettings: { demo: { title: 'Сохранено' } } },
    setup: async ({ pluginsDir }) => writeHttpPlugin(pluginsDir, 'demo'),
  });
  const saved = path.join(fixture.root, 'saved-plugins');

  await rename(fixture.pluginsDir, saved);
  await symlink(saved, fixture.pluginsDir);

  try {
    await fixture.installs.refreshCatalog();
    assert.equal(fixture.installs.health() !== null, true);
  } finally {
    await unlink(fixture.pluginsDir);
    await rename(saved, fixture.pluginsDir);
  }

  const marker = path.join(fixture.root, 'import-marker');

  await writeHttpPlugin(fixture.pluginsDir, 'added', {}, {
    'server.js': `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(marker)}, 'imported');
      export default async function plugin(app) { app.get('/hello', async () => ({})); }
    `,
  });

  const response = await fixture.app.inject({ url: '/api/plugins', headers: fixture.session });

  assert.equal(response.statusCode, 200);

  const added = response.json().plugins.find((plugin) => plugin.id === 'added');

  assert.equal(Boolean(added), true);
  assert.equal(added.enabled, false);
  assert.equal(fixture.installs.health(), null);
  assert.equal(await lstat(marker).catch(() => null), null);
  assert.equal(response.json().plugins.find((plugin) => plugin.id === 'demo').enabled, true);
});

test('CAT-I1: expectedSha строгий и доходит до install/update port', async (t) => {
  const fixture = await installHttpFixture(t);
  const sha = 'a'.repeat(40);

  for (const endpoint of ['/jobs', '/plugins/demo/update']) {
    const body = endpoint === '/jobs' ? { url: 'file:///fixture' } : {};
    const response = await fixture.app.inject({
      method: 'POST',
      url: base + endpoint,
      headers: fixture.session,
      payload: {
        ...body,
        version: '1.1.0',
        expectedSha: sha
      },
    });

    assert.equal(response.statusCode, 202);
    assert.equal(fixture.stub.calls.at(-1).args.at(-1).expectedSha, sha);

    for (const invalid of [{ expectedSha: sha }, { version: '1.1.0', expectedSha: 'short' }]) {
      assert.equal((await fixture.app.inject({
        method: 'POST',
        url: base + endpoint,
        headers: fixture.session,
        payload: { ...body, ...invalid },
      })).statusCode, 400);
    }
  }
});
