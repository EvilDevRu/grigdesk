import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, rename as nativeRename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { applyIntent, recoverApply } from '../../server/src/lib/pluginInstall/applyPackage.ts';
import { createApplyFixture } from './helpers/pluginApplyFixture.js';
import { computePayloadDigest } from '../../server/src/lib/pluginInstall/payloadDigest.ts';
import { PluginInstallStateStore } from '../../server/src/lib/pluginInstall/stateStore.ts';
import { writeDurableFile } from '../../server/src/lib/durableFile.ts';

test('A1: fresh install атомарно публикует record/done, candidate становится current', async (t) => {
  const fixture = await createApplyFixture(t);
  const writes = [];
  const originalWrite = fixture.store.options.write;

  fixture.store.options.write = async (file, text) => {
    const { writeDurableFile } = await import('../../server/src/lib/durableFile.ts');

    writes.push(JSON.parse(text));
    await (originalWrite ?? writeDurableFile)(file, text);
  };

  const result = await applyIntent(fixture.intent, fixture.store, fixture.fs);
  const state = await fixture.store.read();

  assert.equal(result.outcome, 'completed');
  assert.equal(await readFile(path.join(fixture.current, 'marker.txt'), 'utf8'), 'new');
  assert.equal(await lstat(fixture.candidate).catch(() => null), null);
  assert.deepEqual(state.plugins.demo, fixture.intent.targetRecord);
  assert.equal(state.plugins.demo.previous, null);
  assert.equal(state.job.status, 'done');
  assert.equal(state.apply, null);
  assert.equal(state.completedJobs[state.job.id].status, 'done');
  assert.ok(writes.some((entry) => entry.plugins.demo?.revision === 2 && entry.job.status === 'done'
    && entry.apply === null), 'record и done в одной durable записи');
  assert.ok(writes[0].apply, 'intent опубликован до rename');
});

test('A2: update архивирует current в previous, retired удаляется только после commit', async (t) => {
  const fixture = await createApplyFixture(t, { kind: 'update', withPrevious: true });
  const remove = fixture.fs.removeCleanup;
  let observedRetired = false;
  let result;

  fixture.fs.removeCleanup = async (entry) => {
    const state = await fixture.store.read();

    assert.equal(state.job.status, 'done');
    assert.equal(state.plugins.demo.version, '1.1.0');

    if (entry.kind === 'transaction') {
      assert.equal(await readFile(path.join(fixture.transaction, 'retired/marker.txt'), 'utf8'), 'older');
      observedRetired = true;
    }

    await remove(entry);
  };
  await assert.doesNotReject(async () => {
    result = await applyIntent(fixture.intent, fixture.store, fixture.fs);
  });

  const state = await fixture.store.read();

  assert.equal(result.outcome, 'completed');
  assert.equal(await readFile(path.join(fixture.current, 'marker.txt'), 'utf8'), 'new');
  assert.equal(await readFile(path.join(fixture.previous, 'marker.txt'), 'utf8'), 'old');
  assert.equal(state.plugins.demo.previous.version, '1.0.0');
  assert.equal(await lstat(path.join(fixture.transaction, 'retired')).catch(() => null), null);
  assert.equal(state.job.status, 'done');
  assert.equal(observedRetired, true);
});

test('A3: unmanaged/modified copy сохраняется целиком в replaced без потери previous', async (t) => {
  for (const unmanaged of [true, false]) {
    const fixture = await createApplyFixture(t, {
      kind: unmanaged ? 'install' : 'update',
      unmanaged,
      withPrevious: !unmanaged,
    });

    await writeFile(path.join(fixture.current, 'hidden-private.txt'), 'preserve old copy');

    if (!unmanaged) {
      fixture.intent.current.payloadDigest = await computePayloadDigest(fixture.current);
      fixture.intent.destination = 'replaced';
      fixture.intent.archiveKey = `demo-20260101T000000000Z-${fixture.intent.transactionId}`;
      fixture.intent.targetRecord.previous = fixture.intent.baseRecord.previous;
    }

    const archive = path.join(fixture.roots.workDir, 'replaced', fixture.intent.archiveKey);
    const result = await applyIntent(fixture.intent, fixture.store, fixture.fs);

    assert.equal(result.outcome, 'completed');
    assert.equal(await readFile(path.join(archive, 'hidden-private.txt'), 'utf8').catch(() => null),
      'preserve old copy');
    assert.equal(await readFile(path.join(archive, 'marker.txt'), 'utf8'), 'old');
    assert.equal((await fixture.store.read()).job.backupRef, fixture.intent.archiveKey);

    if (!unmanaged) {
      assert.equal(await readFile(path.join(fixture.previous, 'marker.txt'), 'utf8'), 'older');
      assert.equal((await fixture.store.read()).plugins.demo.previous.version, '0.9.0');
    }
  }
});

