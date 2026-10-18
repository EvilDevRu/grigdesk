import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { createPluginRepo, git } from './helpers/pluginRepo.js';
import { serviceFixture } from './helpers/pluginServiceFixture.js';
import { PluginSourceRegistry } from '../../server/src/lib/pluginInstall/sources.ts';
import { installError } from '../../server/src/lib/pluginInstall/errors.ts';
import { computePayloadDigest } from '../../server/src/lib/pluginInstall/payloadDigest.ts';

/**
 * Установка проходит обычный service API и ждёт подготовки через fixture seam.
 * Результат применяется только с выданным reviewToken.
 */
async function prepare(service, url, request = {}) {
  await service.startInstall({ url, ...request });
  await service.whenIdle();

  const job = await service.currentJob();

  assert.equal(job.status, 'ready', JSON.stringify(job.error));

  return job;
}

test('M13: fresh apply публикует current и полный durable record, без import/restart', async (t) => {
  const repo = await createPluginRepo(t);
  const sha = await repo.release('1.0.0');
  const fixture = await serviceFixture(t);
  const unknown = path.join(fixture.service.workDir, 'transactions/unknown-keep');

  await fixture.service.store.mutate(() => {});
  await mkdir(unknown, { recursive: true });

  const ready = await prepare(fixture.service, repo.url);
  const done = await fixture.service.apply(ready.id, ready.reviewToken);
  const state = JSON.parse(await readFile(fixture.statePath, 'utf8'));
  const current = path.join(fixture.pluginsDir, 'demo');
  const record = state.plugins.demo;

  assert.equal(done.status, 'done');
  assert.equal(await git(current, 'rev-parse', 'HEAD'), sha);
  assert.equal(record.source.url, repo.url);
  assert.equal(record.sha, sha);
  assert.equal(record.version, '1.0.0');
  assert.equal(record.tag, 'v1.0.0');
  assert.match(record.gitConfigDigest, /^[a-f0-9]{64}$/u);
  assert.equal(record.payloadDigest, await computePayloadDigest(current, []));
  assert.deepEqual(record.npmDirs, []);
  assert.equal(record.previous, null);
  assert.equal(state.apply, null);
  assert.equal(state.prepared, null);
  assert.equal(state.completedJobs[ready.id].status, 'done');
  assert.equal(fixture.refreshCalls.length, 1);
  assert.equal(fixture.service.restartRequired('demo'), false);
  assert.equal(await lstat(path.join(fixture.service.workDir, 'jobs', ready.id)).catch(() => null), null);
  assert.equal((await lstat(unknown)).isDirectory(), true);
});

test('M14: id/status/token ошибки и повтор done из current/completed без файловых эффектов', async (t) => {
  const repo = await createPluginRepo(t);

  await repo.release('1.0.0');

  const { service, statePath, refreshCalls } = await serviceFixture(t);
  const entered = Promise.withResolvers();
  const held = Promise.withResolvers();
  const source = service.sources.get('git');
  const original = source.listVersions.bind(source);

  source.listVersions = async (...args) => {
    entered.resolve();
    await held.promise;

    return original(...args);
  };

  const running = await service.startInstall({ url: repo.url });

  await entered.promise;

  try {
    await assert.rejects(service.apply(running.id, 'a'.repeat(64)), { code: 'job_not_ready' });
  } finally {
    held.resolve();
  }

  await service.whenIdle();

  const ready = await service.currentJob();

  await assert.rejects(service.apply('00000000-0000-4000-8000-000000000001', ready.reviewToken),
    { code: 'job_not_found' });
  await assert.rejects(service.apply(ready.id, 'f'.repeat(64)), { code: 'preview_stale' });

  const done = await service.apply(ready.id, ready.reviewToken);
  const disk = await readFile(statePath, 'utf8');

  await assert.doesNotReject(async () => {
    assert.deepEqual(await service.apply(ready.id, ready.reviewToken), done);
  });
  assert.equal(await readFile(statePath, 'utf8'), disk);
  assert.equal(refreshCalls.length, 1);
  await service.startInstall({ url: repo.url, version: '9.9.9' });
  await service.whenIdle();

  const another = await service.currentJob();
  const rotated = await readFile(statePath, 'utf8');

  assert.deepEqual(await service.apply(ready.id, ready.reviewToken), done);
  assert.equal((await service.currentJob()).id, another.id);
  assert.equal(await readFile(statePath, 'utf8'), rotated);
  assert.equal(refreshCalls.length, 1);
});

