// HTTP-поверхность раздела «Проекты»: ответы проходят те же декодеры, что и в браузере.
//
// Ручки раздела — единственный вход в реестр паспортов, поэтому здесь проверяется не
// только форма ответа, но и то, что отказ сервиса доезжает до клиента тем же кодом,
// которым его ждёт форма: 400 с полями, 404, 409 с текущей ревизией.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

import projectsModule from '../../server/src/modules/projects/index.ts';
import routesModule from '../../server/src/modules/routes/index.ts';
import { PrefsStore } from '../../server/src/lib/prefsStore.ts';
import {
  parseProjectDependencies,
  parseProjectDetail,
  parseProjectSummaries,
  parseProjectsError,
} from '../../shared/runtime/projectsContracts.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

async function withPrefs(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-projects-api-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prefsPath = path.join(dir, 'prefs.json');
  const profilesDir = path.join(dir, 'profiles');
  const routesDir = path.join(dir, 'routes');

  await mkdir(profilesDir, { recursive: true });
  await mkdir(routesDir, { recursive: true });

  return { dir, prefsPath, profilesDir, routesDir, prefs: new PrefsStore({ prefsPath }) };
}

async function makeProfile({ profilesDir, id, repos }) {
  const profileDir = path.join(profilesDir, id);

  await mkdir(profileDir, { recursive: true });
  await writeFile(path.join(profileDir, 'graph.json'), JSON.stringify({ capabilities: [] }), 'utf8');
  if (repos !== undefined) {
    await writeFile(path.join(profileDir, 'profile.sh'), `PROFILE_TRIAGE_REPOS="${repos}"\n`, 'utf8');
  }

  return profileDir;
}

async function makeRepoDir(env, name) {
  const dir = path.join(env.dir, 'repos', name);

  await mkdir(dir, { recursive: true });

  return dir;
}

/** Приложение с обоими модулями: projects регистрируется раньше routes, как в app.ts. */
async function projectsApp(t) {
  const env = await withPrefs(t);
  const events = [];
  const app = Fastify({ logger: false });
  const config = {
    factoryHome: env.dir,
    profilesDir: env.profilesDir,
    routesDir: env.routesDir,
  };

  app.decorate('sse', { broadcast: (event, data) => events.push({ event, data }) });
  await app.register(projectsModule, { config, prefs: env.prefs });
  await app.register(routesModule, { config, prefs: env.prefs });
  t.after(() => app.close());

  return { app, env, events };
}

function inputFor(id, repos, overrides = {}) {
  return {
    id,
    title: `Проект ${id}`,
    description: '',
    tags: [],
    repos,
    defaultRepoKey: repos[0]?.key ?? null,
    ...overrides,
  };
}

function updateBody(repos, overrides = {}) {
  return {
    title: 'Новое название',
    description: '',
    tags: [],
    repos,
    defaultRepoKey: repos[0]?.key ?? null,
    ...overrides,
  };
}

test('GET /api/projects проходит parseProjectSummaries, профиль и проект GrigDesk на месте', async (t) => {
  const { app, env } = await projectsApp(t);
  const dir = await makeRepoDir(env, 'be');

  await makeProfile({ profilesDir: env.profilesDir, id: 'factory', repos: `be:${dir}` });
  await app.inject({ method: 'POST', url: '/api/projects', payload: inputFor('demo', [{ key: 'be', dir }]) });

  const response = await app.inject({ method: 'GET', url: '/api/projects' });

  assert.equal(response.statusCode, 200);

  const summaries = parseProjectSummaries(response.json());

  assert.deepEqual(summaries.map((summary) => summary.id).sort(), ['demo', 'factory']);
  assert.equal(summaries.find((summary) => summary.id === 'factory').profile.pathsSource, 'profile');
  assert.equal(summaries.find((summary) => summary.id === 'demo').profile.pathsSource, 'passport');
});

