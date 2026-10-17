import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createApplyFixture } from './helpers/pluginApplyFixture.js';
import { runApplyChild } from './helpers/pluginApplyProcess.js';
import { getRollbackReceipt } from '../../server/src/lib/pluginInstall/stateStore.ts';

/**
 * Disk outcome сопоставляется с настоящими bytes и полными snapshots.
 * Ни один опубликованный done не может совпасть со старой current копией.
 */
async function assertRecovered(fixture) {
  const state = await fixture.store.read();
  const current = await readFile(path.join(fixture.current, 'marker.txt'), 'utf8').catch(() => null);

  if (state.job.status === 'done') {
    assert.equal(current, 'new');
    assert.deepEqual(state.plugins.demo, fixture.intent.targetRecord);
    assert.equal(state.apply, null);
    assert.equal(state.completedJobs[fixture.intent.jobId].status, 'done');

    if (fixture.intent.destination === 'previous') {
      assert.equal(await readFile(path.join(fixture.previous, 'marker.txt'), 'utf8'), 'old');
    } else if (fixture.intent.destination === 'replaced') {
      const archive = path.join(fixture.roots.workDir, 'replaced', fixture.intent.archiveKey);

      assert.equal(await readFile(path.join(archive, 'marker.txt'), 'utf8'), 'old');
      assert.equal(state.job.backupRef, fixture.intent.archiveKey);
    }

    if (fixture.intent.kind === 'rollback') {
      assert.deepEqual(state.lastRollback.demo, {
        ...fixture.intent.rollbackReceiptInput,
        job: state.completedJobs[fixture.intent.jobId],
      });
    }
  } else if (state.job.status === 'failed' || state.job.status === 'ready') {
    assert.equal(current, fixture.intent.current ? 'old' : null);
    assert.deepEqual(state.plugins.demo ?? null, fixture.intent.baseRecord);
    assert.equal(state.apply, null);
  } else {
    assert.ok(await lstat(fixture.candidate).catch(() => null) || current === 'new', 'target copy сохранена');
    assert.ok(!fixture.intent.current || current === 'old'
      || await lstat(path.join(fixture.transaction, 'parked')).catch(() => null)
      || await lstat(fixture.previous).catch(() => null), 'old copy сохранена');
  }

  return state;
}

test('A16: SIGKILL на каждом эффекте/до и после durable write, новый resolver для четырёх операций',
  async (t) => {
    const operations = [
      { kind: 'install' },
      { kind: 'update', withPrevious: true },
      { kind: 'install', unmanaged: true },
      { kind: 'rollback' },
    ];
    let crashes = 0;

    for (const operation of operations) {
      const baseline = await createApplyFixture(t, operation);
      const completed = await runApplyChild(baseline);

      assert.equal(completed.result.outcome, 'completed');
      assert.ok(completed.trace.some((event) => event.startsWith('before:write:')));
      assert.ok(completed.trace.some((event) => event.startsWith('after:write:')));
      assert.ok(completed.trace.includes('after:rename'));

      for (let barrierAt = 0; barrierAt < completed.trace.length; barrierAt += 1) {
        const fixture = await createApplyFixture(t, operation);

        await runApplyChild(fixture, { barrierAt });

        const recovered = await runApplyChild(fixture, { operation: 'recover' });

        assert.ok(['none', 'completed', 'reverted', 'blocked'].includes(recovered.result.outcome));

        const first = await assertRecovered(fixture);

        await runApplyChild(fixture, { operation: 'recover' });
        assert.deepEqual(await assertRecovered(fixture), first, 'повтор recovery не меняет итог');
        crashes += 1;
      }
    }

    t.diagnostic(`${crashes} настоящих SIGKILL barriers, install/update/replacement/rollback`);
  });