test('M15: update показывает source/version/diff, сохраняет полный previous и новую revision', async (t) => {
  const repo = await createPluginRepo(t);
  const firstSha = await repo.release('1.0.0', { files: { 'server.js': 'export default async () => {};' } });
  const { service, statePath, pluginsDir } = await serviceFixture(t);
  const initial = await prepare(service, repo.url);

  await service.apply(initial.id, initial.reviewToken);

  const baseline = JSON.parse(await readFile(statePath, 'utf8')).plugins.demo;
  const nextSha = await repo.release('1.1.0', {
    files: { 'server.js': 'export default async () => { /* new */ };' },
  });
  const checked = await service.checkUpdates();

  assert.equal(checked.demo?.latest?.sha, nextSha);
  assert.equal(checked.demo.updateAvailable, true);
  assert.equal(checked.demo.localChanges, false);
  await service.startUpdate('demo');
  await service.whenIdle();

  const ready = await service.currentJob();

  assert.equal(ready.kind, 'update');
  assert.equal(ready.status, 'ready', JSON.stringify(ready.error));
  assert.deepEqual(ready.preview.replaces, {
    kind: 'managed',
    version: '1.0.0',
    sourceChanged: false,
  });
  assert.equal(ready.preview.target.sha, nextSha);
  assert.ok(ready.preview.changes.commits.some((commit) => commit.sha === nextSha));
  assert.ok(ready.preview.changes.sensitive.includes('server.js'));
  assert.ok(ready.preview.changes.sensitive.includes('plugin.json'));

  const done = await service.apply(ready.id, ready.reviewToken);
  const record = JSON.parse(await readFile(statePath, 'utf8')).plugins.demo;

  assert.equal(done.status, 'done', JSON.stringify(JSON.parse(await readFile(statePath, 'utf8'))));
  assert.equal(record.sha, nextSha);
  assert.equal(record.previous.sha, firstSha);
  assert.equal(record.previous.installedAt, baseline.installedAt);
  assert.equal(record.previous.source.url, baseline.source.url);
  assert.equal(record.previous.payloadDigest, baseline.payloadDigest);
  assert.deepEqual(record.previous.npmDirs, baseline.npmDirs);
  assert.equal(await git(path.join(service.workDir, 'previous/demo'), 'rev-parse', 'HEAD'), firstSha);
  assert.equal(await git(path.join(pluginsDir, 'demo'), 'rev-parse', 'HEAD'), nextSha);
  assert.ok(record.revision > baseline.revision);
});

test('M16: loaded runtime получает installed lease, restart flag до refresh и остаётся остановлен',
  async (t) => {
  const repo = await createPluginRepo(t);

  await repo.release('1.0.0');

  const { service, pluginsDir } = await serviceFixture(t);
  const finishes = [];
  let admissionClosed = false;
  let backgroundStopped = false;
  let refreshedVersion = null;

  service.bindRuntime({
    isLoaded: () => true,
    prepareReplace: async () => {
      admissionClosed = true;
      backgroundStopped = true;

      return {
        finish: async (outcome) => {
          finishes.push(outcome);

          if (outcome === 'reverted') {
            admissionClosed = false;
            backgroundStopped = false;
          }
        },
      };
    },
    refresh: async () => {
      assert.equal(service.restartRequired('demo'), true, 'flag опубликован до refresh');

      const manifest = JSON.parse(await readFile(path.join(pluginsDir, 'demo/plugin.json'), 'utf8'));

      refreshedVersion = manifest.version;
    },
  });

  const ready = await prepare(service, repo.url);
  const done = await service.apply(ready.id, ready.reviewToken);

  assert.equal(done.status, 'done');
  assert.deepEqual(finishes, ['installed']);
  assert.equal(admissionClosed, true);
  assert.equal(backgroundStopped, true);
  assert.equal(service.restartRequired('demo'), true);
  assert.equal(refreshedVersion, '1.0.0');
});

