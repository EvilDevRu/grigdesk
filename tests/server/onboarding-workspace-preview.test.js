import assert from 'node:assert/strict';
import test from 'node:test';

import {
  atProject, document, onboardingFixture, repository, request, token,
} from './helpers/onboardingFixture.js';

test('ONB-WORKSPACE-PREVIEW: выбор режима до проекта не разрешает пустое завершение', async (t) => {
  const f = await onboardingFixture(t);
  let state = await atProject(f, 'manual');

  state = await request(f.app, 'POST', '/advance', { ...token(state), previewWorkspace: true });
  assert.equal(state.active.step, 'workspace');
  assert.equal(state.active.projectSaved, false);
  assert.equal(state.active.projectIntent, null);
  assert.equal((await f.app.projects.list()).length, 0);
  state = await request(f.app, 'PATCH', '', {
    ...token(state),
    draft: { ...state.active.draft, workspace: { mode: 'shared' } },
  });
  assert.deepEqual((await request(await f.open())).active, state.active);
  await request(f.app, 'POST', '/advance', token(state), 400);
  assert.equal((await request(f.app)).active.status, 'active');
  state = await request(f.app, 'POST', '/back', token(state));

  const dir = await repository(f.root);

  state = await request(f.app, 'PATCH', '', {
    ...token(state),
    draft: {
      ...state.active.draft,
      title: 'Проект после выбора режима',
      repositories: [{
        name: 'repo1',
        source: dir,
        baseBranch: 'main',
      }],
    },
  });
  state = await request(f.app, 'POST', '/advance', token(state));
  assert.equal(state.active.projectSaved, true);
  state = await request(f.app, 'POST', '/advance', token(state));
  assert.equal(state.active.status, 'completed');
  assert.equal(state.answersByProject[state.active.projectId].workspace.mode, 'shared');
  assert.equal((await f.app.projects.list()).length, 1);
});

test('ONB-WORKSPACE-PREVIEW: флаг ограничен переходом с проекта и проверяется до записи', async (t) => {
  const f = await onboardingFixture(t);
  let state = await request(f.app, 'POST', '/start', { expectedRevision: 0, mode: 'manual' });

  await request(f.app, 'POST', '/advance', { ...token(state), previewWorkspace: true }, 400);
  state = await request(f.app, 'POST', '/advance', { ...token(state), skipAi: true });

  const before = await document(f);

  for (const [suffix, extra, status] of [
    ['/advance', { previewWorkspace: 'true' }, 400],
    ['/advance', { previewWorkspace: true, expectedRevision: state.revision - 1 }, 409],
    ['/advance', { previewWorkspace: true, sessionId: 'other' }, 409],
    ['/back', { previewWorkspace: true }, 400],
    ['/dismiss', { previewWorkspace: true }, 400],
  ]) {
    await request(f.app, 'POST', suffix, { ...token(state), ...extra }, status);
    assert.deepEqual(await document(f), before);
  }
});