test('A4: отказ candidate→current возвращает parked и подтверждённый apply_failed', async (t) => {
  const fixture = await createApplyFixture(t, { kind: 'update', withPrevious: true });
  const rename = fixture.fs.rename;
  let failed = false;
  let result;

  fixture.fs.rename = async (from, to) => {
    if (from === fixture.candidate && !failed) {
      failed = true;

      throw Object.assign(new Error('synthetic rename failure'), { code: 'EIO' });
    }

    await rename(from, to);
  };
  await assert.doesNotReject(async () => {
    result = await applyIntent(fixture.intent, fixture.store, fixture.fs);
  });

  const state = await fixture.store.read();

  assert.equal(result.outcome, 'reverted');
  assert.equal(result.error.code, 'apply_failed');
  assert.equal(await readFile(path.join(fixture.current, 'marker.txt'), 'utf8'), 'old');
  assert.equal(await readFile(path.join(fixture.previous, 'marker.txt'), 'utf8'), 'older');
  assert.deepEqual(state.plugins.demo, fixture.intent.baseRecord);
  assert.equal(state.job.status, 'failed');
  assert.equal(state.apply, null);
});

/**
 * Снимок filesystem представляет crash между эффектом и записью фазы.
 * Настоящий process-crash отдельно проверяется матрицей IPC barriers в A16.
 */
async function publishIntent(fixture) {
  await fixture.store.mutate((state) => {
    state.apply = structuredClone(fixture.intent);
    state.job.status = 'applying';
  });
  await fixture.fs.ensureDir(fixture.transaction);
}

test('A5: prepared после current→parked возвращает старую копию', async (t) => {
  const fixture = await createApplyFixture(t, { kind: 'update' });

  await publishIntent(fixture);
  await fixture.fs.rename(fixture.current, path.join(fixture.transaction, 'parked'));

  const result = await recoverApply(fixture.store, fixture.fs);

  assert.equal(result.outcome, 'reverted');
  assert.equal(await readFile(path.join(fixture.current, 'marker.txt'), 'utf8'), 'old');
  assert.deepEqual((await fixture.store.read()).plugins.demo, fixture.intent.baseRecord);
  assert.equal((await fixture.store.read()).apply, null);
});

test('A6: новый current узнаётся после rename до durable installed', async (t) => {
  const fixture = await createApplyFixture(t, { kind: 'update', withPrevious: true });

  await publishIntent(fixture);
  await fixture.fs.rename(fixture.current, path.join(fixture.transaction, 'parked'));
  await fixture.fs.rename(fixture.candidate, fixture.current);

  const result = await recoverApply(fixture.store, fixture.fs);
  const state = await fixture.store.read();

  assert.equal(result.outcome, 'completed');
  assert.equal(await readFile(path.join(fixture.current, 'marker.txt'), 'utf8'), 'new');
  assert.equal(await readFile(path.join(fixture.previous, 'marker.txt'), 'utf8'), 'old');
  assert.deepEqual(state.plugins.demo, fixture.intent.targetRecord);
  assert.equal(state.job.status, 'done');
  assert.equal(state.apply, null);
});

