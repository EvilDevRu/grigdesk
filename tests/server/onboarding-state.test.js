import assert from 'node:assert/strict';
import fs, { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  atProject, atWorkspace, document, onboardingFixture, request, token,
} from './helpers/onboardingFixture.js';

for (const origin of ['auto', 'manual']) {
  test(`ONB-STATE-01: новый сервис читает шаг, ответы и origin=${origin}`, async (t) => {
    const f = await onboardingFixture(t);
    let state = await atWorkspace(f, origin);
    const draft = { ...state.active.draft, workspace: { mode: 'shared' } };

    state = await request(f.app, 'PATCH', '', { ...token(state), draft });

    const restored = await request(await f.open());
    const saved = await document(f);

    assert.deepEqual(restored.active, state.active);
    assert.equal(restored.active.origin, origin);
    assert.equal(restored.active.step, 'workspace');
    assert.equal(restored.active.draft.workspace.mode, 'shared');
    assert.deepEqual(saved.active.draft.repositories, draft.repositories);
    assert.equal(saved.revision, state.revision);
    assert.equal(saved.schemaVersion, 1);
  });
}

test('ONB-STATE-02: stale revision и неверные поля не теряют подтверждённые ответы', async (t) => {
  const f = await onboardingFixture(t);
  const state = await atProject(f);
  const before = await document(f);

  await request(f.app, 'PATCH', '', {
    ...token(state),
    expectedRevision: state.revision - 1,
    draft: state.active.draft,
  }, 409);

  for (const patch of [
    { draft: { ...state.active.draft, workspace: { mode: 'unknown' } } },
    { origin: 'manual', draft: state.active.draft },
  ]) {
    await request(f.app, 'PATCH', '', { ...token(state), ...patch }, 400);
    assert.deepEqual(await document(f), before);
  }
});

test('ONB-STATE-02: порча, версия и неверный origin не сбрасывают файл', async (t) => {
  const f = await onboardingFixture(t);
  const state = await atProject(f);
  const statePath = path.join(f.config.dataStateDir, 'onboarding.json');
  const original = await document(f);
  const missingOrigin = structuredClone(original);

  delete missingOrigin.active.origin;

  for (const broken of [
    '{',
    JSON.stringify({ ...original, schemaVersion: 99 }),
    JSON.stringify(missingOrigin),
    JSON.stringify({ ...original, active: { ...state.active, origin: 'unknown' } }),
  ]) {
    await writeFile(statePath, broken);
    await request(await f.open(), 'GET', '', undefined, 500);
    assert.equal(await readFile(statePath, 'utf8'), broken);
  }
});

test('ONB-STATE-02: отказ записи не даёт ACK и событие', async (t) => {
  const f = await onboardingFixture(t);
  const state = await atProject(f);
  const statePath = path.join(f.config.dataStateDir, 'onboarding.json');
  const before = await document(f);
  const eventsBefore = f.events.length;

  const originalRename = fs.rename;
  let injected = false;

  t.mock.method(fs, 'rename', async (source, target) => {
    if (String(target) === statePath) {
      injected = true;

      throw Object.assign(new Error('Отказ атомарной записи фикстуры'), { code: 'EACCES' });
    }

    return originalRename(source, target);
  });
  await request(f.app, 'PATCH', '', {
    ...token(state),
    draft: { ...state.active.draft, title: 'Не должно подтвердиться' },
  }, 500);
  assert.equal(injected, true, 'Проверен отказ публикации, а не чтения');
  assert.deepEqual(await document(f), before);
  assert.equal(f.events.length, eventsBefore);
});

test('ONB-STATE-03: второй проход сохраняет ответы первого проекта', async (t) => {
  const f = await onboardingFixture(t);
  let state = await atWorkspace(f);
  const id = state.active.projectId;

  state = await request(f.app, 'POST', '/advance', token(state));

  const firstAnswers = (await document(f)).answersByProject[id];

  assert.equal(firstAnswers.complete, true);
  state = await request(f.app, 'POST', '/start', {
    expectedRevision: state.revision,
    mode: 'manual',
  });
  assert.notEqual(state.active.projectId, id);
  assert.equal(state.active.origin, 'manual');
  assert.deepEqual((await document(f)).answersByProject[id], firstAnswers);
});