test('M17: отказ runtime lease сохраняет ready/token/candidate, повтор после устранения причины допустим',
  async (t) => {
    const repo = await createPluginRepo(t);

    await repo.release('1.0.0');

    for (const code of ['plugin_busy', 'plugin_stop_required']) {
      const { service, statePath, pluginsDir } = await serviceFixture(t);
      let blocked = true;

      service.bindRuntime({
        isLoaded: () => true,
        prepareReplace: async () => {
          if (blocked) {
            throw installError(code);
          }

          return { finish: async () => {} };
        },
        refresh: async () => {},
      });

      const ready = await prepare(service, repo.url);
      const disk = await readFile(statePath, 'utf8');
      const candidate = path.join(service.workDir, 'jobs', ready.id, 'package');
      const digest = await computePayloadDigest(candidate, []);

      await assert.rejects(service.apply(ready.id, ready.reviewToken), { code });
      assert.equal(await readFile(statePath, 'utf8'), disk);
      assert.equal(await computePayloadDigest(candidate, []), digest);
      assert.equal(await lstat(path.join(pluginsDir, 'demo')).catch(() => null), null);
      assert.equal((await service.currentJob()).status, 'ready');
      blocked = false;
      assert.equal((await service.apply(ready.id, ready.reviewToken)).status, 'done');
    }
  });

test('M18: tracked/new/ignored current правки блокируют update; force архивирует их, сохраняя previous',
  async (t) => {
    const repo = await createPluginRepo(t);

    await repo.release('1.0.0', { files: { '.gitignore': 'ignored.log\n', 'payload.txt': 'release' } });
    await repo.release('1.1.0');
    await repo.release('1.2.0');

    for (const dirtyFile of ['payload.txt', 'new.js', 'ignored.log']) {
      const { service, pluginsDir, statePath } = await serviceFixture(t);
      const initial = await prepare(service, repo.url, { version: '1.0.0' });

      await service.apply(initial.id, initial.reviewToken);
      await service.startUpdate('demo', { version: '1.1.0' });
      await service.whenIdle();

      const update = await service.currentJob();

      assert.equal((await service.apply(update.id, update.reviewToken)).status, 'done');

      const previousDir = path.join(service.workDir, 'previous/demo');
      const previousDigest = await computePayloadDigest(previousDir, []);
      const currentDir = path.join(pluginsDir, 'demo');

      await writeFile(path.join(currentDir, dirtyFile), 'manual fixture edit');
      assert.equal((await service.describe('demo')).localChanges, true);
      await service.startUpdate('demo');
      await service.whenIdle();

      const failed = await service.currentJob();

      assert.equal(failed.status, 'failed');
      assert.equal(failed.error.code, 'local_changes');
      assert.equal((await service.describe('demo')).localChanges, true);
      await service.startUpdate('demo', { replaceModified: true });
      await service.whenIdle();

      const ready = await service.currentJob();

      assert.equal(ready.status, 'ready', JSON.stringify(ready.error));
      assert.ok(ready.preview.warnings.some((warning) => /правк/iu.test(warning)));

      const done = await service.apply(ready.id, ready.reviewToken);
      const record = JSON.parse(await readFile(statePath, 'utf8')).plugins.demo;

      assert.equal(done.status, 'done');
      assert.ok(done.backupRef);
      assert.equal(await readFile(path.join(service.workDir, 'replaced', done.backupRef, dirtyFile), 'utf8'),
        'manual fixture edit');
      assert.equal(await computePayloadDigest(previousDir, []), previousDigest);
      assert.equal(record.previous.version, '1.0.0');
      assert.equal(record.version, '1.2.0');
      assert.equal((await service.describe('demo')).localChanges, false);
    }
  });