test('A7: durable prepared без rename отменяется без перемещений', async (t) => {
  for (const kind of ['install', 'update']) {
    const fixture = await createApplyFixture(t, { kind });

    await publishIntent(fixture);

    let moves = 0;
    const rename = fixture.fs.rename;

    fixture.fs.rename = async (...args) => {
      moves += 1;
      await rename(...args);
    };

    const result = await recoverApply(fixture.store, fixture.fs);

    assert.equal(result.outcome, 'reverted');
    assert.equal(moves, 0);
    assert.equal((await fixture.store.read()).apply, null);

    if (kind === 'update') {
      assert.equal(await readFile(path.join(fixture.current, 'marker.txt'), 'utf8'), 'old');
    } else {
      assert.equal(await lstat(fixture.current).catch(() => null), null);
    }
  }
});

test('A8: recovery идемпотентно заканчивает installed/retired/archived без второго архива', async (t) => {
  for (const point of ['retired', 'parked', 'archived']) {
    const fixture = await createApplyFixture(t, { kind: 'update', withPrevious: true });

    await publishIntent(fixture);
    await fixture.fs.rename(fixture.current, path.join(fixture.transaction, 'parked'));
    await fixture.fs.rename(fixture.candidate, fixture.current);

    if (point !== 'parked') {
      await fixture.fs.rename(fixture.previous, path.join(fixture.transaction, 'retired'));
    }

    if (point === 'archived') {
      await fixture.fs.rename(path.join(fixture.transaction, 'parked'), fixture.previous);
    }

    await fixture.store.mutate((state) => {
      state.apply.phase = 'installed';
    });

    let result;

    await assert.doesNotReject(async () => {
      result = await recoverApply(fixture.store, fixture.fs);
    });
    assert.equal(result.outcome, 'completed');

    const completed = await fixture.store.read();
    const second = await recoverApply(fixture.store, fixture.fs);

    assert.equal(second.outcome, 'none');
    assert.deepEqual(await fixture.store.read(), completed);
    assert.equal(await readFile(path.join(fixture.current, 'marker.txt'), 'utf8'), 'new');
    assert.equal(await readFile(path.join(fixture.previous, 'marker.txt'), 'utf8'), 'old');
  }
});

test('A9: rollback после archive различает previous=старый current и публикует исходный receipt',
  async (t) => {
  const fixture = await createApplyFixture(t, { kind: 'rollback' });

  fixture.intent.targetRecord.source = { kind: 'mirror', url: 'mirror://fixture/repository' };
  fixture.intent.baseRecord.previous.source = fixture.intent.targetRecord.source;
  await fixture.store.mutate((state) => {
    state.plugins.demo = fixture.intent.baseRecord;
    state.job.source = fixture.intent.targetRecord.source;
    state.job.preview.source = state.job.source;
  });
  await publishIntent(fixture);
  await fixture.fs.rename(fixture.current, path.join(fixture.transaction, 'parked'));
  await fixture.fs.rename(fixture.previous, fixture.current);
  await fixture.fs.rename(path.join(fixture.transaction, 'parked'), fixture.previous);

  const result = await recoverApply(fixture.store, fixture.fs);
  const state = await fixture.store.read();

  assert.equal(result.outcome, 'completed');
  assert.equal(await readFile(path.join(fixture.current, 'marker.txt'), 'utf8'), 'new');
  assert.equal(await readFile(path.join(fixture.previous, 'marker.txt'), 'utf8'), 'old');
  assert.deepEqual(state.plugins.demo, fixture.intent.targetRecord);
  assert.deepEqual(state.lastRollback.demo, {
    ...fixture.intent.rollbackReceiptInput,
    job: state.completedJobs[fixture.intent.jobId],
  });
  assert.equal((await recoverApply(fixture.store, fixture.fs)).outcome, 'none');
  assert.deepEqual(await fixture.store.read(), state);
});

test('A10: без intent recovery ничего не меняет и не превращает committed done в interrupted', async (t) => {
  const fixture = await createApplyFixture(t);

  assert.equal((await applyIntent(fixture.intent, fixture.store, fixture.fs)).outcome, 'completed');

  const before = await fixture.store.read();
  const result = await recoverApply(fixture.store, fixture.fs);

  assert.equal(result.outcome, 'none');
  assert.deepEqual(await fixture.store.read(), before);
  assert.equal(before.job.status, 'done');
});

