import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createApplyFs } from '../../server/src/lib/packageInstall/applyPackage.ts';
import { installError } from '../../server/src/lib/packageInstall/errors.ts';
import { installedRecord } from './helpers/pluginInstallState.js';
import { mirrorPair } from './helpers/pluginMirrorFixture.js';

/**
 * Preconditions берутся из actual durable service публикации обеих версий.
 * Повтор caller должен сохранять тот же requestId и все три поля.
 */
async function rollbackInput(fixture) {
  const record = JSON.parse(await readFile(fixture.statePath, 'utf8')).plugins.demo;

  return {
    requestId: randomUUID(),
    expectedRevision: record.revision,
    expectedPreviousDigest: record.previous?.payloadDigest ?? '0'.repeat(64),
  };
}

test('M21: изменённый previous запрещает rollback и последующий update, обе копии сохранены', async (t) => {
  const fixture = await mirrorPair(t);
  const previous = path.join(fixture.service.workDir, 'previous/demo/payload.txt');

  await writeFile(previous, 'unknown manual previous edit');

  const input = await rollbackInput(fixture);
  const state = await readFile(fixture.statePath, 'utf8');

  await assert.rejects(fixture.service.rollback('demo', input), { code: 'previous_modified' });
  assert.equal(await readFile(fixture.statePath, 'utf8'), state);
  fixture.mirror.release('1.2.0');
  await fixture.service.startUpdate('demo');
  await fixture.service.whenIdle();

  const job = await fixture.service.currentJob();

  assert.equal(job.status, 'failed');
  assert.equal(job.error.code, 'previous_modified');
  assert.equal(await readFile(previous, 'utf8'), 'unknown manual previous edit');
  assert.equal(JSON.parse(await readFile(path.join(fixture.pluginsDir, 'demo/plugin.json'), 'utf8')).version,
    '1.1.0');
});

for (const code of ['no_previous', 'not_managed', 'local_changes', 'install_busy', 'plugin_busy']) {
  test(`M21-${code}: отдельный refusal оставляет обе копии и state без перехода`, async (t) => {
    const fixture = await mirrorPair(t, { single: code === 'no_previous' });
    let id = 'demo';

    if (code === 'not_managed') {
      id = 'unknown';
    } else if (code === 'local_changes') {
      await writeFile(path.join(fixture.pluginsDir, 'demo/payload.txt'), 'manual current edit');
    } else if (code === 'install_busy') {
      await fixture.service.startUpdate('demo', { replaceModified: true });
      await fixture.service.whenIdle();
      assert.equal((await fixture.service.currentJob()).status, 'ready');
    } else if (code === 'plugin_busy') {
      fixture.service.bindRuntime({
        isLoaded: () => true,
        prepareReplace: async () => {
          throw installError('plugin_busy');
        },
        refresh: async () => {},
      });
    }

    const input = await rollbackInput(fixture);
    const before = await readFile(fixture.statePath, 'utf8');
    const current = await readFile(path.join(fixture.pluginsDir, 'demo/plugin.json'), 'utf8');
    const previous = await readFile(path.join(fixture.service.workDir, 'previous/demo/plugin.json'), 'utf8')
      .catch(() => null);

    await assert.rejects(fixture.service.rollback(id, input), { code });
    assert.equal(await readFile(fixture.statePath, 'utf8'), before);
    assert.equal(await readFile(path.join(fixture.pluginsDir, 'demo/plugin.json'), 'utf8'), current);
    assert.equal(await readFile(path.join(fixture.service.workDir, 'previous/demo/plugin.json'), 'utf8')
      .catch(() => null), previous);
  });
}

test('M26: полный describe, manual null, dirty previous закрывает rollback, broken id изолирован',
  async (t) => {
    let stamp = Date.parse('2026-11-01T00:00:00.000Z');
    const fixture = await mirrorPair(t, {
      now: () => new Date(stamp),
      seed: async ({ service }) => {
        const broken = installedRecord();

        broken.source = { kind: 'mirror', url: 'mirror://fixture/broken' };
        await service.store.mutate((state) => {
          state.plugins.broken = broken;
          state.nextRevision = 2;
        });
      },
    });
    const before = await fixture.service.store.read();
    const info = await fixture.service.describe('demo');

    assert.equal(await fixture.service.describe('manual'), null);
    assert.deepEqual(info.source, before.plugins.demo.source);
    assert.equal(info.revision, before.plugins.demo.revision);
    assert.equal(info.localChanges, false);
    assert.equal(info.restartRequired, false);
    assert.equal(info.rollbackAvailable, true);
    assert.equal(info.rollbackError, null);
    assert.deepEqual(info.npmDirs, before.plugins.demo.npmDirs);
    assert.equal(info.payloadDigest, before.plugins.demo.payloadDigest);
    await writeFile(path.join(fixture.service.workDir, 'previous/demo/payload.txt'), 'modified');
    stamp += 2001;

    const changed = await fixture.service.describe('demo');

    assert.equal(changed.rollbackAvailable, false);
    assert.equal(changed.rollbackError.code, 'previous_modified');
    assert.equal(changed.localChanges, false);
    assert.equal((await fixture.service.describe('broken')).localChanges, true);
    assert.equal((await fixture.service.describe('demo')).version, '1.1.0');
  });

