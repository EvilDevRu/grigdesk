import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

import { PrefsStore } from '../../server/src/lib/prefs-store.js';
import projectsModule from '../../server/src/modules/projects/index.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const exec = promisify(execFile);

async function fixture(t, { reviews = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-project-api.'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  const routesDir = path.join(root, 'routes');
  const repoDir = path.join(root, 'repo');
  await Promise.all([
    mkdir(profilesDir, { recursive: true }),
    mkdir(path.join(routesDir, 'demo'), { recursive: true }),
    mkdir(repoDir, { recursive: true }),
  ]);
  await exec('git', ['init', '-q', repoDir]);
  await exec('git', ['-C', repoDir, 'remote', 'add', 'origin', 'git@github.com:Acme/demo.git']);

  const prefs = new PrefsStore({ prefsPath: path.join(root, 'prefs.json') });
  prefs.write({ projects: { demo: { repos: [{ key: 'app', dir: repoDir }] } } });
  const app = Fastify({ logger: false });
  await app.register(projectsModule, {
    config: { profilesDir, routesDir },
    prefs,
    reviews,
  });
  t.after(async () => app.close());
  return { app, prefs, repoDir };
}

test('Projects API показывает найденный remote, но не включает ревью без подтверждения', async (t) => {
  const { app } = await fixture(t);
  const response = await app.inject({ method: 'GET', url: '/api/projects' });

  assert.equal(response.statusCode, 200);
  const repo = response.json().projects[0].repos[0];
  assert.equal(repo.github.detectedSlug, 'Acme/demo');
  assert.equal(repo.github.confirmed, false);
  assert.equal(response.json().projects[0].reviewReady, false);
});

test('MAP-07: некорректная VERIFY-команда отклоняется при настройке Project', async (t) => {
  const { app, prefs } = await fixture(t);
  const response = await app.inject({
    method: 'PUT',
    url: '/api/projects/demo/repositories/app/github',
    payload: {
      slug: 'Acme/demo',
      confirmed: true,
      verifyCommands: ['npm \"test'],
      verifyCoversCriteria: true,
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, 'VERIFY_COMMAND_INVALID');
  assert.equal(prefs.read().projects.demo.review, undefined);
});

test('MAP-05: активный review-run блокирует rebind, delete и удаление repo path', async (t) => {
  const reviews = {
    projectStatus: async () => [],
    assertRepositoryMutable: async () => {
      const error = new Error('Сначала заверши активный запуск');
      error.code = 'REPOSITORY_RUN_ACTIVE';
      throw error;
    },
  };
  const { app } = await fixture(t, { reviews });

  const rebind = await app.inject({
    method: 'PUT',
    url: '/api/projects/demo/repositories/app/github',
    payload: { slug: 'Acme/demo', confirmed: true, verifyCommands: ['npm test'] },
  });
  assert.equal(rebind.statusCode, 409);
  assert.equal(rebind.json().error, 'REPOSITORY_RUN_ACTIVE');

  const removeBinding = await app.inject({
    method: 'DELETE',
    url: '/api/projects/demo/repositories/app/github',
  });
  assert.equal(removeBinding.statusCode, 409);

  const removePath = await app.inject({
    method: 'PUT',
    url: '/api/projects/demo',
    payload: { repos: [] },
  });
  assert.equal(removePath.statusCode, 409);
});

test('Projects API отклоняет подтверждение, расходящееся с локальным origin', async (t) => {
  const { app } = await fixture(t);
  const response = await app.inject({
    method: 'PUT',
    url: '/api/projects/demo/repositories/app/github',
    payload: { slug: 'Acme/other', confirmed: true },
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'remote_mismatch');
  assert.equal(response.json().detectedSlug, 'Acme/demo');
});

test('Projects API сохраняет подтверждённую привязку и параметры автоматики', async (t) => {
  const { app, prefs } = await fixture(t);
  const response = await app.inject({
    method: 'PUT',
    url: '/api/projects/demo/repositories/app/github',
    payload: {
      slug: 'Acme/demo',
      confirmed: true,
      autoSync: true,
      autoAnalyze: false,
      verifyCommands: ['npm test', ' npm test ', '', 'npm run build'],
      verifyCoversCriteria: true,
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().binding, {
    slug: 'Acme/demo',
    detectedSlug: 'Acme/demo',
    confirmed: true,
    autoSync: true,
    autoAnalyze: false,
    verifyCommands: ['npm test', 'npm run build'],
    verifyCoversCriteria: true,
  });
  assert.deepEqual(
    prefs.read().projects.demo.review.repositories.app,
    response.json().binding,
  );
});

test('редактирование путей проекта не стирает GitHub-привязку', async (t) => {
  const { app, prefs, repoDir } = await fixture(t);
  await app.inject({
    method: 'PUT',
    url: '/api/projects/demo/repositories/app/github',
    payload: { slug: 'Acme/demo', confirmed: true },
  });

  const save = await app.inject({
    method: 'PUT',
    url: '/api/projects/demo',
    payload: { repos: [{ key: 'app', dir: repoDir }] },
  });

  assert.equal(save.statusCode, 200);
  assert.equal(
    prefs.read().projects.demo.review.repositories.app.slug,
    'Acme/demo',
  );
});