test('M19: равные kind/url/SHA отклоняются, другой source с тем же SHA допускается и предупреждает',
  async (t) => {
    const repo = await createPluginRepo(t);

    await repo.release('1.0.0');

    const { service, statePath } = await serviceFixture(t);
    const initial = await prepare(service, repo.url);

    await service.apply(initial.id, initial.reviewToken);
    await service.startUpdate('demo');
    await service.whenIdle();

    const same = await service.currentJob();

    assert.equal(same.status, 'failed');
    assert.equal(same.error.code, 'version_installed');

    const secondOrigin = path.join(repo.root, 'second-origin.git');

    await git(repo.root, 'clone', '--bare', repo.origin, secondOrigin);

    const ready = await prepare(service, pathToFileURL(secondOrigin).href);

    assert.equal(ready.target.sha, initial.target.sha);
    assert.deepEqual(ready.preview.replaces, {
      kind: 'managed',
      version: '1.0.0',
      sourceChanged: true,
    });
    assert.ok(ready.preview.warnings.some((warning) => /источник/iu.test(warning)));
    assert.equal((await service.apply(ready.id, ready.reviewToken)).status, 'done');
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).plugins.demo.source.url,
      pathToFileURL(secondOrigin).href);
  });

test('M19b: sourceChanged учитывает kind при равных canonical URL и SHA', async (t) => {
  const sources = ['mirror-a', 'mirror-b'].map((kind) => ({
    kind,
    normalizeUrl: (url) => {
      if (url !== `${kind}://fixture` && url !== 'mirror://fixture/demo') {
        throw installError('source_url_invalid');
      }

      return 'mirror://fixture/demo';
    },
    listVersions: async () => [{
      version: '1.0.0',
      tag: 'v1.0.0',
      sha: 'a'.repeat(40),
    }],
    fetch: async ({ destination }) => {
      await mkdir(destination, { recursive: true });
      await writeFile(path.join(destination, 'plugin.json'),
        JSON.stringify({ id: 'demo', version: '1.0.0' }));
    },
    changes: async () => null,
    inspectInstalled: async (_dir, expected) => ({ sha: expected.sha, modified: false }),
  }));
  const { service } = await serviceFixture(t, { sources: new PluginSourceRegistry(sources) });
  const initial = await prepare(service, 'mirror-a://fixture');

  await service.apply(initial.id, initial.reviewToken);
  await service.startInstall({ url: 'mirror-b://fixture' });
  await service.whenIdle();

  const ready = await service.currentJob();

  assert.equal(ready.status, 'ready', JSON.stringify(ready.error));
  assert.equal(ready.preview.replaces.sourceChanged, true);
  assert.ok(ready.preview.warnings.some((warning) => /источник/iu.test(warning)));
});

test('M20a: prepared npm payload проходит apply без повторного npm и сохраняет npmDirs', async (t) => {
  const repo = await createPluginRepo(t);

  await repo.release('1.0.0', {
    files: {
      'package.json': '{"name":"fixture","version":"1.0.0"}',
      'package-lock.json': '{"lockfileVersion":3,"packages":{"":{}}}',
    },
  });

  const { service, npmCalls, statePath } = await serviceFixture(t);
  const ready = await prepare(service, repo.url);

  await assert.doesNotReject(async () => {
    assert.equal((await service.apply(ready.id, ready.reviewToken)).status, 'done');
  });
  assert.equal(npmCalls.length, 1);
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).plugins.demo.npmDirs, ['.']);
});

