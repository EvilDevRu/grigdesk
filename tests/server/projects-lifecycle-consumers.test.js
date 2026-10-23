// Архив проекта у потребителей: что именно перестаёт его предлагать.
//
// Архив — не удаление: связи, маршруты и уже поднятые стенды остаются на месте.
// Меняется одно — проект больше не предлагается там, где начинают новое: список
// профилей без архивных, запуск конвейера отказывает, песочница не поднимается.
// Иначе обещание формы «разделы его больше не предлагают» остаётся словами.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import factoryModule from '../../server/src/modules/factory/index.ts';
import { createSandboxService } from '../../server/src/lib/sandboxes/service.ts';
import { listProjects } from '../../server/src/lib/profiles.ts';
import { archivedProjectIds, isProjectArchived } from '../../server/src/lib/projects.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

const ARCHIVED_AT = '2026-09-22T10:00:00.000Z';

/** Реестр-двойник: активный проект, архивный проект и запись без паспорта. */
function prefsDouble() {
  return {
    read: () => ({
      projects: {
        'project-alpha': { title: 'Альфа', repos: [] },
        'project-beta': { title: 'Бета', repos: [], archivedAt: ARCHIVED_AT },
      },
    }),
  };
}

async function profilesFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-lifecycle-consumers-'));
  const profilesDir = path.join(root, 'profiles');

  t.after(() => rm(root, { recursive: true, force: true }));

  for (const name of ['project-alpha', 'project-beta']) {
    await mkdir(path.join(profilesDir, name), { recursive: true });
    await writeFile(path.join(profilesDir, name, 'graph.json'), JSON.stringify({
      capabilities: [],
      default_route: 'feature',
      routes: { feature: { pos: { build: [0, 0] }, edges: [] } },
    }));
  }

  return { root, profilesDir };
}

test('список проектов умеет отдавать только активные, а по умолчанию — все', async (t) => {
  const { profilesDir } = await profilesFixture(t);
  const prefs = prefsDouble();

  assert.deepEqual(
    await listProjects({ profilesDir }, prefs),
    ['project-alpha', 'project-beta'],
    'по умолчанию список полный: архив ничего не рвёт',
  );
  assert.deepEqual(
    await listProjects({ profilesDir }, prefs, { includeArchived: false }),
    ['project-alpha'],
  );
  assert.deepEqual([...archivedProjectIds(prefs)], ['project-beta']);
  assert.equal(isProjectArchived(prefs, 'project-beta'), true);
  assert.equal(isProjectArchived(prefs, 'project-alpha'), false);
});

/**
 * Модуль фабрики получает временные профили и управляемый снимок настроек.
 * Исполняемый файл заведомо завершается ошибкой: отказ должен случиться до запуска.
 */
async function factoryFixture(t, givenPrefs = prefsDouble()) {
  const { root, profilesDir } = await profilesFixture(t);
  const installed = ['project-alpha', 'project-beta'];
  const factoryBin = path.join(root, 'factory');

  await writeFile(factoryBin, '#!/bin/sh\nexit 99\n');
  await chmod(factoryBin, 0o700);

  const app = Fastify({ logger: false });

  await app.register(factoryModule, {
    factoryState: {
      discoverProfiles() {
        return installed;
      },
      async primaryProfile() {
        return 'project-beta';
      },
      async readRegistry() {
        throw Object.assign(new Error('задача ещё не запускалась'), { code: 'ENOENT' });
      },
      isDaemonAlive() {
        return false;
      },
      async catalog() {
        return {
          routes: ['feature'],
          catalogHash: 'b'.repeat(64),
          routeOptions: {
            feature: {
              deliveryMode: 'publish', instrumentationMode: 'disabled', instrumentationRequired: false,
            },
          },
        };
      },
    },
    config: {
      factoryHome: root,
      factoryBin,
      factoryConfigRoot: path.join(root, 'config'),
      factoryControlDir: path.join(root, 'control'),
      routesDir: path.join(root, 'routes'),
      ticketsDir: path.join(root, 'tickets'),
      stateDir: path.join(root, 'state'),
      profilesDir,
      factoryProfile: '',
    },
    prefs: givenPrefs,
    b24: null,
    analyzer: {
      readClarifications: async () => null,
      readOpenQuestions: async () => null,
      answeredQuestions: async () => ({ ids: new Set(), keys: new Set() }),
      async get() {
        return { analysis: null };
      },
    },
  });

  await app.ready();
  t.after(() => app.close());

  return app;
}