/**
 * Адаптер выполняет настоящие операции и может отказать ровно перед выбранным эффектом.
 * Последующий recovery получает свежий store и больше не знает о fault injection.
 */
function observeEffects(fixture, failAt = -1) {
  const events = [];
  let failed = false;

  for (const method of ['rename', 'syncDir', 'ensureDir', 'removeCleanup']) {
    const original = fixture.fs[method];

    fixture.fs[method] = async (...args) => {
      const index = events.length;

      events.push(method);

      if (index === failAt) {
        failed = true;

        throw Object.assign(new Error('synthetic filesystem fault'), { code: 'EIO' });
      }

      return original(...args);
    };
  }

  fixture.store.options.write = async (file, text) => {
    const index = events.length;

    events.push('state-write');

    if (index === failAt) {
      failed = true;

      throw Object.assign(new Error('synthetic durable fault'), { code: 'EIO' });
    }

    await writeDurableFile(file, text);
  };

  return { events, failed: () => failed };
}

test('A11: отказ каждого rename/syncDir/ensureDir/durable write сохраняет доказуемый итог и копии',
  async (t) => {
    const baseline = await createApplyFixture(t, { kind: 'update', withPrevious: true });
    const trace = observeEffects(baseline);

    assert.equal((await applyIntent(baseline.intent, baseline.store, baseline.fs)).outcome, 'completed');
    assert.ok(trace.events.includes('rename') && trace.events.includes('syncDir')
      && trace.events.includes('state-write'));

    for (let failAt = 0; failAt < trace.events.length; failAt += 1) {
      const fixture = await createApplyFixture(t, { kind: 'update', withPrevious: true });
      const observer = observeEffects(fixture, failAt);
      let result;

      await assert.doesNotReject(async () => {
        result = await applyIntent(fixture.intent, fixture.store, fixture.fs);
      }, `effect ${failAt}: ${trace.events[failAt]}`);
      assert.equal(observer.failed(), true, 'каждая выбранная точка действительно выполнена');
      assert.ok(['completed', 'reverted', 'blocked'].includes(result.outcome), `effect ${failAt}`);

      const freshStore = new PluginInstallStateStore({
        statePath: fixture.statePath,
        hasWorkEvidence: async () => true,
      });
      const recovered = await recoverApply(freshStore, fixture.fs);
      const state = await freshStore.read();
      const marker = await readFile(path.join(fixture.current, 'marker.txt'), 'utf8').catch(() => null);

      assert.ok(['none', 'completed', 'reverted', 'blocked'].includes(recovered.outcome));

      if (state.apply === null && state.job.status === 'done') {
        assert.equal(marker, 'new');
        assert.deepEqual(state.plugins.demo, fixture.intent.targetRecord);
        assert.equal(await readFile(path.join(fixture.previous, 'marker.txt'), 'utf8'), 'old');
      } else if (state.apply === null && state.job.status === 'failed') {
        assert.equal(marker, 'old');
        assert.deepEqual(state.plugins.demo, fixture.intent.baseRecord);
        assert.equal(await readFile(path.join(fixture.previous, 'marker.txt'), 'utf8'), 'older');
      } else {
        assert.ok(await lstat(fixture.candidate).catch(() => null)
          || marker === 'new', 'новая копия сохранена');
        assert.ok(marker === 'old' || await lstat(path.join(fixture.transaction, 'parked')).catch(() => null)
          || await lstat(fixture.previous).catch(() => null), 'старая копия сохранена');
      }
    }
  });