test('M20: rollback меняет полные snapshots с preconditions и новым requestId для обратного переключения',
  async (t) => {
    const repo = await createPluginRepo(t);
    const pkg = '{"name":"fixture","version":"1.0.0"}';
    const lock = '{"lockfileVersion":3,"packages":{"":{}}}';

    await repo.release('1.0.0', { files: { 'package.json': pkg, 'package-lock.json': lock } });
    await repo.release('1.1.0', {
      manifest: { install: { npm: ['browser'] } },
      files: { 'browser/package.json': pkg, 'browser/package-lock.json': lock },
    });

    const { service, statePath, pluginsDir } = await serviceFixture(t);
    const initial = await prepare(service, repo.url, { version: '1.0.0' });

    await service.apply(initial.id, initial.reviewToken);

    const oldRecord = JSON.parse(await readFile(statePath, 'utf8')).plugins.demo;

    await service.startUpdate('demo');
    await service.whenIdle();

    const ready = await service.currentJob();

    assert.equal((await service.apply(ready.id, ready.reviewToken)).status, 'done');

    const base = JSON.parse(await readFile(statePath, 'utf8')).plugins.demo;
    const rollback = await service.rollback('demo', {
      requestId: randomUUID(),
      expectedRevision: base.revision,
      expectedPreviousDigest: base.previous.payloadDigest,
    });
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    const record = state.plugins.demo;

    assert.equal(rollback.kind, 'rollback');
    assert.equal(rollback.status, 'done');
    assert.equal(record.version, oldRecord.version);
    assert.equal(record.tag, oldRecord.tag);
    assert.equal(record.sha, oldRecord.sha);
    assert.equal(record.installedAt, oldRecord.installedAt);
    assert.deepEqual(record.source, oldRecord.source);
    assert.deepEqual(record.npmDirs, ['.']);
    assert.equal(record.payloadDigest, oldRecord.payloadDigest);
    assert.equal(record.gitConfigDigest, oldRecord.gitConfigDigest);
    assert.ok(record.revision > base.revision);
    assert.equal(record.previous.version, '1.1.0');
    assert.deepEqual(record.previous.npmDirs, ['browser']);
    assert.equal(state.lastRollback.demo.job.id, rollback.id);
    assert.equal(await git(path.join(pluginsDir, 'demo'), 'rev-parse', 'HEAD'), oldRecord.sha);

    const second = await service.rollback('demo', {
      requestId: randomUUID(),
      expectedRevision: record.revision,
      expectedPreviousDigest: record.previous.payloadDigest,
    });
    const restored = JSON.parse(await readFile(statePath, 'utf8')).plugins.demo;

    assert.notEqual(second.id, rollback.id);
    assert.equal(second.status, 'done');
    assert.equal(restored.version, '1.1.0');
    assert.equal(restored.installedAt, base.installedAt);
    assert.deepEqual(restored.npmDirs, ['browser']);
    assert.ok(restored.revision > record.revision);
  });

test('M22: origin недоступен — checkError отдельно, latest сохранён, остальные проверены, describe без сети',
  async (t) => {
    const missing = await createPluginRepo(t);
    const healthy = await createPluginRepo(t, { id: 'other' });

    await missing.release('1.0.0');
    await healthy.release('1.0.0');

    const { service } = await serviceFixture(t);

    for (const repo of [missing, healthy]) {
      const ready = await prepare(service, repo.url);

      await service.apply(ready.id, ready.reviewToken);
    }

    const oldLatest = await missing.release('1.1.0');

    await service.checkUpdates();
    await rename(missing.origin, path.join(missing.root, 'unavailable-origin.git'));

    const latest = await healthy.release('1.1.0');
    const source = service.sources.get('git');
    const original = source.listVersions.bind(source);
    let networks = 0;

    source.listVersions = async (...args) => {
      networks += 1;

      return original(...args);
    };

    const checked = await service.checkUpdates();

    assert.equal(checked.demo.checkError?.code, 'source_unavailable');
    assert.equal(checked.demo.latest.sha, oldLatest);
    assert.equal(checked.other.checkError, null);
    assert.equal(checked.other.latest.sha, latest);
    assert.equal(checked.other.updateAvailable, true);
    assert.equal(networks, 2);
    await service.describe('demo');
    await service.describe('other');
    assert.equal(networks, 2, 'describe не вызывает listVersions');
  });