test('форма запуска не предлагает архивный профиль и не берёт его по умолчанию', async (t) => {
  const app = await factoryFixture(t);

  const options = await app.inject({ method: 'GET', url: '/api/tasks/9123/launch-options' });

  assert.equal(options.statusCode, 200);
  assert.deepEqual(options.json().profiles, ['project-alpha']);
  // Профиль по умолчанию пришёл бы архивным (primaryProfile), но форма обязана
  // открыться на том, чем можно пользоваться.
  assert.equal(options.json().profile, 'project-alpha');
});

test('архивный профиль запросом и запуском отвечает 409 archived', async (t) => {
  const app = await factoryFixture(t);

  const options = await app.inject({
    method: 'GET',
    url: '/api/tasks/9123/launch-options?profile=project-beta',
  });

  assert.equal(options.statusCode, 409);
  assert.equal(options.json().error, 'archived');

  const launched = await app.inject({
    method: 'POST',
    url: '/api/tasks/9123/launch',
    payload: { profile: 'project-beta' },
  });

  assert.equal(launched.statusCode, 409);
  assert.equal(launched.json().error, 'archived');
});

test('песочница архивного проекта не поднимается, но остаётся в списке для сноса', async (t) => {
  const { root, profilesDir } = await profilesFixture(t);

  for (const name of ['project-alpha', 'project-beta']) {
    await writeFile(path.join(profilesDir, name, 'up.sh'), '#!/bin/sh\nexit 0\n');
    await writeFile(path.join(profilesDir, name, 'down.sh'), '#!/bin/sh\nexit 0\n');
  }

  const service = createSandboxService({
    stateDir: path.join(root, 'state'),
    journalDir: path.join(root, 'journal'),
    profilesDir,
    factoryBin: path.join(root, 'factory'),
    manualRange: { from: 9000, to: 9001 },
    isProjectArchived: (id) => id === 'project-beta',
  });

  t.after(() => service.stop());

  const overview = await service.overview();
  const archived = overview.profiles.find((profile) => profile.id === 'project-beta');
  const active = overview.profiles.find((profile) => profile.id === 'project-alpha');

  assert.equal(active.canRaise, true);
  assert.ok(archived, 'архивный профиль остаётся в списке: его стенд ещё нужно сносить');
  assert.equal(archived.canRaise, false);
  assert.match(archived.reason, /архив/iu);

  await assert.rejects(
    () => service.raise({ profile: 'project-beta', task: null }),
    (error) => error.code === 'sandbox_unsupported' || error.code === 'archived',
  );
});

for (const source of ['prefs', 'profile', 'both']) {
  test(`PD-catalog: tombstone скрыт при обоих includeArchived (${source})`, async (t) => {
    const { pdFixture } = await import('./helpers/projects-deletion.js');
    const { listFactoryProfiles } = await import('../../server/src/lib/profiles.ts');
    const f = await pdFixture(t, { source });

    f.prefs.write({ projectsMeta: { tombstones: { demo: { deletedAt: ARCHIVED_AT, revision: 2 } } } });

    for (const includeArchived of [true, false]) {
      assert.deepEqual(await listProjects(f.config, f.prefs, { includeArchived }), ['other']);
    }

    if (source !== 'prefs') {
      assert.equal((await listFactoryProfiles(f.profilesDir)).includes('demo'), true);
    }
  });
}