test('GET /api/projects/:id проходит parseProjectDetail, неизвестный — 404, чужой id — 400', async (t) => {
  const { app, env } = await projectsApp(t);
  const dir = await makeRepoDir(env, 'be');

  await app.inject({ method: 'POST', url: '/api/projects', payload: inputFor('demo', [{ key: 'be', dir }]) });

  const found = await app.inject({ method: 'GET', url: '/api/projects/demo' });

  assert.equal(found.statusCode, 200);
  assert.equal(parseProjectDetail(found.json()).title, 'Проект demo');

  const missing = await app.inject({ method: 'GET', url: '/api/projects/nope' });

  assert.equal(missing.statusCode, 404);
  assert.equal(parseProjectsError(missing.json()).error, 'not_found');

  const bad = await app.inject({ method: 'GET', url: '/api/projects/..%2Fescape' });

  assert.equal(bad.statusCode, 400);
  assert.equal(parseProjectsError(bad.json()).error, 'bad_id');
});

test('POST /api/projects: 201 и parseProjectDetail, повтор — 409, без repos — 400 с полями', async (t) => {
  const { app, env } = await projectsApp(t);
  const dir = await makeRepoDir(env, 'be');
  const payload = inputFor('demo', [{ key: 'be', dir }]);

  const created = await app.inject({ method: 'POST', url: '/api/projects', payload });

  assert.equal(created.statusCode, 201);

  const detail = parseProjectDetail(created.json());

  assert.equal(detail.revision, 1);
  assert.deepEqual(detail.repos, [{ key: 'be', dir, exists: true }]);

  const again = await app.inject({ method: 'POST', url: '/api/projects', payload });

  assert.equal(again.statusCode, 409);
  assert.equal(parseProjectsError(again.json()).error, 'exists');

  const withoutRepos = inputFor('other', []);

  delete withoutRepos.repos;
  const rejected = await app.inject({ method: 'POST', url: '/api/projects', payload: withoutRepos });
  const body = parseProjectsError(rejected.json());

  assert.equal(rejected.statusCode, 400);
  assert.equal(body.error, 'bad_request');
  assert.deepEqual(body.fieldErrors.map((fieldError) => fieldError.path), ['repos']);
});

test('PUT /api/projects/:id: без ревизии — 400, устаревшая — 409 с currentRevision, верная растит revision', async (t) => {
  const { app, env } = await projectsApp(t);
  const dir = await makeRepoDir(env, 'be');
  const repos = [{ key: 'be', dir }];

  await app.inject({ method: 'POST', url: '/api/projects', payload: inputFor('demo', repos) });

  const withoutRevision = await app.inject({
    method: 'PUT',
    url: '/api/projects/demo',
    payload: updateBody(repos),
  });
  const required = parseProjectsError(withoutRevision.json());

  assert.equal(withoutRevision.statusCode, 400);
  assert.equal(required.error, 'revision_required');
  assert.match(required.message, /Обновите вкладку/);

  const stale = await app.inject({
    method: 'PUT',
    url: '/api/projects/demo',
    payload: { ...updateBody(repos), expectedRevision: 7 },
  });

  assert.equal(stale.statusCode, 409);

  const conflict = parseProjectsError(stale.json());

  assert.equal(conflict.error, 'revision_conflict');
  assert.equal(conflict.currentRevision, 1);

  const saved = await app.inject({
    method: 'PUT',
    url: '/api/projects/demo',
    payload: { ...updateBody(repos), expectedRevision: 1 },
  });

  assert.equal(saved.statusCode, 200);
  assert.equal(parseProjectDetail(saved.json()).revision, 2);
  assert.equal(parseProjectDetail(saved.json()).title, 'Новое название');
});

test('POST /api/profiles создаёт проект через сервис, GET /api/profiles отдаёт строки', async (t) => {
  const { app, env } = await projectsApp(t);

  const created = await app.inject({
    method: 'POST',
    url: '/api/profiles',
    payload: { id: 'demo' },
  });

  assert.equal(created.statusCode, 200);
  assert.deepEqual(created.json(), { ok: true, profiles: ['demo'] });

  const record = env.prefs.readStored().projects.demo;

  assert.equal(record.revision, 1);
  assert.equal(record.title, 'demo');
  assert.deepEqual(record.repos, []);

  const listed = await app.inject({ method: 'GET', url: '/api/profiles' });

  assert.deepEqual(listed.json().profiles, ['demo']);
  assert.ok(listed.json().profiles.every((item) => typeof item === 'string'));

  const again = await app.inject({ method: 'POST', url: '/api/profiles', payload: { id: 'demo' } });

  assert.equal(again.statusCode, 409);
  assert.equal(parseProjectsError(again.json()).error, 'exists');
});

