import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { computePayloadDigest } from '../../server/src/lib/packageInstall/payloadDigest.ts';
import { safeGitConfigDigest } from '../../server/src/lib/packageInstall/gitMetadata.ts';
import { createPluginRepo, git } from './helpers/pluginRepo.js';
import { installHttpFixture } from './helpers/pluginInstallHttpFixture.js';
import { emptyInstallState } from '../../server/src/lib/packageInstall/stateStore.ts';
import { installedRecord } from './helpers/pluginInstallState.js';
import { legacyManifest, manifestV1, v1Files } from '../helpers/pluginV1.js';

const id = 'performance-audit';

/**
 * Старый установленный пакет воспроизводится настоящим Git и durable record.
 * Новая реализация не обязана разрешать установку legacy ради подготовки теста.
 */
async function upgradeFixture(t, managed = true, withPrevious = false) {
  const repo = await createPluginRepo(t, { id });
  const legacySha = await repo.release('1.0.0', { manifest: legacyManifest(), files: {
    'server.js': 'export default async function plugin() {}',
    'payload.txt': 'старый пакет',
  } });
  const freshManifest = manifestV1({
    id,
    version: '1.1.0',
    engines: { grigdesk: '>=0.0.0' }
  });
  const freshSha = await repo.release('1.1.0', {
    manifest: freshManifest,
    files: v1Files,
  });
  const f = await installHttpFixture(t, {
    withPlugins: true,
    realService: true,
    prefs: {
      plugins: { [id]: true },
      pluginSettings: { [id]: { limit: 7 } },
      pluginPlacements: { [id]: { 'provider.popover.after-bars': false } },
    },
    setup: async ({ pluginsDir, installs, config }) => {
      await installs.store.mutate(() => emptyInstallState());

      const current = path.join(pluginsDir, id);
      const version = withPrevious ? '1.1.0' : '1.0.0';

      await git(repo.root, 'clone', '-q', '--branch', `v${version}`, repo.url, current);
      await mkdir(path.join(config.userPluginsDataDir, id), { recursive: true });
      await writeFile(path.join(config.userPluginsDataDir, id, 'marker.txt'), 'данные владельца');

      if (!managed) {
        return;
      }

      const record = {
        ...installedRecord(version),
        source: { kind: 'git', url: repo.url },
        sha: withPrevious ? freshSha : legacySha,
        payloadDigest: await computePayloadDigest(current),
        gitConfigDigest: await safeGitConfigDigest(current),
      };

      if (withPrevious) {
        const previous = path.join(installs.workDir, 'previous', id);

        await mkdir(path.dirname(previous), { recursive: true });
        await git(repo.root, 'clone', '-q', '--branch', 'v1.0.0', repo.url, previous);
        record.previous = {
          source: record.source,
          version: '1.0.0',
          tag: 'v1.0.0',
          sha: legacySha,
          installedAt: record.installedAt,
          payloadDigest: await computePayloadDigest(previous),
          gitConfigDigest: await safeGitConfigDigest(previous),
          npmDirs: [],
        };
      }

      await installs.store.mutate((state) => {
        state.plugins[id] = record;
        state.nextRevision = 2;
      });
    },
  });

  return { ...f, repo };
}

for (const managed of [false, true]) {
  test(`V1-UPGRADE: ${managed ? 'managed reinstall' : 'manual bind'} сохраняет prefs/data/backup`,
    async (t) => {
    const f = await upgradeFixture(t, managed);
    const getCard = async () => (await f.app.inject({ url: '/api/plugins', headers: f.session }))
      .json().plugins.find((card) => card.id === id);
    const initial = await getCard();

    assert.equal(initial?.compatibility?.status, 'incompatible');

    const prefs = structuredClone(f.prefs.read());

    if (managed) {
      await f.installs.startUpdate(id, { version: '1.1.0', replaceModified: true });
    } else {
      await f.installs.startInstall({
        url: f.repo.url,
        version: '1.1.0',
        expectedId: id,
        replaceModified: true,
      });
    }

    await f.installs.whenIdle();

    const ready = await f.installs.currentJob();

    assert.equal(ready.status, 'ready', JSON.stringify(ready.error));
    assert.equal(ready.preview.description, manifestV1().description);
    assert.equal((await f.installs.apply(ready.id, ready.reviewToken)).status, 'done');

    const currentCard = await getCard();

    assert.equal(currentCard.compatibility.status, 'compatible');
    assert.equal(currentCard.values.limit, 7);
    assert.equal(currentCard.placements.find((entry) => entry.slot === 'provider.popover.after-bars').enabled,
      false);
    assert.deepEqual(f.prefs.read(), prefs);

    const data = await readFile(path.join(f.userPluginsDataDir, id, 'marker.txt'), 'utf8');

    assert.equal(data, 'данные владельца');

    const response = await f.app.inject({ url: `/api/ext/${id}/status`, headers: f.session });

    assert.equal(response.statusCode, 200, response.body);

    if (managed) {
      assert.equal(JSON.parse(await readFile(
        path.join(f.installs.workDir, 'previous', id, 'plugin.json'), 'utf8',
      )).version, '1.0.0');
    } else {
      assert.ok((await f.installs.currentJob()).backupRef, 'ручная копия сохранена в replaced');
    }
  });
}

test('V1-LEGACY-PREPARE: candidate отклонён с manifest_incompatible до npm', async (t) => {
  const repo = await createPluginRepo(t);

  await repo.release('1.0.0', { manifest: legacyManifest() });

  let npmCalls = 0;
  const f = await installHttpFixture(t, {
    realService: true,
    withPlugins: true,
    serviceOptions: { runNpm: async () => {
      npmCalls += 1;

      throw new Error('npm не должен исполняться');
    } },
  });

  await f.installs.startInstall({ url: repo.url, version: '1.0.0' });
  await f.installs.whenIdle();

  const job = await f.installs.currentJob();

  assert.equal(job.status, 'failed');
  assert.equal(job.error.code, 'manifest_incompatible');
  assert.ok(job.error.message);
  assert.equal(npmCalls, 0);
});

test('V1-OLD-ROLLBACK: legacy previous объясняет отказ до lease и сохраняет обе копии', async (t) => {
  const f = await upgradeFixture(t, true, true);
  const state = await f.installs.store.read();
  const record = state.plugins[id];
  const current = path.join(f.pluginsDir, id, 'plugin.json');
  const previous = path.join(f.installs.workDir, 'previous', id, 'plugin.json');
  const before = [await readFile(current, 'utf8'), await readFile(previous, 'utf8')];
  const info = await f.installs.describe(id);

  assert.equal(info.rollbackAvailable, false);
  assert.equal(info.rollbackError?.code, 'manifest_incompatible');

  let leases = 0;

  f.installs.bindRuntime({
    isLoaded: () => true,
    prepareReplace: async () => {
      leases += 1;

      throw new Error('До lease доходить нельзя');
    },
    refresh: async () => {},
  });
  await assert.rejects(f.installs.rollback(id, {
    requestId: randomUUID(),
    expectedRevision: record.revision,
    expectedPreviousDigest: record.previous.payloadDigest,
  }), { code: 'manifest_incompatible' });
  assert.equal(leases, 0);
  assert.deepEqual(await f.installs.store.read(), state);
  assert.deepEqual([await readFile(current, 'utf8'), await readFile(previous, 'utf8')], before);
});
