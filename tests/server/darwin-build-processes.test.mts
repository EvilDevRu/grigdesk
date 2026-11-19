import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyDarwinBuildProcesses } from '../../cli/darwinBuildProcesses.ts';
import type { DarwinProcessCensusEntry } from '../../shared/node/processIdentity.ts';
import { classifyDarwinSession, inspectDarwinSession } from '../../server/src/lib/factoryDarwinSessions.ts';
import { decodeCompleteFactoryOwnership } from '../../shared/runtime/factoryOwnership.ts';
import { FactoryLaunchAdmission } from '../../server/src/lib/factoryLaunchAdmission.ts';

const witness = {
  pid: 20,
  ppid: 1,
  sid: 20,
  pgid: 20,
  starttime: '1000000',
};
const stage = {
  pid: 30,
  ppid: 20,
  sid: 30,
  pgid: 30,
  starttime: '2000000',
};
const owned = {
  pid: 40,
  ppid: 30,
  sid: 40,
  pgid: 40,
  starttime: '3000000',
};

test('DARWIN-BUILD-CENSUS: свой setsid и новое поколение PID различаются', () => {
  const independent = {
    ...owned,
    pid: 21,
    ppid: 20,
    sid: 21,
    pgid: 21,
  };
  const unknown = {
    pid: 41,
    ppid: 1,
    sid: 41,
    pgid: 41,
    starttime: '4000000',
  };
  const baseline = new Map([[witness.pid, witness]]);
  const observed = new Map([[stage.pid, stage]]);
  const snapshot = [owned, stage, witness, independent, unknown];

  assert.deepEqual(classifyDarwinBuildProcesses(snapshot, baseline, observed, stage), {
    owned: [owned, stage],
    unknown: [unknown],
  });

  const reused = {
    ...owned,
    ppid: 1,
    starttime: '5000000',
  };

  observed.set(owned.pid, owned);
  assert.deepEqual(classifyDarwinBuildProcesses([reused, witness], baseline, observed, stage), {
    owned: [],
    unknown: [reused],
  });
});

test('DARWIN-BUILD-CENSUS: неатрибутированный orphan не становится своим или независимым', () => {
  const departed = { ...owned, ppid: 1 };
  const reusedSession = {
    ...stage,
    ppid: 1,
    starttime: '6000000',
  };
  const unrelated = {
    pid: 41,
    ppid: 1,
    sid: 30,
    pgid: 41,
    starttime: '7000000',
  };
  const snapshot = [departed, reusedSession, unrelated];
  const baseline = new Map<number, DarwinProcessCensusEntry>();
  const observed = new Map([[stage.pid, stage], [owned.pid, owned]]);

  assert.deepEqual(classifyDarwinBuildProcesses(snapshot, baseline, observed, stage), {
    owned: [departed],
    unknown: [reusedSession, unrelated],
  });
});

test('DARWIN-SESSION: после смерти лидера требуется прежний участник', async () => {
  const participant = { ...owned, sid: stage.sid };
  const orphan = { ...participant, ppid: 1 };

  assert.equal(classifyDarwinSession(stage, [stage, participant]).state, 'alive');
  assert.equal(classifyDarwinSession(stage, [orphan]).state, 'unknown');
  assert.equal(classifyDarwinSession(stage, [orphan], [participant]).state, 'alive');
  assert.equal(
    classifyDarwinSession(stage, [{ ...stage, starttime: '4000000' }, orphan], [participant]).state,
    'unknown',
  );

  const snapshots = [[], [orphan]];
  const changing = await inspectDarwinSession(stage, async () => snapshots.shift() ?? []);

  assert.equal(changing.state, 'unknown');
  assert.equal((await inspectDarwinSession(stage, async () => [witness])).state, 'dead');
});

test('DARWIN-OWNERSHIP: decode разрешает полный снимок и отклоняет неоднозначные строки', () => {
  const row = {
    task: '123',
    orchestrator: 'dead',
    runner: 'dead',
    finalization: 'pending',
  };
  const snapshot = {
    daemonOwnershipVersion: 1,
    complete: true,
    ownership: [row],
  };

  assert.deepEqual(decodeCompleteFactoryOwnership(snapshot), [row]);
  assert.deepEqual(decodeCompleteFactoryOwnership({ ...snapshot, ownership: [] }), []);
  assert.throws(() => decodeCompleteFactoryOwnership({ ...snapshot, complete: false }),
    /release_activity_unknown/);
  assert.throws(() => decodeCompleteFactoryOwnership({ ...snapshot, ownership: [row, row] }),
    /release_activity_unknown/);
  assert.throws(() => decodeCompleteFactoryOwnership({
    ...snapshot,
    ownership: [{ ...row, runner: 'unknown' }],
  }), /release_activity_unknown/);
  assert.throws(() => decodeCompleteFactoryOwnership({ tasks: [] }), /release_activity_unknown/);
});

test('DARWIN-ADMISSION: 202 освобождает только вход, фоновый writer удерживает допуск', async () => {
  const admission = new FactoryLaunchAdmission();
  const empty = {
    daemonOwnershipVersion: 1,
    complete: true,
    ownership: [],
  };

  const writer = await admission.run('123', async () => admission.retain('123'));

  assert.deepEqual(admission.snapshot().tasks, ['123']);
  assert.throws(() => admission.acquire('owner', () => false), /release_activity_unknown/u);
  await writer.run(() => admission.run('123', async () => {}));
  writer.release();
  assert.deepEqual(admission.snapshot().tasks, []);

  const token = admission.acquire('owner', () => false);

  await assert.rejects(admission.run('123', async () => {}), /release_drain_busy/u);
  admission.release(token, 'other');
  await assert.rejects(admission.run('123', async () => {}), /release_drain_busy/u);
  await admission.confirm(token, 'owner', async () => empty);
  admission.dispatch(token, 'owner');
  admission.release(token, 'owner');
  await assert.rejects(admission.run('123', async () => {}), /release_drain_busy/u);
});