test('после POST и PUT broadcast получил projects-changed с kind created и updated', async (t) => {
  const { app, env, events } = await projectsApp(t);
  const dir = await makeRepoDir(env, 'be');
  const repos = [{ key: 'be', dir }];

  await app.inject({ method: 'POST', url: '/api/projects', payload: inputFor('demo', repos) });
  await app.inject({
    method: 'PUT',
    url: '/api/projects/demo',
    payload: { ...updateBody(repos), expectedRevision: 1 },
  });

  assert.deepEqual(events, [
    { event: 'projects-changed', data: { id: 'demo', revision: 1, kind: 'created' } },
    { event: 'projects-changed', data: { id: 'demo', revision: 2, kind: 'updated' } },
  ]);
});

test('GET /api/projects/:id/dependencies отдаёт сводку через parseProjectDependencies', async (t) => {
  const { app, env } = await projectsApp(t);
  const dir = await makeRepoDir(env, 'be');

  await app.inject({ method: 'POST', url: '/api/projects', payload: inputFor('demo', [{ key: 'be', dir }]) });

  const response = await app.inject({ method: 'GET', url: '/api/projects/demo/dependencies' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(parseProjectDependencies(response.json()), {
    items: [],
    archivable: true,
    deletable: false,
    reasons: [],
  });

  const missing = await app.inject({ method: 'GET', url: '/api/projects/nope/dependencies' });

  assert.equal(missing.statusCode, 200, 'сводка связей не спрашивает, есть ли проект');
  assert.deepEqual(parseProjectDependencies(missing.json()).items, []);
});

test('POST /archive и /restore: 200 с паспортом, событие и повторный отказ', async (t) => {
  const { app, env, events } = await projectsApp(t);
  const dir = await makeRepoDir(env, 'be');
  const payload = inputFor('demo', [{ key: 'be', dir }]);

  await app.inject({ method: 'POST', url: '/api/projects', payload });

  const archived = await app.inject({
    method: 'POST',
    url: '/api/projects/demo/archive',
    payload: { expectedRevision: 1 },
  });

  assert.equal(archived.statusCode, 200);
  assert.equal(parseProjectDetail(archived.json()).archivedAt !== null, true);
  assert.equal(parseProjectDetail(archived.json()).revision, 2);

  const again = await app.inject({
    method: 'POST',
    url: '/api/projects/demo/archive',
    payload: { expectedRevision: 2 },
  });

  assert.equal(again.statusCode, 409);
  assert.equal(parseProjectsError(again.json()).error, 'archived');

  const restored = await app.inject({
    method: 'POST',
    url: '/api/projects/demo/restore',
    payload: { expectedRevision: 2 },
  });

  assert.equal(restored.statusCode, 200);
  assert.equal(parseProjectDetail(restored.json()).archivedAt, null);
  assert.deepEqual(events.map((event) => event.data.kind), ['created', 'archived', 'restored']);
});

test('архив при блокирующей связи отвечает 409 active_rules', async (t) => {
  const { app, env } = await projectsApp(t);
  const dir = await makeRepoDir(env, 'be');

  await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: inputFor('demo', [{ key: 'be', dir }]),
  });
  app.projects.registerDependencyProvider({
    kind: 'telegram',
    label: 'Правила Telegram',
    blocksArchive: true,
    count: () => ({ count: 1, items: ['Правило A'] }),
  });

  const blocked = await app.inject({
    method: 'POST',
    url: '/api/projects/demo/archive',
    payload: { expectedRevision: 1 },
  });
  const body = parseProjectsError(blocked.json());

  assert.equal(blocked.statusCode, 409);
  assert.equal(body.error, 'active_rules');
  assert.match(body.message, /Правила Telegram/);
  assert.equal(env.prefs.readStored().projects.demo.archivedAt, null);
});
