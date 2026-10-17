import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { PluginSourceRegistry } from '../../server/src/lib/pluginInstall/sources.ts';
import { createPluginRepo } from './helpers/pluginRepo.js';
import { commandSuccess, serviceFixture } from './helpers/pluginServiceFixture.js';
import { PluginInstallStateStore } from '../../server/src/lib/pluginInstall/stateStore.ts';

/**
 * Synthetic source не использует Git transport: service обязан вызывать его интерфейс.
 * Manifest и bytes создаются в service-owned destination, без imports server.js.
 */
function mirrorSource() {
  return {
    kind: 'mirror',
    normalizeUrl: (raw) => {
      assert.equal(raw, 'mirror://fixture/demo');

      return raw;
    },
    listVersions: async () => [
      {
        version: '1.1.0',
        tag: 'v1.1.0',
        sha: 'b'.repeat(40),
      },
      {
        version: '1.0.0',
        tag: 'v1.0.0',
        sha: 'a'.repeat(40),
      },
    ],
    fetch: async ({ target, destination }) => {
      await mkdir(destination, { recursive: true });
      await writeFile(path.join(destination, 'plugin.json'),
        JSON.stringify({ id: 'demo', version: target.version }));
      await writeFile(path.join(destination, 'server.js'), 'export default async () => {};');
    },
    changes: async () => null,
    inspectInstalled: async (_directory, expected) => ({ sha: expected.sha, modified: false }),
  };
}

test('M1: startInstall сразу running, затем durable ready latest, Git и второй kind через source API',
  async (t) => {
    const repo = await createPluginRepo(t);

    await repo.release('1.0.0');

    const latest = await repo.release('1.1.0');

    for (const kind of ['git', 'mirror']) {
      const fixture = await serviceFixture(t, kind === 'mirror'
        ? { sources: new PluginSourceRegistry([mirrorSource()]) } : {});
      const running = await fixture.service.startInstall({
         url: kind === 'git' ? repo.url : 'mirror://fixture/demo'
      });

      assert.equal(running?.status, 'running');
      assert.equal(running.stage, 'fetching');
      await fixture.service.whenIdle();

      const ready = await fixture.service.currentJob();
      const disk = JSON.parse(await readFile(fixture.statePath, 'utf8'));
      const packageDir = path.join(fixture.pluginsDir, '.cockpit-install/jobs', ready.id, 'package');

      assert.equal(ready.status, 'ready');
      assert.equal(ready.source.kind, kind);
      assert.equal(ready.target.version, '1.1.0');
      assert.equal(ready.target.sha, kind === 'git' ? latest : 'b'.repeat(40));
      assert.equal(ready.preview.source.kind, kind);
      assert.equal(ready.preview.id, 'demo');
      assert.equal(ready.stage, null);
      assert.equal(ready.finishedAt, null);
      assert.match(ready.reviewToken, /^[a-f0-9]{64}$/u);
      assert.equal(disk.job.reviewToken, ready.reviewToken);
      assert.equal(disk.prepared.jobId, ready.id);
      assert.match(disk.prepared.candidateDigest, /^[a-f0-9]{64}$/u);
      assert.equal((await lstat(packageDir)).isDirectory(), true);
      assert.equal(await lstat(path.join(fixture.pluginsDir, 'demo')).catch(() => null), null);
      assert.deepEqual(disk.workers, {}, 'каждая Git command подтверждённо завершена');
    }
  });

test('M2: явно выбранная версия готовится при наличии более новой', async (t) => {
  const repo = await createPluginRepo(t);
  const selected = await repo.release('1.0.0');

  await repo.release('1.1.0');

  const { service } = await serviceFixture(t);

  await service.startInstall({ url: repo.url, version: '1.0.0' });
  await service.whenIdle();

  const job = await service.currentJob();

  assert.equal(job.status, 'ready');
  assert.equal(job.target.version, '1.0.0');
  assert.equal(job.target.sha, selected);
  assert.equal(job.preview.version, '1.0.0');
});