test('A12: отказ обратного rename сохраняет parked/intent и запрещает cleanup', async (t) => {
  const fixture = await createApplyFixture(t, { kind: 'update', withPrevious: true });
  const parked = path.join(fixture.transaction, 'parked');

  await publishIntent(fixture);
  await fixture.fs.rename(fixture.current, parked);

  const rename = fixture.fs.rename;
  let removals = 0;

  fixture.fs.rename = async (from, to) => {
    if (from === parked && to === fixture.current) {
      throw Object.assign(new Error('synthetic reverse rename failure'), { code: 'EIO' });
    }

    await rename(from, to);
  };
  fixture.fs.removeCleanup = async () => {
    removals += 1;
  };

  const result = await recoverApply(fixture.store, fixture.fs);
  const state = await fixture.store.read();

  assert.equal(result.outcome, 'blocked');
  assert.equal(result.error.code, 'recovery_required');
  assert.equal(state.job.status, 'recovery_required');
  assert.equal(state.apply.transactionId, fixture.intent.transactionId);
  assert.equal(await readFile(path.join(parked, 'marker.txt'), 'utf8'), 'old');
  assert.equal(await readFile(path.join(fixture.candidate, 'marker.txt'), 'utf8'), 'new');
  assert.equal(removals, 0);
  assert.deepEqual(state.cleanup, []);
});

test('A13: ошибка fsync после published commit узнаёт done/record/receipt без повторной замены',
  async (t) => {
  const fixture = await createApplyFixture(t, { kind: 'rollback' });
  let uncertain = false;

  fixture.store.options.write = async (file, text) => {
    await writeDurableFile(file, text);

    const state = JSON.parse(text);

    if (!uncertain && state.apply === null && state.job.status === 'done') {
      uncertain = true;

      throw Object.assign(new Error('synthetic post-rename fsync failure'), { code: 'EIO' });
    }
  };

  const result = await applyIntent(fixture.intent, fixture.store, fixture.fs);
  const state = await fixture.store.read();

  assert.equal(uncertain, true);
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(state.plugins.demo, fixture.intent.targetRecord);
  assert.equal(state.job.status, 'done');
  assert.deepEqual(state.lastRollback.demo, {
    ...fixture.intent.rollbackReceiptInput,
    job: state.completedJobs[fixture.intent.jobId],
  });
  assert.equal(await readFile(path.join(fixture.current, 'marker.txt'), 'utf8'), 'new');
  assert.equal(await readFile(path.join(fixture.previous, 'marker.txt'), 'utf8'), 'old');
});

test('A14: отказ cleanup после commit сохраняет entry и повторяется без failed install', async (t) => {
  for (const failedKind of ['job', 'transaction']) {
    const fixture = await createApplyFixture(t, { kind: 'update', withPrevious: true });
    const remove = fixture.fs.removeCleanup;

    fixture.fs.removeCleanup = async (entry) => {
      if (entry.kind === failedKind) {
        throw Object.assign(new Error('synthetic cleanup failure'), { code: 'EIO' });
      }

      await remove(entry);
    };

    const result = await applyIntent(fixture.intent, fixture.store, fixture.fs);
    const state = await fixture.store.read();

    assert.equal(result.outcome, 'completed');
    assert.equal(state.job.status, 'done');
    assert.ok(state.cleanup.some((entry) => entry.kind === failedKind));
    assert.equal(await readFile(path.join(fixture.current, 'marker.txt'), 'utf8'), 'new');
    assert.equal(await readFile(path.join(fixture.previous, 'marker.txt'), 'utf8'), 'old');
    fixture.fs.removeCleanup = remove;

    const recovered = await recoverApply(new PluginInstallStateStore({
      statePath: fixture.statePath,
      hasWorkEvidence: async () => true,
    }), fixture.fs);

    assert.equal(recovered.outcome, 'none');
    assert.deepEqual((await fixture.store.read()).cleanup, []);
    assert.equal(await lstat(fixture.transaction).catch(() => null), null);
    assert.equal(await lstat(fixture.jobDir).catch(() => null), null);
    assert.equal((await fixture.store.read()).job.status, 'done');
  }
});