test('A17: SIGKILL после commit до ACK сохраняет done и прежний rollback receipt', async (t) => {
  const baseline = await createApplyFixture(t, { kind: 'rollback' });
  const complete = await runApplyChild(baseline);
  const barrierAt = complete.trace.indexOf('after:write:done');

  assert.ok(barrierAt >= 0);

  const fixture = await createApplyFixture(t, { kind: 'rollback' });

  await runApplyChild(fixture, { barrierAt });

  const committed = await fixture.store.read();

  assert.equal(committed.job.status, 'done');
  assert.ok(committed.cleanup.length > 0, 'ACK и cleanup ещё не выполнены');
  await runApplyChild(fixture, { operation: 'recover' });

  const recovered = await assertRecovered(fixture);

  assert.equal(recovered.job.status, 'done');
  assert.deepEqual(recovered.lastRollback.demo, committed.lastRollback.demo);
  assert.deepEqual(recovered.plugins, committed.plugins);
  await runApplyChild(fixture, { operation: 'recover' });
  assert.deepEqual(await fixture.store.read(), recovered);
});

test('A19: rollback SIGKILL после candidate→current восстанавливает исходный input и repeat receipt',
  async (t) => {
    const baseline = await createApplyFixture(t, { kind: 'rollback' });
    const complete = await runApplyChild(baseline);
    const renames = complete.trace.flatMap((event, index) => event === 'after:rename' ? [index] : []);
    const fixture = await createApplyFixture(t, { kind: 'rollback' });
    const input = structuredClone(fixture.intent.rollbackReceiptInput);

    await runApplyChild(fixture, { barrierAt: renames[1] });

    const interrupted = await fixture.store.read();

    assert.deepEqual(interrupted.apply.rollbackReceiptInput, input, 'input устойчив до первого rename');
    assert.equal(interrupted.lastRollback.demo, undefined, 'commit и receipt ещё не опубликованы');
    await runApplyChild(fixture, { operation: 'recover' });

    const restored = await assertRecovered(fixture);
    const response = getRollbackReceipt(restored, 'demo', input);

    assert.deepEqual(response, restored.job, 'повтор исходного запроса получает прежний job');
    assert.throws(() => getRollbackReceipt(restored, 'demo', { ...input, inputHash: 'f'.repeat(64) }), {
      code: 'preview_stale',
    });
    await runApplyChild(fixture, { operation: 'recover' });
    assert.deepEqual(await fixture.store.read(), restored);
    assert.equal(await readFile(path.join(fixture.previous, 'marker.txt'), 'utf8'), 'old');
  });

test('A20: replacement SIGKILL после archive сохраняет один archiveKey при другом now', async (t) => {
  const baseline = await createApplyFixture(t, { kind: 'install', unmanaged: true });
  const complete = await runApplyChild(baseline);
  const renames = complete.trace.flatMap((event, index) => event === 'after:rename' ? [index] : []);
  const fixture = await createApplyFixture(t, { kind: 'install', unmanaged: true });

  await runApplyChild(fixture, { barrierAt: renames[2] });

  const key = fixture.intent.archiveKey;
  const archived = path.join(fixture.roots.workDir, 'replaced', key);

  assert.equal((await fixture.store.read()).apply.archiveKey, key);
  assert.equal(await readFile(path.join(archived, 'marker.txt'), 'utf8'), 'old');

  const recovered = await runApplyChild(fixture, { operation: 'recover', now: '2029-09-09T09:09:09.999Z' });

  assert.equal(recovered.result.outcome, 'completed');

  const state = await fixture.store.read();

  assert.equal(state.job.backupRef, key);
  assert.deepEqual(await readdir(path.dirname(archived)), [key]);
  await runApplyChild(fixture, { operation: 'recover', now: '2035-01-01T00:00:00.000Z' });
  assert.deepEqual(await fixture.store.read(), state);
  assert.deepEqual(await readdir(path.dirname(archived)), [key]);
  assert.equal(await readFile(path.join(archived, 'marker.txt'), 'utf8'), 'old');
});