test('M3: неизвестная версия даёт failed/version_not_found и cleanup только своего job', async (t) => {
  const repo = await createPluginRepo(t);

  await repo.release('1.0.0');

  const fixture = await serviceFixture(t);

  await fixture.service.startInstall({ url: repo.url, version: '9.9.9' });
  await fixture.service.whenIdle();

  const job = await fixture.service.currentJob();
  const state = JSON.parse(await readFile(fixture.statePath, 'utf8'));

  assert.equal(job.status, 'failed');
  assert.equal(job.error.code, 'version_not_found');
  assert.ok(job.finishedAt);
  assert.equal(state.completedJobs[job.id]?.status, 'failed');
  assert.equal(
    await lstat(path.join(fixture.pluginsDir, '.cockpit-install/jobs', job.id)).catch(() => null), null,
  );
});

test('M4: репозиторий без стабильных тегов даёт failed/source_no_versions', async (t) => {
  const repo = await createPluginRepo(t);
  const { service } = await serviceFixture(t);

  await service.startInstall({ url: repo.url });
  await service.whenIdle();

  const job = await service.currentJob();

  assert.equal(job.status, 'failed');
  assert.equal(job.error.code, 'source_no_versions');
  assert.equal(job.target, null);
});

test('M5: manifest/tag mismatch сохраняет failed и удаляет лишь своё staged дерево', async (t) => {
  const repo = await createPluginRepo(t);

  await repo.release('1.0.0', { manifest: { version: '9.9.9' } });

  const fixture = await serviceFixture(t);
  const unrelated = path.join(fixture.pluginsDir, '.cockpit-install/jobs/unknown-preserved');

  await fixture.service.store.mutate(() => {});
  await mkdir(unrelated, { recursive: true });
  await writeFile(path.join(unrelated, 'marker.txt'), 'preserve');
  await fixture.service.startInstall({ url: repo.url });
  await fixture.service.whenIdle();

  const job = await fixture.service.currentJob();

  assert.equal(job.status, 'failed');
  assert.equal(job.stage, 'validating');
  assert.equal(job.error.code, 'version_mismatch');
  assert.equal(
    await lstat(path.join(fixture.pluginsDir, '.cockpit-install/jobs', job.id)).catch(() => null), null,
  );
  assert.equal(await readFile(path.join(unrelated, 'marker.txt'), 'utf8'), 'preserve');
});

test('M6: каждое npmDir готовится ровно раз, failure безопасен и сохраняет dependencies stage', async (t) => {
  const repo = await createPluginRepo(t);
  const packageJson = JSON.stringify({ name: 'fixture', version: '1.0.0' });
  const lock = JSON.stringify({ lockfileVersion: 3, packages: { '': {} } });

  await repo.release('1.0.0', {
    manifest: { install: { npm: ['.', 'browser'] } },
    files: {
      'package.json': packageJson,
      'package-lock.json': lock,
      'browser/package.json': packageJson,
      'browser/package-lock.json': lock,
    },
  });

  const good = await serviceFixture(t);

  await good.service.startInstall({ url: repo.url });
  await good.service.whenIdle();

  const ready = await good.service.currentJob();
  const jobDir = path.join(good.pluginsDir, '.cockpit-install/jobs', ready.id, 'package');

  assert.equal(ready.status, 'ready');
  assert.deepEqual(good.npmCalls, [jobDir, path.join(jobDir, 'browser')]);

  const bad = await serviceFixture(t, {
    runNpm: async () => ({
      ...commandSuccess,
      code: 19,
      stderr: 'fixture-secret raw stderr diagnostic',
    }),
  });

  await bad.service.startInstall({ url: repo.url });
  await bad.service.whenIdle();

  const failed = await bad.service.currentJob();

  assert.equal(failed.status, 'failed');
  assert.equal(failed.stage, 'dependencies');
  assert.equal(failed.error.code, 'dependencies_failed');
  assert.equal(JSON.stringify(failed).includes('fixture-secret'), false);
  assert.equal((await readFile(bad.statePath, 'utf8')).includes('raw stderr'), false);
});