test('M34: изменения current/previous/revision/force/generated deps после preview отклоняются до effects',
  async (t) => {
    for (const change of ['current', 'previous', 'revision', 'force', 'dependencies']) {
      const fixture = await mirrorPair(t, { npm: change === 'dependencies' });
      const current = path.join(fixture.pluginsDir, 'demo');
      const previous = path.join(fixture.service.workDir, 'previous/demo');

      if (change === 'force') {
        await writeFile(path.join(current, 'payload.txt'), 'first manual change in preview');
      }

      fixture.mirror.release('1.2.0');
      await fixture.service.startUpdate('demo', { replaceModified: change === 'force' });
      await fixture.service.whenIdle();

      const ready = await fixture.service.currentJob();
      const outcomes = [];

      assert.equal(ready.status, 'ready', JSON.stringify(ready.error));
      fixture.service.bindRuntime({
        isLoaded: () => true,
        prepareReplace: async () => ({ finish: async (outcome) => {
          outcomes.push(outcome);
        } }),
        refresh: async () => {},
      });

      if (change === 'revision') {
        await fixture.service.store.mutate((state) => {
          state.plugins.demo.revision = state.nextRevision++;
        });
      } else if (change === 'dependencies') {
        await mkdir(path.join(current, 'node_modules/fixture'), { recursive: true });
        await writeFile(path.join(current, 'node_modules/fixture/index.js'), 'changed generated bytes');
      } else {
        await writeFile(path.join(change === 'previous' ? previous : current, 'payload.txt'),
          'late manual change');
      }

      const currentIdentity = await lstat(current);
      const previousIdentity = await lstat(previous);
      const before = await readFile(fixture.statePath, 'utf8');

      await assert.rejects(fixture.service.apply(ready.id, ready.reviewToken), { code: 'preview_stale' });
      assert.equal((await lstat(current)).ino, currentIdentity.ino);
      assert.equal((await lstat(previous)).ino, previousIdentity.ino);
      assert.equal(await readFile(fixture.statePath, 'utf8'), before);
      assert.deepEqual(outcomes, ['reverted']);
      assert.equal((await fixture.service.currentJob()).status, 'ready');
      assert.equal(JSON.parse(before).apply, null);
    }
  });

test('M37: lost rollback response повторяет request/body; old receipt после нового stale',
  async (t) => {
    const fixture = await mirrorPair(t);
    const input = await rollbackInput(fixture);
    const first = await fixture.service.rollback('demo', input);
    const after = await readFile(fixture.statePath, 'utf8');
    const reordered = {
      expectedPreviousDigest: input.expectedPreviousDigest,
      expectedRevision: input.expectedRevision,
      requestId: input.requestId,
    };

    assert.equal(first.status, 'done');
    await assert.doesNotReject(async () => {
      assert.deepEqual(await fixture.service.rollback('demo', reordered), first);
    });
    assert.equal(await readFile(fixture.statePath, 'utf8'), after);
    await assert.rejects(fixture.service.rollback('demo', {
      ...input,
      expectedPreviousDigest: 'f'.repeat(64),
    }),
      { code: 'preview_stale' });
    assert.equal(await readFile(fixture.statePath, 'utf8'), after);

    const secondInput = await rollbackInput(fixture);
    const second = await fixture.service.rollback('demo', secondInput);
    const secondState = await readFile(fixture.statePath, 'utf8');

    assert.equal(second.status, 'done');
    assert.notEqual(second.id, first.id);
    await assert.rejects(fixture.service.rollback('demo', input), { code: 'preview_stale' });
    assert.equal(await readFile(fixture.statePath, 'utf8'), secondState);
    assert.equal((await fixture.service.store.read()).plugins.demo.version, '1.1.0');
  });

