// Сервис паспортов проектов: запись, чтение и защита от чужих правок.
//
// Паспорт лежит в том же файле настроек, что и остальные настройки GrigDesk, и пишется
// целиком. Отсюда два свойства, которые и проверяются здесь: каждая мутация идёт через
// одну очередь и перечитывает файл внутри неё (иначе параллельные правки затирают друг
// друга), а нечитаемый файл не превращается в «пустые настройки» (иначе порча стирает
// все паспорта разом).
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PrefsStore, PrefsCorruptedError } from '../../server/src/lib/prefsStore.ts';
import { ProjectsError } from '../../server/src/modules/projects/errors.ts';
import { createProjectsService } from '../../server/src/modules/projects/service.ts';

const NOW = '2026-09-22T10:00:00.000Z';
const EMPTY_IMPORT = {
  status: 'none',
  fingerprint: null,
  at: null,
  error: null,
  candidates: null,
};

async function withPrefs(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-projects-service-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prefsPath = path.join(dir, 'prefs.json');
  const profilesDir = path.join(dir, 'profiles');
  const routesDir = path.join(dir, 'routes');

  await mkdir(profilesDir, { recursive: true });
  await mkdir(routesDir, { recursive: true });

  return { dir, prefsPath, profilesDir, routesDir, prefs: new PrefsStore({ prefsPath }) };
}

/** Профиль фабрики — каталог со схемой; profile.sh появляется, если заданы пути. */
async function makeProfile({ profilesDir, id, repos, capabilities = [] }) {
  const profileDir = path.join(profilesDir, id);

  await mkdir(profileDir, { recursive: true });
  await writeFile(
    path.join(profileDir, 'graph.json'),
    JSON.stringify({ capabilities }, null, 2),
    'utf8',
  );
  if (repos !== undefined) {
    await writeFile(path.join(profileDir, 'profile.sh'), `PROFILE_TRIAGE_REPOS="${repos}"\n`, 'utf8');
  }

  return profileDir;
}

/** Каталог репозитория внутри временного корня: пути настоящие, `exists` честный. */
async function makeRepoDir(env, name) {
  const dir = path.join(env.dir, 'repos', name);

  await mkdir(dir, { recursive: true });

  return dir;
}

