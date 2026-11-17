// Принятая запись обновляет сохранённую policy/data вместе с clip/log.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { recordedFixture, settleBuild } from './helpers/showcaseRecorded.js';

for (const changed of ['policyRevision', 'dataRevision']) {
  test(`публикация сохраняет входы новой записи: ${changed}`, async (t) => {
    const fx = await recordedFixture(t);
    const old = fx.project.target.scope[changed];

    if (changed === 'policyRevision') {
      const file = path.join(fx.profileDir, 'screens.json');
      const screens = JSON.parse(await readFile(file, 'utf8'));

      screens.screens[0].title = 'Новый обзор';
      await writeFile(file, JSON.stringify(screens));
    } else {
      await fx.service.markDataUpdated(fx.project.ref);
    }

    const live = await fx.prove();

    assert.notEqual(live.target.scope[changed], old);
    assert.equal((await fx.service.store.readProject(live.id)).target.scope[changed], old);

    const published = await fx.publish();
    const stored = await fx.service.store.readProject(live.id);

    assert.equal(stored.target.scope[changed], live.target.scope[changed]);
    assert.equal(published.recordingReady, true);

    const run = await fx.service.startBuild(published.id, published.revision, `${changed}-ready`);

    assert.equal((await settleBuild(fx.service, run.id)).state, 'succeeded');
    fx.removeStand();

    const offline = await fx.service.readProject(live.id);

    assert.equal(offline.recordingReady, true);

    const repeat = await fx.service.startBuild(offline.id, offline.revision, `${changed}-removed`);
    const done = await settleBuild(fx.service, repeat.id);

    assert.equal(done.state, 'succeeded');
    assert.equal(done.children.some((child) => child.stage === 'record-if-needed'), false);
  });
}

test('прежний job hash не сдвигает снимок и клип', async (t) => {
  const fx = await recordedFixture(t);
  const before = await fx.service.store.readProject(fx.project.id);

  await fx.service.markDataUpdated(before.ref);
  await fx.prove();
  await fx.publish({ inputHashes: { [before.scenes[0].id]: '0'.repeat(32) } });

  const after = await fx.service.store.readProject(before.id);

  assert.deepEqual(after.target, before.target);
  assert.deepEqual(after.scenes[0].clip, before.scenes[0].clip);
});

for (const changed of ['ref', 'generation']) {
  test(`публикация не перепривязывает изменившийся ${changed}`, async (t) => {
    const fx = await recordedFixture(t);
    let protectedProject;

    await fx.publish({
      beforeCommit: async () => {
        protectedProject = await fx.service.store.updateProject(fx.project.id, null, (project) => ({
          ...project,
          ...(changed === 'ref' ? { ref: { kind: 'project', id: 'another' } }
            : {
              target: {
                ...project.target, scope: {
                  ...project.target.scope, targetFingerprint: 'new-generation',
                }
              }
            }),
        }));
      }
    });

    const after = await fx.service.store.readProject(fx.project.id);

    assert.deepEqual(after.target, protectedProject.target);
    assert.deepEqual(after.scenes[0].clip, protectedProject.scenes[0].clip);
  });
}

test('частичная публикация не обещает готовность всех клипов', async (t) => {
  const fx = await recordedFixture(t, { count: 2, clips: false });
  const first = fx.project.scenes[0].id;
  const second = fx.project.scenes[1].id;

  assert.equal((await fx.publish({ ids: [first] })).recordingReady, false);
  assert.equal((await fx.publish({ ids: [second] })).recordingReady, true);
});