test('A15: неизвестные copies/digest/archive/ancestor и разные FS блокируют rename/remove', async (t) => {
  for (const variant of ['archive-conflict', 'missing', 'foreign-current', 'digest', 'ancestor', 'EXDEV']) {
    const unmanaged = ['archive-conflict', 'ancestor'].includes(variant);
    const fixture = await createApplyFixture(t, { kind: unmanaged ? 'install' : 'update', unmanaged });

    if (variant === 'archive-conflict') {
      const archive = path.join(fixture.roots.workDir, 'replaced', fixture.intent.archiveKey);

      await mkdir(archive);
      await writeFile(path.join(archive, 'marker.txt'), 'foreign archive');
    } else if (variant === 'missing') {
      await rm(fixture.current, { recursive: true });
      await rm(fixture.candidate, { recursive: true });
    } else if (variant === 'foreign-current') {
      await nativeRename(fixture.current, path.join(fixture.root, 'saved-current'));
      await mkdir(fixture.current);
      await writeFile(path.join(fixture.current, 'marker.txt'), 'foreign');
    } else if (variant === 'digest') {
      await writeFile(path.join(fixture.candidate, 'marker.txt'), 'tampered');
    } else if (variant === 'ancestor') {
      await nativeRename(fixture.roots.pluginsDir, path.join(fixture.root, 'actual-plugins'));
      await symlink(path.join(fixture.root, 'actual-plugins'), fixture.roots.pluginsDir);
    } else {
      assert.notEqual((await lstat('/dev/shm')).dev, (await lstat(fixture.roots.pluginsDir)).dev);
      fixture.fs.roots.workDir = '/dev/shm';
    }

    let moves = 0;
    let removals = 0;
    const rename = fixture.fs.rename;

    fixture.fs.rename = async (...args) => {
      moves += 1;
      await rename(...args);
    };
    fixture.fs.removeCleanup = async () => {
      removals += 1;
    };

    const result = await applyIntent(fixture.intent, fixture.store, fixture.fs);

    assert.equal(result.outcome, 'blocked', variant);
    assert.equal(moves, 0, `${variant}: до опасного эффекта`);
    assert.equal(removals, 0);

    if (variant === 'archive-conflict') {
      const archive = path.join(fixture.roots.workDir, 'replaced', fixture.intent.archiveKey);

      assert.equal(await readFile(path.join(archive, 'marker.txt'), 'utf8'), 'foreign archive');
      assert.equal(await readFile(path.join(fixture.current, 'marker.txt'), 'utf8'), 'old');
    }
  }

  const cleanup = await createApplyFixture(t, { kind: 'update', withPrevious: true });
  const remove = cleanup.fs.removeCleanup;

  cleanup.fs.removeCleanup = async (entry) => {
    if (entry.kind === 'transaction') {
      throw new Error('synthetic delayed cleanup');
    }

    await remove(entry);
  };
  assert.equal((await applyIntent(cleanup.intent, cleanup.store, cleanup.fs)).outcome, 'completed');

  const retired = path.join(cleanup.transaction, 'retired');

  await nativeRename(retired, path.join(cleanup.root, 'saved-retired'));
  await mkdir(retired);
  await writeFile(path.join(retired, 'marker.txt'), 'foreign retired');
  cleanup.fs.removeCleanup = remove;
  await recoverApply(cleanup.store, cleanup.fs);
  assert.equal(await readFile(path.join(retired, 'marker.txt'), 'utf8').catch(() => null), 'foreign retired');
  assert.ok((await cleanup.store.read()).cleanup.some((entry) => entry.kind === 'transaction'));
});