test('M7: running/ready сохраняют единственный slot и token до явного cancel', async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const source = mirrorSource();
  const list = source.listVersions;

  source.listVersions = async (...args) => {
    entered.resolve();
    await release.promise;

    return list(...args);
  };

  const fixture = await serviceFixture(t, { sources: new PluginSourceRegistry([source]) });
  const running = await fixture.service.startInstall({ url: 'mirror://fixture/demo' });

  await entered.promise;
  await assert.rejects(fixture.service.startInstall({ url: 'mirror://fixture/demo' }),
    { code: 'install_busy' });
  release.resolve();
  await fixture.service.whenIdle();

  const ready = await fixture.service.currentJob();
  const bytes = await readFile(fixture.statePath, 'utf8');

  assert.equal(ready.id, running.id);
  await assert.rejects(fixture.service.startInstall({ url: 'mirror://fixture/demo' }),
    { code: 'install_busy' });
  assert.equal((await fixture.service.currentJob()).reviewToken, ready.reviewToken);
  assert.equal(await readFile(fixture.statePath, 'utf8'), bytes);

  const cancelled = await fixture.service.cancel(ready.id);

  assert.equal(cancelled.status, 'cancelled');
  assert.equal(
    await lstat(path.join(fixture.pluginsDir, '.cockpit-install/jobs', ready.id)).catch(() => null), null,
  );

  const next = await fixture.service.startInstall({ url: 'mirror://fixture/demo' });

  assert.notEqual(next.id, ready.id);
  await fixture.service.whenIdle();
  assert.equal((await fixture.service.currentJob()).status, 'ready');
});

test('M8: cancel на npm barrier ждёт worker ACK и только затем публикует cancelled/cleanup', async (t) => {
  const source = mirrorSource();
  const fetch = source.fetch;
  const entered = Promise.withResolvers();
  const aborted = Promise.withResolvers();
  const released = Promise.withResolvers();
  const unrelated = new AbortController();

  source.fetch = async (request) => {
    await fetch(request);
    await writeFile(path.join(request.destination, 'package.json'), '{"name":"fixture"}');
    await writeFile(path.join(request.destination, 'package-lock.json'),
      '{"lockfileVersion":3,"packages":{"":{}}}');
  };

  const fixture = await serviceFixture(t, {
    sources: new PluginSourceRegistry([source]),
    runNpm: async (_cwd, signal) => {
      entered.resolve();
      signal.addEventListener('abort', () => aborted.resolve(), { once: true });
      await released.promise;

      return {
        ...commandSuccess,
        code: 130,
        aborted: true,
      };
    },
  });
  const running = await fixture.service.startInstall({ url: 'mirror://fixture/demo' });

  await entered.promise;

  const waitObserved = Promise.withResolvers();
  const originalPreparation = fixture.service.preparation;

  fixture.service.preparation = {
    then(resolve, reject) {
      waitObserved.resolve();

      return originalPreparation.then(resolve, reject);
    },
  };

  let settled = false;
  const cancelled = fixture.service.cancel(running.id).then((job) => {
    settled = true;

    return job;
  });

  try {
    await aborted.promise;

    const earlyCompletion = await Promise.race([
      waitObserved.promise.then(() => false),
      cancelled.then(() => true),
    ]);

    assert.equal(earlyCompletion, false, 'cancel не завершился раньше удержанного worker ACK');
    assert.equal(settled, false);
    assert.equal(unrelated.signal.aborted, false);

  
  const jobRoot = path.join(fixture.pluginsDir, '.cockpit-install/jobs', running.id);

    assert.equal((await lstat(jobRoot)).isDirectory(), true);
    assert.equal(JSON.parse(await readFile(fixture.statePath, 'utf8')).job.status, 'running');
    await assert.rejects(fixture.service.startInstall({ url: 'mirror://fixture/demo' }),
      { code: 'install_busy' });
  } finally {
    released.resolve();
    await originalPreparation;
  }

  const outcome = await cancelled;

  assert.equal(outcome.status, 'cancelled');
  assert.equal(outcome.error.code, 'cancelled');

  const jobRoot = path.join(fixture.pluginsDir, '.cockpit-install/jobs', running.id);

  assert.equal(await lstat(jobRoot).catch(() => null), null);
  assert.equal(
      JSON.parse(await readFile(fixture.statePath, 'utf8')).completedJobs[running.id].status, 'cancelled');
});

