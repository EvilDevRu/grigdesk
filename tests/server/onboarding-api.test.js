import assert from 'node:assert/strict';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  atProject, atWorkspace, cookie, document, onboardingFixture, projectInput,
  repository, request, token,
} from './helpers/onboardingFixture.js';

for (const scenario of ['empty', 'passport', 'graph', 'archived', 'dismissed']) {
  test(`ONB-START-01: автоматический допуск ${scenario}`, async (t) => {
    const f = await onboardingFixture(t);

    if (scenario === 'passport' || scenario === 'archived') {
      await f.app.projects.create(projectInput('demo'));

      if (scenario === 'archived') {
        await f.app.projects.archive('demo', 1);
      }
    }
    if (scenario === 'graph') {
      const dir = path.join(f.config.profilesDir, 'factory');

      await mkdir(dir);
      await writeFile(path.join(dir, 'graph.json'), '{"capabilities":[]}');
      await writeFile(path.join(dir, 'profile.sh'), 'exit 91\n');
    }
    if (scenario === 'dismissed') {
      let active = await request(f.app, 'POST', '/start', { expectedRevision: 0, mode: 'auto' });

      active = await request(f.app, 'POST', '/dismiss', token(active));
      assert.equal(active.autoOpenDisabled, true);
    }

    const state = await request(f.app);

    assert.equal(state.shouldOpen, scenario === 'empty');

    const started = await request(f.app, 'POST', '/start', {
      expectedRevision: state.revision,
      mode: 'auto',
    });

    assert.equal(started.open, scenario === 'empty');

    if (scenario !== 'empty') {
      assert.equal(started.revision, state.revision);
      assert.deepEqual(started.active, state.active);
    }
  });
}

test('ONB-RESUME-01: первый auto продолжается после собственного паспорта', async (t) => {
  const f = await onboardingFixture(t);
  const state = await atWorkspace(f);
  const otherApp = await f.open();
  const restored = await request(otherApp);

  assert.equal(restored.shouldOpen, true);
  assert.equal(restored.active.step, 'workspace');
  assert.equal(restored.active.projectSaved, true);
  assert.equal(restored.active.origin, 'auto');

  for (const mode of ['auto', 'manual']) {
    const resumed = await request(otherApp, 'POST', '/start', {
      expectedRevision: restored.revision,
      mode,
    });

    assert.equal(resumed.open, true);
    assert.equal(resumed.active.id, state.active.id);
    assert.equal(resumed.active.origin, 'auto');
    assert.deepEqual(resumed.active.draft, state.active.draft);
  }

  assert.equal((await f.app.projects.list()).length, 1);
});

test('ONB-START-MANUAL: ручной проход с проектом продолжается только кнопкой', async (t) => {
  const f = await onboardingFixture(t);

  await f.app.projects.create(projectInput('demo'));

  let state = await atProject(f, 'manual');
  const draft = { ...state.active.draft, title: 'Несохранённый второй проект' };

  state = await request(f.app, 'PATCH', '', { ...token(state), draft });

  /**
   * На каждом шаге новый сервис имитирует перезагрузку или другое устройство.
   * Автопроверка обязана быть read-only, ручное продолжение сохраняет origin.
   */
  async function verifyManual(expected) {
    const app = await f.open();
    const current = await request(app);

    assert.equal(current.shouldOpen, false);

    const automatic = await request(app, 'POST', '/start', {
      expectedRevision: current.revision,
      mode: 'auto',
    });

    assert.equal(automatic.open, false);
    assert.equal(automatic.revision, current.revision);
    assert.deepEqual(automatic.active, current.active);

    const manual = await request(app, 'POST', '/start', {
      expectedRevision: current.revision,
      mode: 'manual',
    });

    assert.equal(manual.active.origin, 'manual');
    assert.equal(manual.active.id, expected.active.id);
    assert.equal(manual.active.step, expected.active.step);
    assert.deepEqual(manual.active.draft, expected.active.draft);

    return manual;
  }

  state = await verifyManual(state);

  const dir = await repository(f.root);

  state = await request(f.app, 'PATCH', '', {
    ...token(state),
    draft: {
      ...draft,
      repositories: [{
        name: 'repo1',
        source: dir,
        baseBranch: 'main',
      }],
    },
  });
  state = await request(f.app, 'POST', '/advance', token(state));
  assert.equal(state.active.step, 'workspace');
  await verifyManual(state);
  assert.equal((await f.app.projects.list()).length, 2);
});