test('M25: source A→B→rollback восстанавливает A и сбрасывает metadata B до проверки A', async (t) => {
  const a = await createPluginRepo(t);
  const b = await createPluginRepo(t);

  await a.release('1.0.0');
  await b.release('1.1.0');

  const { service, statePath } = await serviceFixture(t);
  const initial = await prepare(service, a.url);

  await service.apply(initial.id, initial.reviewToken);

  const change = await prepare(service, b.url);

  assert.equal(change.preview.replaces.sourceChanged, true);
  assert.equal(change.preview.changes, null);
  assert.ok(change.preview.warnings.some((warning) => /истори/iu.test(warning)));
  await service.apply(change.id, change.reviewToken);
  await b.release('2.0.0');
  await service.checkUpdates();

  const base = JSON.parse(await readFile(statePath, 'utf8')).plugins.demo;

  assert.equal(base.latest.version, '2.0.0');
  await service.rollback('demo', {
    requestId: randomUUID(),
    expectedRevision: base.revision,
    expectedPreviousDigest: base.previous.payloadDigest,
  });

  const restored = JSON.parse(await readFile(statePath, 'utf8')).plugins.demo;

  assert.equal(restored.source.url, a.url);
  assert.equal(restored.latest, null);
  assert.equal(restored.checkedAt, null);
  assert.equal(restored.checkError, null);

  const source = service.sources.get('git');
  const original = source.listVersions.bind(source);
  const urls = [];

  source.listVersions = async (url, signal) => {
    urls.push(url);

    return original(url, signal);
  };
  await a.release('1.2.0');

  const checked = await service.checkUpdates();

  assert.deepEqual(urls, [a.url]);
  assert.equal(checked.demo.latest.version, '1.2.0');
});

test('M33: candidate bytes/manifest/HEAD после ready дают preview_stale до rename и без import marker',
  async (t) => {
    const repo = await createPluginRepo(t);
    const marker = path.join(repo.root, 'import-marker');
    const server = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'loaded');`
      + ' export default async () => {};';

    await repo.release('1.0.0', { files: { 'server.js': server } });

    await repo.release('1.1.0');

    let positiveControl = null;

    for (const change of ['bytes', 'manifest', 'HEAD']) {
      const { service, pluginsDir, statePath } = await serviceFixture(t);
      const ready = await prepare(service, repo.url);
      const candidate = path.join(service.workDir, 'jobs', ready.id, 'package');
      const finishes = [];

      service.bindRuntime({
        isLoaded: () => true,
        prepareReplace: async () => ({ finish: async (outcome) => {
        finishes.push(outcome);
      } }),
        refresh: async () => {},
      });

      if (change === 'bytes') {
        await writeFile(path.join(candidate, 'server.js'), `${server}\n// changed bytes\n`);
      } else if (change === 'manifest') {
        await writeFile(path.join(candidate, 'plugin.json'), '{"id":"demo","version":"9.9.9"}');
      } else {
        await git(candidate, '-c', 'user.name=GrigDesk Test', '-c', 'user.email=grigdesk@example.invalid',
          'commit', '--allow-empty', '-m', 'fixture HEAD changed without payload');
      }

      const before = await readFile(statePath, 'utf8');
      const bytes = await readFile(path.join(candidate, 'server.js'), 'utf8');

      await assert.rejects(service.apply(ready.id, ready.reviewToken), { code: 'preview_stale' });
      assert.equal(await lstat(path.join(pluginsDir, 'demo')).catch(() => null), null);
      assert.equal(await readFile(path.join(candidate, 'server.js'), 'utf8'), bytes);
      assert.equal(JSON.parse(await readFile(statePath, 'utf8')).apply, null);
      assert.deepEqual(finishes, ['reverted']);
      assert.equal((await service.currentJob()).reviewToken, ready.reviewToken);
      assert.equal(await lstat(marker).catch(() => null), null);
      assert.equal(JSON.parse(before).job.id, ready.id);
      positiveControl = path.join(candidate, 'server.js');
    }

    await import(pathToFileURL(positiveControl).href);
    assert.equal(await readFile(marker, 'utf8'), 'loaded', 'marker исполняется в positive control');
  });