test('M9: плохой URL не создаёт job и не занимает admission', async (t) => {
  const fixture = await serviceFixture(t);
  const repo = await createPluginRepo(t);

  await repo.release('1.0.0');
  await assert.rejects(fixture.service.startInstall({ url: 'https://user:fixture-secret@host/repo' }), {
    code: 'source_url_invalid',
  });
  assert.equal(await fixture.service.currentJob(), null);
  assert.equal(await lstat(fixture.statePath).catch(() => null), null);

  let job;

  await assert.doesNotReject(async () => {
    job = await fixture.service.startInstall({ url: repo.url });
  });

  assert.equal(job.status, 'running');
  await fixture.service.whenIdle();
  assert.equal((await fixture.service.currentJob()).status, 'ready');
});

test('M10: ручная current копия даёт unmanaged preview и обещание сохранения в replaced', async (t) => {
  const repo = await createPluginRepo(t);

  await repo.release('1.0.0');

  const fixture = await serviceFixture(t);
  const current = path.join(fixture.pluginsDir, 'demo');

  await mkdir(current);
  await writeFile(path.join(current, 'manual.txt'), 'keep all bytes');
  await fixture.service.startInstall({ url: repo.url });
  await fixture.service.whenIdle();

  const job = await fixture.service.currentJob();
  const disk = JSON.parse(await readFile(fixture.statePath, 'utf8'));

  assert.equal(job.status, 'ready');
  assert.deepEqual(job.preview.replaces, { kind: 'unmanaged' });
  assert.ok(job.preview.warnings.some((warning) => /ручн.*сохран/iu.test(warning)));
  assert.equal(disk.prepared.baseSnapshot.current.ino, (await lstat(current)).ino);
  assert.equal(disk.prepared.baseSnapshot.record, null);
  assert.equal(await readFile(path.join(current, 'manual.txt'), 'utf8'), 'keep all bytes');
});

test('M11: reserved id и expectedId mismatch отвергаются до ready и публикации', async (t) => {
  for (const variant of ['reserved', 'mismatch']) {
    const repo = await createPluginRepo(t, { id: variant === 'reserved' ? 'code' : 'demo' });

    await repo.release('1.0.0');

    const fixture = await serviceFixture(t);

    await fixture.service.startInstall({
      url: repo.url,
      ...(variant === 'mismatch' ? { expectedId: 'other' } : {}),
    });
    await fixture.service.whenIdle();

    const job = await fixture.service.currentJob();

    assert.equal(job.status, 'failed');
    assert.equal(job.stage, 'validating');
    assert.equal(job.error.code, variant === 'reserved' ? 'id_reserved' : 'id_mismatch');
    assert.equal(await lstat(path.join(fixture.pluginsDir, 'code')).catch(() => null), null);
    assert.equal(await lstat(path.join(fixture.pluginsDir, 'demo')).catch(() => null), null);
  }
});

test('M12: ready revision/token/prepared устойчивы на диске, GET DTO нельзя изменить извне', async (t) => {
  const fixture = await serviceFixture(t, { sources: new PluginSourceRegistry([mirrorSource()]) });

  await fixture.service.startInstall({ url: 'mirror://fixture/demo' });
  await fixture.service.whenIdle();

  const ready = await fixture.service.currentJob();
  const returned = await fixture.service.getJob(ready.id);

  returned.preview.name = 'changed outside service';
  returned.source.kind = 'mutated';
  assert.equal((await fixture.service.currentJob()).preview.name, ready.preview.name);
  assert.equal((await fixture.service.currentJob()).source.kind, ready.source.kind);

  const fresh = new PluginInstallStateStore({
    statePath: fixture.statePath,
    hasWorkEvidence: async () => true,
  });
  const disk = await fresh.read();

  assert.deepEqual(disk.job, ready);
  assert.equal(disk.prepared.jobId, ready.id);
  assert.equal(disk.job.finishedAt, null);
  assert.ok(disk.job.revision > 0);
  assert.equal(disk.job.reviewToken, ready.reviewToken);
});