function serviceFor(env, { broadcast = true } = {}) {
  const events = [];
  const changes = [];
  const service = createProjectsService({
    config: {
      factoryHome: env.dir,
      profilesDir: env.profilesDir,
      routesDir: env.routesDir,
    },
    prefs: env.prefs,
    broadcast: broadcast ? (event, data) => events.push({ event, data }) : undefined,
    now: () => NOW,
  });

  service.onChange((change) => changes.push(change));

  return { service, events, changes };
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

/** Тело изменения: id в нём нет — идентификатор проекта не меняется. */
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

function isProjectsError(error, status, code) {
  assert.ok(error instanceof ProjectsError, `ожидалась ProjectsError, пришло ${error}`);
  assert.equal(error.status, status);
  assert.equal(error.code, code);

  return true;
}

test('create пишет паспорт: revision 1, createdAt = updatedAt = now, title, порядок repos', async (t) => {
  const env = await withPrefs(t);
  const be = await makeRepoDir(env, 'be');
  const fe = await makeRepoDir(env, 'fe');
  const { service, events, changes } = serviceFor(env);
  const detail = await service.create(inputFor('demo', [
    { key: 'be', dir: be },
    { key: 'fe', dir: fe },
  ], { title: 'Демо-проект', description: 'Описание', tags: ['конвейер'] }));

  assert.deepEqual(env.prefs.readStored().projects.demo, {
    title: 'Демо-проект',
    description: 'Описание',
    tags: ['конвейер'],
    repos: [{ key: 'be', dir: be }, { key: 'fe', dir: fe }],
    defaultRepoKey: 'be',
    archivedAt: null,
    import: EMPTY_IMPORT,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
  assert.equal(detail.revision, 1);
  assert.equal(detail.importStatus, 'none');
  assert.deepEqual(detail.profile, {
    present: false,
    pathsSource: 'passport',
    readable: null,
    repos: [],
    capabilities: [],
    mismatch: [],
  });
  assert.deepEqual(events, [{
    event: 'projects-changed',
    data: { id: 'demo', revision: 1, kind: 'created' },
  }]);
  assert.deepEqual(changes, [{ id: 'demo', revision: 1, kind: 'created' }]);
});

test('create с repos: [] создаёт явно пустой проект; без repos — отказ с path repos', async (t) => {
  const env = await withPrefs(t);
  const { service } = serviceFor(env);

  const empty = await service.create(inputFor('empty', []));

  assert.deepEqual(env.prefs.readStored().projects.empty.repos, []);
  assert.equal(empty.defaultRepoKey, null);

  const body = inputFor('bad', []);

  delete body.repos;
  await assert.rejects(
    service.create(body),
    (error) => {
      isProjectsError(error, 400, 'bad_request');
      assert.deepEqual(
        error.fieldErrors.map((fieldError) => fieldError.path),
        ['repos'],
      );

      return true;
    },
  );
});

test('create отклоняет: id на цифру, существующий id, чужое поле, чужой defaultRepoKey', async (t) => {
  const env = await withPrefs(t);
  const dir = await makeRepoDir(env, 'repo');
  const { service } = serviceFor(env);

  await makeProfile({ profilesDir: env.profilesDir, id: 'factory', repos: `be:${dir}` });
  await service.create(inputFor('demo', [{ key: 'be', dir }]));

  await assert.rejects(
    service.create(inputFor('2gis', [{ key: 'be', dir }])),
    (error) => isProjectsError(error, 400, 'bad_id'),
  );
  await assert.rejects(
    service.create(inputFor('demo', [{ key: 'be', dir }])),
    (error) => isProjectsError(error, 409, 'exists'),
  );
  await assert.rejects(
    service.create(inputFor('factory', [{ key: 'be', dir }])),
    (error) => isProjectsError(error, 409, 'exists'),
  );
  await assert.rejects(
    service.create(inputFor('other', [{ key: 'be', dir }], { foo: 1 })),
    (error) => isProjectsError(error, 400, 'unknown_field'),
  );
  await assert.rejects(
    service.create(inputFor('other', [{ key: 'be', dir }], { defaultRepoKey: 'fe' })),
    (error) => isProjectsError(error, 400, 'bad_default_repo'),
  );
});

test('read для профиля без записи синтезирует паспорт с revision 0 и pathsSource profile', async (t) => {
  const env = await withPrefs(t);
  const be = await makeRepoDir(env, 'be');
  const fe = await makeRepoDir(env, 'fe');

  await makeProfile({
    profilesDir: env.profilesDir,
    id: 'factory',
    repos: `be:${be} fe:${fe}`,
    capabilities: ['triage'],
  });

  const { service } = serviceFor(env);
  const detail = await service.read('factory');

  assert.equal(detail.revision, 0);
  assert.equal(detail.title, 'factory');
  assert.equal(detail.createdAt, null);
  assert.deepEqual(detail.repos, [
    { key: 'be', dir: be, exists: true },
    { key: 'fe', dir: fe, exists: true },
  ]);
  assert.deepEqual(detail.profile, {
    present: true,
    pathsSource: 'profile',
    readable: true,
    repos: [{ key: 'be', dir: be }, { key: 'fe', dir: fe }],
    capabilities: ['triage'],
    mismatch: [],
  });
  assert.deepEqual(env.prefs.readStored(), {});

  const updated = await service.update('factory', {
    title: 'Фабричный проект',
    description: '',
    tags: [],
    repos: [{ key: 'be', dir: be }, { key: 'fe', dir: fe }],
    defaultRepoKey: 'be',
  }, 0);

  assert.equal(updated.revision, 1);
  assert.equal(updated.title, 'Фабричный проект');
  assert.equal(env.prefs.readStored().projects.factory.revision, 1);
  assert.equal(env.prefs.readStored().projects.factory.createdAt, NOW);
});

test('update: верная ревизия растит revision, отсутствие и строка — отказ', async (t) => {
  const env = await withPrefs(t);
  const dir = await makeRepoDir(env, 'repo');
  const { service, events, changes } = serviceFor(env);
  const repos = [{ key: 'be', dir }];

  await service.create(inputFor('demo', repos));

  const saved = await service.update('demo', updateBody(repos), 1);

  assert.equal(saved.revision, 2);
  assert.equal(saved.title, 'Новое название');
  assert.deepEqual(events.at(-1), {
    event: 'projects-changed',
    data: { id: 'demo', revision: 2, kind: 'updated' },
  });
  assert.deepEqual(changes.at(-1), { id: 'demo', revision: 2, kind: 'updated' });

  await assert.rejects(
    service.update('demo', updateBody(repos), 1),
    (error) => {
      isProjectsError(error, 409, 'revision_conflict');
      assert.equal(error.currentRevision, 2);

      return true;
    },
  );
  await assert.rejects(
    service.update('demo', updateBody(repos), undefined),
    (error) => {
      isProjectsError(error, 400, 'revision_required');
      assert.match(error.message, /Обновите вкладку/);

      return true;
    },
  );
  await assert.rejects(
    service.update('demo', updateBody(repos), '1'),
    (error) => isProjectsError(error, 400, 'bad_revision'),
  );
});

test('параллельные update двух проектов и write соседней настройки не теряют данных', async (t) => {
  const env = await withPrefs(t);
  const dir = await makeRepoDir(env, 'repo');
  const { service } = serviceFor(env);
  const repos = [{ key: 'be', dir }];

  await service.create(inputFor('a', repos));
  await service.create(inputFor('b', repos));

  const first = service.update('a', updateBody(repos, { title: 'Проект А' }), 1);

  env.prefs.write({ showAllModels: true });
  const second = service.update('b', updateBody(repos, { title: 'Проект Б' }), 1);

  const [a, b] = await Promise.all([first, second]);
  const stored = env.prefs.readStored();

  assert.equal(a.revision, 2);
  assert.equal(b.revision, 2);
  assert.equal(stored.showAllModels, true);
  assert.equal(stored.projects.a.title, 'Проект А');
  assert.equal(stored.projects.b.title, 'Проект Б');
  assert.equal(stored.projects.a.revision, 2);
  assert.equal(stored.projects.b.revision, 2);
});

test('update сохраняет неизвестные внутренние поля записи', async (t) => {
  const env = await withPrefs(t);
  const dir = await makeRepoDir(env, 'repo');
  const { service } = serviceFor(env);
  const repos = [{ key: 'be', dir }];

  env.prefs.write({ projects: { demo: { repos, extra: 1 } } });
  const detail = await service.update('demo', updateBody(repos, { title: 'С правкой' }), 0);

  assert.equal(detail.revision, 1);
  assert.equal(env.prefs.readStored().projects.demo.extra, 1);
  assert.equal(env.prefs.readStored().projects.demo.title, 'С правкой');
});

test('update архивной записи отклоняется', async (t) => {
  const env = await withPrefs(t);
  const dir = await makeRepoDir(env, 'repo');
  const { service } = serviceFor(env);
  const repos = [{ key: 'be', dir }];

  env.prefs.write({
    projects: {
      demo: {
        repos,
        title: 'В архиве',
        archivedAt: '2026-09-01T00:00:00.000Z',
        revision: 1,
      },
    },
  });

  await assert.rejects(
    service.update('demo', updateBody(repos), 1),
    (error) => isProjectsError(error, 409, 'archived'),
  );
  assert.equal(env.prefs.readStored().projects.demo.title, 'В архиве');
});

test('update repos фабричного проекта с PROFILE_TRIAGE_REPOS отклоняется, поля правятся', async (t) => {
  const env = await withPrefs(t);
  const be = await makeRepoDir(env, 'be');
  const fe = await makeRepoDir(env, 'fe');

  await makeProfile({ profilesDir: env.profilesDir, id: 'factory', repos: `be:${be} fe:${fe}` });

  const { service } = serviceFor(env);
  const saved = await service.update('factory', {
    title: 'Переименован',
    description: 'Описание',
    tags: ['метка'],
    repos: [{ key: 'be', dir: be }, { key: 'fe', dir: fe }],
    defaultRepoKey: 'be',
  }, 0);

  assert.equal(saved.title, 'Переименован');
  assert.deepEqual(saved.tags, ['метка']);

  await assert.rejects(
    service.update('factory', {
      title: 'Переименован',
      description: 'Описание',
      tags: ['метка'],
      repos: [{ key: 'be', dir: be }],
      defaultRepoKey: 'be',
    }, 1),
    (error) => isProjectsError(error, 409, 'factory_project'),
  );
  assert.equal(env.prefs.readStored().projects.factory.title, 'Переименован');
});

test('валидация путей: bad_dir, dup_key, bad_key и path.normalize', async (t) => {
  const env = await withPrefs(t);
  const { service } = serviceFor(env);

  await assert.rejects(
    service.create(inputFor('rel', [{ key: 'be', dir: 'srv/be' }])),
    (error) => isProjectsError(error, 400, 'bad_dir'),
  );
  await assert.rejects(
    service.create(inputFor('nul', [{ key: 'be', dir: '/srv/a\u0000b' }])),
    (error) => isProjectsError(error, 400, 'bad_dir'),
  );
  await assert.rejects(
    service.create(inputFor('dup', [{ key: 'be', dir: '/srv/a' }, { key: 'be', dir: '/srv/b' }])),
    (error) => {
      isProjectsError(error, 400, 'dup_key');
      assert.deepEqual(error.fieldErrors.map((fieldError) => fieldError.path), ['repos.1.key']);

      return true;
    },
  );
  await assert.rejects(
    service.create(inputFor('key', [{ key: 'BE', dir: '/srv/a' }])),
    (error) => isProjectsError(error, 400, 'bad_key'),
  );

  const normalized = await service.create(inputFor('norm', [{ key: 'be', dir: '/srv/a/../b' }]));

  assert.deepEqual(normalized.repos, [{ key: 'be', dir: '/srv/b', exists: false }]);
  assert.equal(env.prefs.readStored().projects.norm.repos[0].dir, '/srv/b');
});

test('list отдаёт сводки: exists, pathsSource, пустые routes без бандла, архив включён', async (t) => {
  const env = await withPrefs(t);
  const here = await makeRepoDir(env, 'here');
  const gone = path.join(env.dir, 'repos', 'gone');

  await makeProfile({ profilesDir: env.profilesDir, id: 'factory', repos: `be:${here}` });

  const { service } = serviceFor(env);

  await service.create(inputFor('grigdesk', [
    { key: 'be', dir: here },
    { key: 'fe', dir: gone },
  ]));
  env.prefs.write({
    projects: {
      ...env.prefs.readStored().projects,
      old: { repos: [], title: 'Старый', archivedAt: '2026-09-01T00:00:00.000Z', revision: 2 },
    },
  });

  const summaries = await service.list();
  const byId = new Map(summaries.map((summary) => [summary.id, summary]));

  assert.deepEqual([...byId.keys()].sort(), ['factory', 'grigdesk', 'old']);
  assert.deepEqual(byId.get('grigdesk').repos, [
    { key: 'be', dir: here, exists: true },
    { key: 'fe', dir: gone, exists: false },
  ]);
  assert.equal(byId.get('grigdesk').profile.pathsSource, 'passport');
  assert.equal(byId.get('factory').profile.pathsSource, 'profile');
  assert.deepEqual(byId.get('factory').repos, [{ key: 'be', dir: here, exists: true }]);
  assert.deepEqual(byId.get('grigdesk').routes, []);
  assert.equal(byId.get('old').archivedAt, '2026-09-01T00:00:00.000Z');
  assert.equal(byId.get('old').revision, 2);
  // Ненайденный путь — предупреждение: после восстановления из архива о нём надо сказать.
  assert.deepEqual(byId.get('grigdesk').warnings, [`Каталог ${gone} не найден.`]);
});

test('list предупреждает об одинаковых физических корнях', async (t) => {
  const env = await withPrefs(t);
  const shared = await makeRepoDir(env, 'shared');
  const { service } = serviceFor(env);

  await service.create(inputFor('aliases', [
    { key: 'be', dir: shared },
    { key: 'fe', dir: path.join(shared, '.') },
  ]));

  const [summary] = await service.list();

  assert.equal(summary.warnings.length, 1);
  assert.match(summary.warnings[0], /be.*fe|fe.*be/);
});

test('archive ставит archivedAt, растит ревизию и шлёт событие archived', async (t) => {
  const env = await withPrefs(t);
  const dir = await makeRepoDir(env, 'repo');
  const { service, events } = serviceFor(env);

  await service.create(inputFor('demo', [{ key: 'be', dir }]));
  const detail = await service.archive('demo', 1);
  const record = env.prefs.readStored().projects.demo;

  assert.equal(detail.archivedAt, NOW);
  assert.equal(detail.revision, 2);
  assert.equal(record.archivedAt, NOW);
  assert.equal(record.revision, 2);
  assert.equal(record.title, 'Проект demo');
  assert.deepEqual(events.at(-1), {
    event: 'projects-changed',
    data: { id: 'demo', revision: 2, kind: 'archived' },
  });

  await assert.rejects(
    service.archive('demo', 2),
    (error) => isProjectsError(error, 409, 'archived'),
  );
});

test('archive профиля без записи создаёт запись с путями профиля', async (t) => {
  const env = await withPrefs(t);
  const be = await makeRepoDir(env, 'be');

  await makeProfile({ profilesDir: env.profilesDir, id: 'factory', repos: `be:${be}` });

  const { service } = serviceFor(env);
  const detail = await service.archive('factory', 0);
  const record = env.prefs.readStored().projects.factory;

  assert.equal(detail.archivedAt, NOW);
  assert.equal(record.revision, 1);
  assert.equal(record.archivedAt, NOW);
  assert.equal(record.title, 'factory');
  assert.deepEqual(record.repos, [{ key: 'be', dir: be }]);
  assert.equal(record.createdAt, NOW);
});

test('archive и restore требуют верную ревизию', async (t) => {
  const env = await withPrefs(t);
  const dir = await makeRepoDir(env, 'repo');
  const { service } = serviceFor(env);

  await service.create(inputFor('demo', [{ key: 'be', dir }]));

  await assert.rejects(
    service.archive('demo', undefined),
    (error) => isProjectsError(error, 400, 'revision_required'),
  );
  await assert.rejects(
    service.archive('demo', 7),
    (error) => isProjectsError(error, 409, 'revision_conflict'),
  );
  await assert.rejects(
    service.restore('demo', 1),
    (error) => isProjectsError(error, 409, 'not_archived'),
  );
});

test('restore снимает архив, шлёт событие restored и предупреждает о недоступном пути', async (t) => {
  const env = await withPrefs(t);
  const dir = await makeRepoDir(env, 'repo');
  const gone = path.join(env.dir, 'repos', 'gone');
  const { service, events } = serviceFor(env);

  await service.create(inputFor('demo', [{ key: 'be', dir }, { key: 'fe', dir: gone }]));
  await service.archive('demo', 1);
  await rm(gone, { recursive: true, force: true });

  const detail = await service.restore('demo', 2);

  assert.equal(detail.archivedAt, null);
  assert.equal(detail.revision, 3);
  assert.equal(env.prefs.readStored().projects.demo.archivedAt, null);
  assert.deepEqual(events.at(-1), {
    event: 'projects-changed',
    data: { id: 'demo', revision: 3, kind: 'restored' },
  });
  assert.deepEqual(detail.warnings, [`Каталог ${gone} не найден.`]);
});

test('повреждённый файл настроек: create отклоняется, файл не изменён', async (t) => {
  const env = await withPrefs(t);
  const dir = await makeRepoDir(env, 'repo');
  const broken = '{"speech":';

  await writeFile(env.prefsPath, broken, 'utf8');
  const { service } = serviceFor(env);

  await assert.rejects(
    service.create(inputFor('demo', [{ key: 'be', dir }])),
    PrefsCorruptedError,
  );
  assert.equal(await readFile(env.prefsPath, 'utf8'), broken);
});

test('read неизвестного проекта и чужого id', async (t) => {
  const env = await withPrefs(t);
  const { service } = serviceFor(env);

  await assert.rejects(
    service.read('nope'),
    (error) => isProjectsError(error, 404, 'not_found'),
  );
  await assert.rejects(
    service.read('../escape'),
    (error) => isProjectsError(error, 400, 'bad_id'),
  );
});