test('ONB-PROJECT-01: две папки создают паспорт, доступный прежним GET и PUT', async (t) => {
  const f = await onboardingFixture(t);
  const state = await atWorkspace(f);
  const id = state.active.projectId;
  const response = await f.app.inject(`/api/projects/${id}`);
  const project = response.json();

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(project.title, state.active.draft.title);
  assert.deepEqual(project.repos.map(({ key, dir }) => ({ key, dir })),
    state.active.draft.repositories.map(({ name, source }) => ({ key: name, dir: source })));
  assert.equal(project.defaultRepoKey, state.active.draft.repositories[0].name);

  const updated = await f.app.inject({
    method: 'PUT',
    url: `/api/projects/${id}`,
    payload: {
      description: project.description,
      tags: project.tags,
      repos: project.repos.map(({ key, dir }) => ({ key, dir })),
      defaultRepoKey: project.defaultRepoKey,
      title: 'Правка обычной формой',
      expectedRevision: project.revision,
    },
  });

  assert.equal(updated.statusCode, 200, updated.body);

  const finished = await request(f.app, 'POST', '/advance', token(state));

  assert.equal(finished.active.status, 'completed');
  assert.equal((await f.app.projects.read(id)).title, 'Правка обычной формой');
  assert.equal(f.events.filter((entry) => entry.event === 'projects-changed'
    && entry.data.kind === 'created').length, 1);
});

test('ONB-PROJECT-RETRY: сбой после create и потерянный ответ не дублируют паспорт', async (t) => {
  const f = await onboardingFixture(t);
  let state = await atProject(f);
  const dir = await repository(f.root);
  const statePath = path.join(f.config.dataStateDir, 'onboarding.json');
  const backup = `${statePath}.pending`;
  const originalCreate = f.app.projects.create;
  let interrupted = false;

  state = await request(f.app, 'PATCH', '', {
    ...token(state),
    draft: {
      title: 'Повтор',
      repositories: [{
        name: 'repo1',
        source: dir,
        baseBranch: 'main',
      }],
      workspace: { mode: 'isolated' },
    },
  });
  t.mock.method(f.app.projects, 'create', async (input) => {
    const project = await originalCreate(input);

    if (!interrupted) {
      interrupted = true;
      await rename(statePath, backup);
      await mkdir(statePath);
    }

    return project;
  });
  await request(f.app, 'POST', '/advance', token(state), 500);
  assert.equal((await f.app.projects.list()).length, 1);

  const { rm } = await import('node:fs/promises');

  await rm(statePath, { recursive: true });
  await rename(backup, statePath);

  const app = await f.open();

  state = await request(app);
  assert.ok(state.active.projectIntent);
  state = await request(app, 'POST', '/advance', token(state));
  assert.equal(state.active.step, 'workspace');

  const resumed = await request(app, 'POST', '/start', {
    expectedRevision: state.revision,
    mode: 'manual',
  });

  assert.equal(resumed.active.id, state.active.id);
  assert.equal((await app.projects.list()).length, 1);
  assert.equal((await document(f)).active.projectSaved, true);
});

for (const step of ['ai', 'project', 'workspace', 'summary']) {
  test(`ONB-DISMISS-01: устойчивый отказ с шага ${step} сохраняет созданное`, async (t) => {
    const f = await onboardingFixture(t);
    let state;

    if (step === 'ai') {
      state = await request(f.app, 'POST', '/start', { expectedRevision: 0, mode: 'auto' });
    } else if (step === 'project') {
      state = await atProject(f);
    } else {
      state = await atWorkspace(f);

      if (step === 'summary') {
        state = await request(f.app, 'POST', '/advance', token(state));
      }
    }

    const projectCount = (await f.app.projects.list()).length;
    const id = state.active.projectId;

    state = await request(f.app, 'POST', '/dismiss', token(state));

    const restored = await request(await f.open());

    assert.equal(restored.shouldOpen, false);
    assert.equal(restored.autoOpenDisabled, true);
    assert.equal(restored.active.status, 'dismissed');
    assert.equal((await f.app.projects.list()).length, projectCount);

    if (projectCount > 0) {
      assert.ok((await document(f)).answersByProject[id]);
      assert.equal((await f.app.projects.read(id)).id, id);
    }
  });
}

test('ONB-AUTH-01: все ручки закрыты до чтения состояния и Git', async (t) => {
  const f = await onboardingFixture(t, { auth: true });
  const state = await request(f.app);
  const before = await readFile(path.join(f.root, 'prefs.json'), 'utf8').catch(() => null);

  for (const [method, suffix, payload] of [
    ['GET', '', undefined],
    ['POST', '/start', { expectedRevision: state.revision, mode: 'manual' }],
    ['PATCH', '', {}],
    ['POST', '/advance', {}],
    ['POST', '/back', {}],
    ['POST', '/dismiss', {}],
    ['POST', '/repository', { dir: '/не-должен-читаться' }],
  ]) {
    const response = await f.app.inject({
      method,
      url: `/api/onboarding${suffix}`,
      payload,
    });

    assert.equal(response.statusCode, 401, response.body);
  }

  assert.equal(f.events.length, 0);
  assert.equal(await readFile(path.join(f.root, 'prefs.json'), 'utf8').catch(() => null), before);
  assert.equal((await request(f.app)).revision, state.revision);
  assert.ok(cookie.includes('onboarding-fixture'));
});
