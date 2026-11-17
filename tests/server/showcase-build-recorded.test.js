// Полный служебный путь монтажа: свежие клипы не зависят от живого стенда.
import assert from 'node:assert/strict';
import test from 'node:test';

import { recordedFixture, settleBuild } from './helpers/showcaseRecorded.js';
import { buildRunSnapshotOf } from '../../server/src/lib/showcase/buildOps.ts';

for (const stand of ['ready', 'removed']) {
  for (const change of ['none', 'narration', 'adaptation']) {
    test(`сборка ${stand} после ${change} использует принятую запись`, async (t) => {
      const fx = await recordedFixture(t);
      const before = fx.project.scenes[0].clip;
      const proof = fx.project.scriptProofHash;

      if (stand === 'removed') {
        fx.removeStand();
      }

      if (change === 'narration') {
        const current = await fx.service.readProject(fx.project.id);

        await fx.service.updateScene(current.id, current.revision, current.scenes[0].id, {
          narration: 'Обновлённое описание обзора.',
        });
      } else if (change === 'adaptation') {
        await fx.service.adaptNarration(fx.project.id);
      }

      const current = await fx.service.readProject(fx.project.id);

      assert.equal(current.recordingReady, true);

      const run = await fx.service.startBuild(current.id, current.revision, `${stand}-${change}`);
      const done = await settleBuild(fx.service, run.id);

      assert.equal(done.state, 'succeeded', JSON.stringify(done.error));
      assert.equal(done.children.some((child) => child.stage === 'record-if-needed'), false);
      assert.equal(done.children.some((child) => child.stage === 'script-if-empty'), false);
      assert.equal(done.children.some((child) => child.stage === 'voice-and-alignment'), change !== 'none');

      const saved = await fx.service.readProject(current.id);

      assert.deepEqual(saved.scenes[0].clip, before);
      assert.equal(saved.scriptProofHash, proof);
      assert.equal(saved.latestFinal.current, true);
    });
  }
}

for (const change of ['source', 'missing-log', 'actions', 'data']) {
  test(`непроверенный вход ${change} не проходит сборку без стенда`, async (t) => {
    const fx = await recordedFixture(t);
    const current = await fx.service.readProject(fx.project.id);

    if (change === 'source') {
      await fx.service.saveSource(current.id, current.revision, { taskId: null, note: 'Другой рассказ' });
    } else if (change === 'data') {
      await fx.service.markDataUpdated(current.ref);
      assert.equal((await fx.service.readProject(current.id)).recordingReady, false);

      return;
    } else {
      await fx.service.store.updateProject(current.id, null, (project) => ({
        ...project, scenes: project.scenes.map((scene) => ({
          ...scene,
          ...(change === 'missing-log' ? { recordingTiming: null } : { actions: [{ kind: 'wait', ms: 50 }] }),
        })),
      }));
    }

    fx.removeStand();

    const saved = await fx.service.readProject(current.id);
    const run = await fx.service.startBuild(saved.id, saved.revision, `negative-${change}`);
    const done = await settleBuild(fx.service, run.id);

    assert.equal(done.state, 'failed');
    assert.equal(done.error.code, 'target_unavailable');
  });
}

test('validate готового стенда отклоняет устаревший финал', async (t) => {
  const fx = await recordedFixture(t);
  const initial = await fx.service.readProject(fx.project.id);
  const first = await fx.service.startBuild(initial.id, initial.revision, 'build-for-stale-final');

  assert.equal((await settleBuild(fx.service, first.id)).state, 'succeeded');

  const built = await fx.service.readProject(initial.id);
  const current = await fx.service.updateScene(built.id, built.revision, built.scenes[0].id, {
    narration: 'Новое описание без нового финала.',
  });

  assert.ok(current.latestFinal);
  assert.equal(current.latestFinal.current, false);

  const snapshot = buildRunSnapshotOf(current);

  assert.equal(current.target.status, 'ready');

  const { record } = await fx.service.buildRuns.create({
    projectId: current.id,
    initialRevision: current.revision,
    requestId: 'validate-stale-final',
    requestInputHash: snapshot.inputHash,
    snapshot,
    previousFinal: null,
  });

  await fx.service.buildRuns.move(record.id, 'validate', snapshot);

  const done = await settleBuild(fx.service, record.id);

  assert.equal(done.state, 'failed');
  assert.equal(done.error.code, 'final_not_current');
});

test('сохранённый запуск возобновляет холодную озвучку без UI-каталога и стенда', async (t) => {
  const fx = await recordedFixture(t);
  const original = await fx.service.readProject(fx.project.id);

  await fx.service.updateScene(original.id, original.revision, original.scenes[0].id, {
    narration: 'Новое описание перед восстановлением.',
  });
  fx.removeStand();

  const changed = await fx.service.readProject(original.id);
  const snapshot = buildRunSnapshotOf(changed);
  const { record } = await fx.service.buildRuns.create({
    projectId: changed.id,
    initialRevision: changed.revision,
    requestId: 'resume-cold-voice',
    requestInputHash: snapshot.inputHash,
    snapshot,
    previousFinal: changed.latestFinal,
  });

  await fx.service.buildRuns.move(record.id, 'voice-and-alignment', snapshot);
  await fx.restart({ resume: true });

  const done = await settleBuild(fx.service, record.id);

  assert.equal(done.state, 'succeeded', JSON.stringify(done.error));
  assert.equal(done.children.some((child) => child.stage === 'voice-and-alignment'), true);
  assert.equal(done.children.some((child) => child.stage === 'record-if-needed'), false);
});