test('M39: blocked удерживает lease/copies и recovery; reverted доказывает прежнюю копию и освобождает lease',
  async (t) => {
    for (const rollback of [false, true]) {
      for (const blocked of [true, false]) {
        const fixture = await mirrorPair(t);
        const current = path.join(fixture.pluginsDir, 'demo');
        const currentIdentity = await lstat(current);
        const prior = (await fixture.service.store.read()).plugins.demo;

        if (!rollback) {
          fixture.mirror.release('1.2.0');
          await fixture.service.startUpdate('demo');
          await fixture.service.whenIdle();
        }

        const ready = await fixture.service.currentJob();
        const finishes = [];
        const fs = createApplyFs({ pluginsDir: fixture.pluginsDir, workDir: fixture.service.workDir });
        const original = fs.rename;
        let failed = false;
        let refreshes = 0;

        fs.rename = async (from, to) => {
          if (to === current && (blocked || !failed)) {
            failed = true;

            throw Object.assign(new Error('fixture candidate/reverse rename EIO'), { code: 'EIO' });
          }

          await original(from, to);
        };
        fixture.service.filesystem = () => fs;
        fixture.service.bindRuntime({
          isLoaded: () => true,
          prepareReplace: async () => ({ finish: async (outcome) => {
            finishes.push(outcome);
          } }),
          refresh: async () => {
            refreshes += 1;
          },
        });

        const result = rollback
          ? await fixture.service.rollback('demo', await rollbackInput(fixture))
          : await fixture.service.apply(ready.id, ready.reviewToken);
        const state = await fixture.service.store.read();

        assert.equal(result.status, blocked ? 'recovery_required' : 'failed');
        assert.deepEqual(finishes, [blocked ? 'blocked' : 'reverted']);
        assert.deepEqual(state.plugins.demo, prior);
        assert.deepEqual(result, state.job);
        assert.equal(refreshes, 0);

        if (blocked) {
          assert.equal(fixture.service.health().code, 'recovery_required');
          assert.equal(result.error.code, 'recovery_required');
          assert.ok(state.apply);
          assert.equal(await readFile(path.join(fixture.service.workDir, 'transactions',
            state.apply.transactionId, 'parked/payload.txt'), 'utf8'), 'version2');

          const candidate = rollback ? path.join(fixture.service.workDir, 'previous/demo')
            : path.join(fixture.service.workDir, 'jobs', ready.id, 'package');

          assert.equal((await lstat(candidate)).isDirectory(), true);
          await assert.rejects(fixture.service.startInstall({ url: 'mirror://fixture/demo' }),
            { code: 'recovery_required' });
          await assert.rejects(fixture.service.startUpdate('demo'), { code: 'recovery_required' });
          await assert.rejects(fixture.service.close(), { code: 'recovery_required' });
          await fixture.service.owner.release();
          fixture.service.owner = null;
          fixture.service.closing = Promise.resolve();
        } else {
          assert.equal(result.error.code, 'apply_failed');
          assert.equal(fixture.service.health(), null);
          assert.equal(state.apply, null);
          assert.equal((await lstat(current)).ino, currentIdentity.ino);
          assert.equal(await readFile(path.join(current, 'payload.txt'), 'utf8'), 'version2');
        }
      }
    }
  });

test('M40: refresh failure сохраняет done/archive и warning, retry исправляет каталог',
  async (t) => {
    for (const rollback of [false, true]) {
      const fixture = await mirrorPair(t);
      let failing = true;

      if (!rollback) {
        fixture.mirror.release('1.2.0');
        await fixture.service.startUpdate('demo');
        await fixture.service.whenIdle();
      }

      const ready = await fixture.service.currentJob();

      fixture.service.bindRuntime({
        isLoaded: () => true,
        prepareReplace: async () => ({ finish: async () => {} }),
        refresh: async () => {
          if (failing) {
            throw new Error('fixture-secret raw scan error');
          }
        },
      });

      const input = rollback ? await rollbackInput(fixture) : null;
      const done = rollback ? await fixture.service.rollback('demo', input)
        : await fixture.service.apply(ready.id, ready.reviewToken);

      assert.equal(done.status, 'done');

      const state = await fixture.service.store.read();

      assert.equal(state.job.status, 'done');
      assert.equal(state.job.error, null);
      assert.equal(state.plugins.demo.version, rollback ? '1.0.0' : '1.2.0');
      assert.equal(state.plugins.demo.previous.version, '1.1.0');
      assert.deepEqual(done, state.job);
      assert.equal(await readFile(path.join(fixture.service.workDir, 'previous/demo/payload.txt'), 'utf8'),
        'version2');
      assert.equal(fixture.service.health().code, 'internal');
      assert.equal(JSON.stringify(fixture.service.health()).includes('fixture-secret'), false);

      const repeated = rollback ? await fixture.service.rollback('demo', input)
        : await fixture.service.apply(ready.id, ready.reviewToken);

      assert.deepEqual(repeated, done);
      failing = false;
      await fixture.service.refreshCatalog();
      assert.equal(fixture.service.health(), null);
      assert.equal((await fixture.service.currentJob()).status, 'done');
      await fixture.service.startUpdate('demo', { version: '9.9.9' });
      await fixture.service.whenIdle();
      assert.equal((await fixture.service.currentJob()).error.code, 'version_not_found');
    }
  });