test('A18: state error, orphan work и недостоверный worker не разрешают сигналы/cleanup/import',
  async (t) => {
  for (const variant of ['worker', 'broken', 'unreadable', 'orphan']) {
    const fixture = await createApplyFixture(t, { kind: 'update', importMarker: true });

    await publishIntent(fixture);

    if (variant === 'worker') {
      const commandId = randomUUID();

      await fixture.store.mutate((state) => {
        state.workers[commandId] = {
          commandId,
          supervisorPid: process.ppid,
          supervisorStartTime: '1',
          pid: process.pid,
          pgid: process.pid,
          startTime: '1',
        };
      });
    } else if (variant === 'broken') {
      await writeFile(fixture.statePath, '{broken');
    } else if (variant === 'unreadable') {
      fixture.store.options.readText = async () => {
        throw Object.assign(new Error('synthetic unreadable state'), { code: 'EACCES' });
      };
    } else {
      await fixture.fs.rename(fixture.current, path.join(fixture.transaction, 'parked'));
      await rm(fixture.statePath);
    }

    const before = await readFile(fixture.statePath, 'utf8').catch(() => null);
    const signals = [];
    const mockKill = t.mock.method(process, 'kill', (...args) => {
      signals.push(args);

      return true;
    });
    let effects = 0;

    for (const method of ['rename', 'removeCleanup', 'ensureDir']) {
      const original = fixture.fs[method];

      fixture.fs[method] = async (...args) => {
        effects += 1;

        return original(...args);
      };
    }

    const result = await recoverApply(fixture.store, fixture.fs);

    mockKill.mock.restore();
    assert.equal(result.outcome, 'blocked', variant);
    assert.deepEqual(signals, []);
    assert.equal(effects, 0);
    assert.equal(await readFile(path.join(fixture.candidate, 'marker.txt'), 'utf8'), 'new');
    assert.equal(await lstat(path.join(fixture.root, 'import-marker')).catch(() => null), null);

    const serverDir = variant === 'orphan' ? path.join(fixture.transaction, 'parked') : fixture.current;

    await import(pathToFileURL(path.join(serverDir, 'server.js')).href);
    assert.equal(await readFile(path.join(fixture.root, 'import-marker'), 'utf8'), 'loaded',
      'positive control: fixture действительно заметил бы import');

    if (variant !== 'worker') {
      assert.equal(await readFile(fixture.statePath, 'utf8').catch(() => null), before);
    } else {
      assert.equal(Object.keys((await fixture.store.read()).workers).length, 1);
      assert.equal((await fixture.store.read()).apply.transactionId, fixture.intent.transactionId);
    }
  }
});

test('A15b: malformed входной intent отклоняется до чтения participant paths', async (t) => {
  for (const variant of ['id', 'uuid', 'identity-path']) {
    const fixture = await createApplyFixture(t);
    const intent = structuredClone(fixture.intent);
    const original = fixture.fs.lstatIdentity;
    let reads = 0;

    if (variant === 'id') {
      intent.pluginId = '../external';
    } else if (variant === 'uuid') {
      intent.jobId = '../external';
    } else {
      intent.candidate.path = '/external';
    }

    fixture.fs.lstatIdentity = async (...args) => {
      reads += 1;

      return original(...args);
    };

    const before = await readFile(fixture.statePath, 'utf8');
    const result = await applyIntent(intent, fixture.store, fixture.fs);

    assert.equal(result.outcome, 'blocked');
    assert.equal(reads, 0);
    assert.equal(await readFile(fixture.statePath, 'utf8'), before);
  }
});

test('A18b: повтор blocked recovery не меняет job revision и сохранённые копии', async (t) => {
  const fixture = await createApplyFixture(t, { kind: 'update' });

  await publishIntent(fixture);
  await fixture.fs.rename(fixture.current, path.join(fixture.transaction, 'parked'));
  fixture.fs.rename = async () => {
    throw Object.assign(new Error('synthetic persistent reverse failure'), { code: 'EIO' });
  };
  assert.equal((await recoverApply(fixture.store, fixture.fs)).outcome, 'blocked');

  const first = await fixture.store.read();

  assert.equal((await recoverApply(fixture.store, fixture.fs)).outcome, 'blocked');
  assert.deepEqual(await fixture.store.read(), first);
  assert.equal(await readFile(path.join(fixture.transaction, 'parked/marker.txt'), 'utf8'), 'old');
});

test('A15c: production layout plugins/.cockpit-install поддерживает install и recovery', async (t) => {
  const fixture = await createApplyFixture(t, { workInside: true });

  assert.equal((await applyIntent(fixture.intent, fixture.store, fixture.fs)).outcome, 'completed');
  assert.equal(await readFile(path.join(fixture.current, 'marker.txt'), 'utf8'), 'new');
  assert.equal((await recoverApply(fixture.store, fixture.fs)).outcome, 'none');
});