test('PD-repos: tombstone не разрешается через профиль', async (t) => {
  const { pdFixture } = await import('./helpers/projects-deletion.js');
  const { projectRepos, readProjectRecord } = await import('../../server/src/lib/projects.ts');
  const f = await pdFixture(t);

  f.prefs.write({ projectsMeta: { tombstones: { demo: { deletedAt: ARCHIVED_AT, revision: 2 } } } });
  assert.deepEqual(await projectRepos({
    config: f.config,
    prefs: f.prefs,
    id: 'demo'
  }), []);
  assert.equal(readProjectRecord(f.prefs, 'demo').title, 'Демо', 'raw паспорт остаётся читаемым');
});

test('PD-catalog-corrupt: нечитаемые prefs мягки для списка и строги для выбора', async (t) => {
  const { pdFixture } = await import('./helpers/projects-deletion.js');
  const { PrefsCorruptedError } = await import('../../server/src/lib/prefsStore.ts');
  const f = await pdFixture(t);

  await writeFile(f.prefsPath, '{битый JSON');
  assert.deepEqual(await listProjects(f.config, f.prefs), ['demo']);

  const projects = await import('../../server/src/lib/projects.ts');

  assert.equal(typeof projects.isProjectDeleted, 'function', 'строгий предикат tombstone отсутствует');
  assert.throws(() => projects.isProjectDeleted(f.prefs, 'demo'), PrefsCorruptedError);
});

test('PD-start: tombstone не предлагается и прямой запуск закрыт до процесса', async (t) => {
  const stored = {
    projects: {},
    projectsMeta: { tombstones: { 'project-beta': { deletedAt: ARCHIVED_AT, revision: 2 } } },
  };
  const prefs = { read: () => stored, readForWrite: () => stored };
  const app = await factoryFixture(t, prefs);
  const options = await app.inject('/api/tasks/9123/launch-options');

  assert.equal(options.statusCode, 200, options.body);
  assert.deepEqual(options.json().profiles, ['project-alpha']);

  for (const request of [
    { method: 'GET', url: '/api/tasks/9123/launch-options?profile=project-beta' },
    {
      method: 'POST',
      url: '/api/tasks/9123/launch',
      payload: {
        profile: 'project-beta'
      }
    },
  ]) {
    const response = await app.inject(request);

    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, 'tombstoned');
  }
});

test('PD-sandbox: tombstone сохраняет инвентарь и запрещает новый подъём', async (t) => {
  const { root, profilesDir } = await profilesFixture(t);

  for (const script of ['up.sh', 'down.sh']) {
    await writeFile(path.join(profilesDir, 'project-beta', script), '#!/bin/sh\nexit 99\n');
  }

  const service = createSandboxService({
    stateDir: path.join(root, 'state'),
    journalDir: path.join(root, 'journal'),
    profilesDir,
    factoryBin: path.join(root, 'factory'),
    manualRange: { from: 9000, to: 9001 },
    isProjectDeleted: (id) => id === 'project-beta',
  });

  t.after(() => service.stop());

  const overview = await service.overview();
  const deleted = overview.profiles.find((profile) => profile.id === 'project-beta');

  assert.equal(deleted.canRaise, false);
  await assert.rejects(service.raise({ profile: 'project-beta', task: null }));
});

test('PD-direct: новый chat-workdir не разрешает tombstone', async (t) => {
  const { pdFixture, PD_CHOICE } = await import('./helpers/projects-deletion.js');
  const { resolveChatWorkdir } = await import('../../server/src/lib/chat/workdir.ts');
  const f = await pdFixture(t);

  f.prefs.write({ projectsMeta: { tombstones: { demo: { deletedAt: ARCHIVED_AT, revision: 2 } } } });
  await assert.rejects(resolveChatWorkdir({
    config: { ...f.config, rootDir: f.appRoot },
    prefs: f.prefs,
    workdir: PD_CHOICE,
    provider: 'test',
    caps: { switch: 'resume', roots: 'multi' },
  }), { code: 'workdir_unknown_project' });
});