test('M41: missing current — local_changes, force preview показывает отсутствие, previous сохранён',
  async (t) => {
    const fixture = await mirrorPair(t);
    const previous = await readFile(path.join(fixture.service.workDir, 'previous/demo/payload.txt'), 'utf8');

    await rm(path.join(fixture.pluginsDir, 'demo'), { recursive: true });
    assert.equal((await fixture.service.describe('demo')).localChanges, true);
    await fixture.service.startUpdate('demo');
    await fixture.service.whenIdle();
    assert.equal((await fixture.service.currentJob()).error.code, 'local_changes');
    await fixture.service.startUpdate('demo', { replaceModified: true });
    await fixture.service.whenIdle();

    const ready = await fixture.service.currentJob();

    assert.equal(ready.status, 'ready');
    assert.equal(ready.preview.replaces.kind, 'managed');
    assert.ok(ready.preview.warnings.some((warning) => warning.includes('папка')
      && /отсутств|удал/iu.test(warning)));
    assert.equal((await fixture.service.store.read()).prepared.baseSnapshot.current, null);
    assert.equal((await fixture.service.apply(ready.id, ready.reviewToken)).status, 'done');
    assert.equal((await fixture.service.store.read()).plugins.demo.previous.version, '1.0.0');
    assert.equal(await readFile(path.join(fixture.service.workDir, 'previous/demo/payload.txt'), 'utf8'),
      previous);
  });

test('M42-cache: TTL describe, expiry previous и invalidation после публикации', async (t) => {
  let stamp = Date.parse('2026-11-01T00:00:00.000Z');
  const fixture = await mirrorPair(t, { now: () => new Date(stamp) });
  const source = fixture.mirror.source;
  const original = source.inspectInstalled;
  let inspections = 0;

  source.inspectInstalled = async (...args) => {
    inspections += 1;

    return original(...args);
  };

  assert.equal((await fixture.service.describe('demo')).rollbackAvailable, true);
  assert.equal(inspections, 2);
  await fixture.service.describe('demo');
  assert.equal(inspections, 2, 'повтор GET не хеширует/inspect обе копии снова');
  await writeFile(path.join(fixture.service.workDir, 'previous/demo/payload.txt'), 'late previous change');
  assert.equal((await fixture.service.describe('demo')).rollbackAvailable, true,
    'краткий cache ещё действует');
  stamp += 2001;
  assert.equal((await fixture.service.describe('demo')).rollbackError.code, 'previous_modified');
  await writeFile(path.join(fixture.service.workDir, 'previous/demo/payload.txt'), 'version1');
  fixture.mirror.release('1.2.0');
  await fixture.service.startUpdate('demo');
  await fixture.service.whenIdle();

  const ready = await fixture.service.currentJob();

  assert.equal((await fixture.service.apply(ready.id, ready.reviewToken)).status, 'done');

  const fresh = await fixture.service.describe('demo');

  assert.equal(fresh.version, '1.2.0');
  assert.equal(fresh.localChanges, false);
  assert.equal(fresh.rollbackAvailable, true);
  assert.equal(fresh.rollbackError, null);
});

test('M44: после 32 новых terminal outcomes старый done отсутствует и новый instance не повторяет apply',
  async (t) => {
    const fixture = await mirrorPair(t);
    const old = await fixture.service.currentJob();

    for (let index = 0; index < 33; index += 1) {
      await fixture.service.startUpdate('demo', { version: '9.9.9' });
      await fixture.service.whenIdle();
      assert.equal((await fixture.service.currentJob()).status, 'failed');
    }

    const retained = await fixture.service.store.read();

    assert.equal(Object.keys(retained.completedJobs).length, 32);
    assert.equal(Object.hasOwn(retained.completedJobs, old.id), false);
    await fixture.service.close();

    const { PluginInstallService } = await import('../../server/src/lib/packageInstall/service.ts');
    const next = new PluginInstallService(fixture.service.options);

    next.bindRuntime({
      isLoaded: () => false,
      prepareReplace: async () => ({ finish: async () => {} }),
      refresh: async () => {},
    });

    try {
      assert.deepEqual((await next.recover()).blockedIds, []);

      const before = await readFile(fixture.statePath, 'utf8');

      await assert.rejects(next.getJob(old.id), { code: 'job_not_found' });
      await assert.rejects(next.apply(old.id, old.reviewToken), { code: 'job_not_found' });
      assert.equal(await readFile(fixture.statePath, 'utf8'), before);
      assert.equal(Object.keys((await next.store.read()).completedJobs).length, 32);
      assert.equal((await next.store.read()).plugins.demo.version, '1.1.0');
    } finally {
      await next.close();
    }
  });
