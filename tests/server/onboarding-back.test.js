import assert from 'node:assert/strict';
import test from 'node:test';

import {
  atProject, atWorkspace, document, onboardingFixture, request, token,
} from './helpers/onboardingFixture.js';

test('ONB-BACK-01: возврат до создания сохраняет неполный черновик и шаг после перечитывания', async (t) => {
  const f = await onboardingFixture(t);
  let state = await atProject(f, 'manual');
  const draft = { ...state.active.draft, title: 'Мой черновик' };

  state = await request(f.app, 'PATCH', '', { ...token(state), draft });

  const sessionId = state.active.id;

  state = await request(f.app, 'POST', '/back', token(state));
  assert.equal(state.active.step, 'ai');
  assert.deepEqual(state.active.draft, draft);
  assert.deepEqual((await request(await f.open())).active, state.active);

  state = await request(f.app, 'POST', '/advance', token(state));
  assert.equal(state.active.step, 'project');
  assert.equal(state.active.id, sessionId);
  assert.equal(state.active.aiSkipped, false);
  assert.deepEqual(state.active.draft, draft);
  assert.equal((await f.app.projects.list()).length, 0);
});

test('ONB-BACK-02: возврат с итога и повторное прохождение сохраняют один паспорт', async (t) => {
  const f = await onboardingFixture(t);
  let state = await atWorkspace(f, 'manual');
  const initial = structuredClone(state.active);

  state = await request(f.app, 'POST', '/advance', token(state));
  assert.equal(state.answersByProject[initial.projectId].complete, true);

  for (const step of ['workspace', 'project', 'ai']) {
    state = await request(f.app, 'POST', '/back', token(state));
    assert.equal(state.active.step, step);
    assert.equal(state.active.status, 'active');
    assert.equal(state.active.projectId, initial.projectId);
    assert.deepEqual(state.active.draft, initial.draft);
    assert.equal(state.answersByProject[initial.projectId].complete, false);
  }

  assert.deepEqual((await request(await f.open())).active, state.active);

  // Правка обычной формой после создания не должна мешать просмотру прежнего шага.
  // Мастер не записывает паспорт заново и не восстанавливает старое название.
  await f.app.projects.update(initial.projectId, {
    title: 'Новое название в Проектах',
    description: '',
    tags: [],
    repos: initial.projectIntent.repos,
    defaultRepoKey: initial.projectIntent.defaultRepoKey,
  }, initial.projectRevision);

  state = await request(f.app, 'POST', '/advance', token(state));
  assert.equal(state.answersByProject[initial.projectId].aiSkipped, false);
  state = await request(f.app, 'POST', '/advance', token(state));
  state = await request(f.app, 'PATCH', '', {
    ...token(state),
    draft: { ...state.active.draft, workspace: { mode: 'shared' } },
  });
  state = await request(f.app, 'POST', '/advance', token(state));

  assert.equal(state.active.step, 'summary');
  assert.equal(state.active.status, 'completed');
  assert.equal(state.active.id, initial.id);
  assert.equal(state.answersByProject[initial.projectId].complete, true);
  assert.equal(state.answersByProject[initial.projectId].workspace.mode, 'shared');
  assert.equal((await f.app.projects.list()).length, 1);
  assert.equal((await f.app.projects.read(initial.projectId)).title, 'Новое название в Проектах');
  assert.equal(f.events.filter((entry) => entry.event === 'projects-changed'
    && entry.data.kind === 'created').length, 1);
});

test('ONB-BACK-03: первый шаг, чужой проход, лишние поля и stale revision не меняют состояние', async (t) => {
  const f = await onboardingFixture(t);
  let state = await request(f.app, 'POST', '/start', { expectedRevision: 0, mode: 'manual' });

  await request(f.app, 'POST', '/back', token(state), 400);
  state = await request(f.app, 'POST', '/advance', { ...token(state), skipAi: true });

  const before = await document(f);
  const events = f.events.length;

  for (const [extra, status] of [
    [{ expectedRevision: state.revision - 1 }, 409],
    [{ sessionId: 'other-session' }, 409],
    [{ skipAi: true }, 400],
    [{ step: 'ai' }, 400],
  ]) {
    await request(f.app, 'POST', '/back', { ...token(state), ...extra }, status);
    assert.deepEqual(await document(f), before);
    assert.equal(f.events.length, events);
  }

  state = await request(f.app, 'POST', '/dismiss', token(state));
  await request(f.app, 'POST', '/back', token(state), 400);
  assert.equal((await request(f.app)).active.status, 'dismissed');
});