test('PD-target: новые цели tombstone не предлагаются, прямое создание закрыто', async (t) => {
  const { pdFixture, PD_NOW } = await import('./helpers/projects-deletion.js');
  const { createShowcaseTargets } = await import('../../server/src/lib/showcase/targets.ts');
  const { createShowcaseService } = await import('../../server/src/lib/showcase/service.ts');
  const f = await pdFixture(t);
  const stateDir = path.join(f.root, 'state');
  const contractDir = path.join(f.profilesDir, 'demo', 'showcase');

  await mkdir(stateDir);
  await mkdir(contractDir);
  await writeFile(
    path.join(f.profilesDir, 'demo', 'dashboard.env'),
    'FACTORY_STAND_URL=http://127.0.0.1:5199\n',
  );
  await writeFile(path.join(contractDir, 'target.json'), JSON.stringify({

    version: 1,
    environment: 'read-only',
    capabilities: ['record'],
    allowedOrigins: [],

    project: { record: 'http://127.0.0.1:5199', view: 'http://127.0.0.1:5199' },

  }));
  await writeFile(path.join(contractDir, 'screens.json'), JSON.stringify({
    version: 1,
    screens: [{

      id: 'root',
      title: 'Обзор',
      path: '/',
      readySelector: 'body',
      elements: [],

    }]
  }));

  const options = {

    profilesDir: f.profilesDir,
    stateDir,

    listProjects: () => listProjects(f.config, f.prefs),

    isProjectDeleted: (id) => id === 'demo',

    dataRevisionOf: async () => '1',

    sandboxOverview: async () => ({ sandboxes: [] }),

  };
  const targets = createShowcaseTargets(options);
  const before = await targets.choices();

  assert.equal(before.some((item) => item.ref.id === 'demo'), true,
    'fixture должна создавать настоящую цель');
  f.prefs.write({ projectsMeta: { tombstones: { demo: { deletedAt: PD_NOW, revision: 2 } } } });
  assert.equal((await targets.choices()).some((item) => item.profile === 'demo'), false);

  const service = createShowcaseService({

    ...options,
    showcaseDir: path.join(f.root, 'showcase'),
    authDir: path.join(f.root, 'auth'),
    browserPath: null,

    broadcast() { },

    limits: () => ({

      maxScenes: 20,
      maxSceneSeconds: 120,
      maxTotalSeconds: 600,

      retentionDays: 30,
      maxQueued: 4,
      jobTimeoutMs: 60000,

    }),

  });

  await assert.rejects(service.createProject({ ref: { kind: 'project', id: 'demo' }, title: 'Новый ролик' }));
});

test('PD-direct: code не разрешает корни tombstone через физический профиль', async (t) => {
  const { pdFixture, PD_NOW } = await import('./helpers/projects-deletion.js');
  const { default: codeModule } = await import('../../server/src/modules/code/index.ts');
  const f = await pdFixture(t, { git: true });
  const app = Fastify({ logger: false });

  app.decorate('pluginEnabled', () => true);
  await app.register(codeModule, { config: f.config, prefs: f.prefs });
  t.after(() => app.close());

  const before = await app.inject('/api/code/demo/repos');

  assert.equal(before.statusCode, 200, before.body);
  assert.equal(before.json().repos.length > 0, true);
  f.prefs.write({ projectsMeta: { tombstones: { demo: { deletedAt: PD_NOW, revision: 2 } } } });

  const after = await app.inject('/api/code/demo/repos');

  const unavailable = after.statusCode === 404
    || (after.statusCode === 200 && after.json().repos.length === 0);

  assert.equal(unavailable, true);
});

test('PD-start: нечитаемые prefs запрещают явный новый выбор до процесса', async (t) => {
  const { pdFixture } = await import('./helpers/projects-deletion.js');
  const f = await pdFixture(t);
  const app = await factoryFixture(t, f.prefs);

  await writeFile(f.prefsPath, '{повреждено');

  const response = await app.inject('/api/tasks/9123/launch-options?profile=project-beta');

  assert.equal(response.statusCode, 500, response.body);
  assert.equal(response.json().error, 'prefs_corrupted');
});
