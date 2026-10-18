// Связи проекта: кто ещё держится за этот id, прежде чем проект прятать или удалять.
//
// Сводка собирается из провайдеров — по одному на раздел, который хранит ссылку на
// проект. Ошибка провайдера не означает «связей нет»: архив и удаление тогда
// запрещаются, иначе проект исчез бы вместе с чужими ссылками на него.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PrefsStore } from '../../server/src/lib/prefsStore.ts';
import { ProjectsError } from '../../server/src/modules/projects/errors.ts';
import { createProjectsService } from '../../server/src/modules/projects/service.ts';

const NOW = '2026-09-22T10:00:00.000Z';

async function withPrefs(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-projects-dependencies-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prefsPath = path.join(dir, 'prefs.json');
  const profilesDir = path.join(dir, 'profiles');
  const routesDir = path.join(dir, 'routes');

  await mkdir(profilesDir, { recursive: true });
  await mkdir(routesDir, { recursive: true });

  return { dir, prefsPath, profilesDir, routesDir, prefs: new PrefsStore({ prefsPath }) };
}

async function makeRepoDir(env, name) {
  const dir = path.join(env.dir, 'repos', name);

  await mkdir(dir, { recursive: true });

  return dir;
}

function serviceFor(env) {
  return createProjectsService({
    config: { factoryHome: env.dir, profilesDir: env.profilesDir, routesDir: env.routesDir },
    prefs: env.prefs,
    now: () => NOW,
  });
}

/** Провайдер-двойник: считает связи так же, как настоящий раздел. */
function provider({ kind, label, blocksArchive = false, count = 0, items = [], fail = null }) {
  const calls = [];

  return {
    calls,
    kind,
    label,
    blocksArchive,
    count: async (id) => {
      calls.push(id);

      if (fail) {
        throw new Error(fail);
      }

      return { count, items };
    },
  };
}

test('сводка считает каждый вид связей и уважает blocksArchive', async (t) => {
  const env = await withPrefs(t);
  const dir = await makeRepoDir(env, 'be');
  const service = serviceFor(env);
  const telegram = provider({
    kind: 'telegram',
    label: 'Правила Telegram',
    blocksArchive: true,
    count: 2,
    items: ['Правило A', 'Правило B'],
  });
  const ssh = provider({ kind: 'ssh', label: 'Профили SSH', count: 1, items: ['prod'] });
  const showcase = provider({ kind: 'showcase', label: 'Цели презентаций' });

  for (const item of [telegram, ssh, showcase]) {
    service.registerDependencyProvider(item);
  }

  await service.create({
    id: 'demo',
    title: 'Демо',
    description: '',
    tags: [],
    repos: [{ key: 'be', dir }],
    defaultRepoKey: 'be',
  });

  const summary = await service.dependencies('demo');

  assert.deepEqual(summary.items, [
    { kind: 'telegram', label: 'Правила Telegram', count: 2, items: ['Правило A', 'Правило B'] },
    { kind: 'ssh', label: 'Профили SSH', count: 1, items: ['prod'] },
  ]);
  assert.equal(summary.archivable, false);
  assert.equal(summary.deletable, false);
  assert.deepEqual(telegram.calls, ['demo']);
  assert.deepEqual(ssh.calls, ['demo']);
  assert.deepEqual(showcase.calls, ['demo']);
  assert.match(summary.reasons.join(' '), /Правила Telegram/);
  assert.match(summary.reasons.join(' '), /2/);
});

test('связи без блокировки архив не запрещают, а удаление требует архива', async (t) => {
  const env = await withPrefs(t);
  const dir = await makeRepoDir(env, 'be');
  const service = serviceFor(env);

  service.registerDependencyProvider(provider({ kind: 'ssh', label: 'Профили SSH', count: 1 }));

  await service.create({
    id: 'demo',
    title: 'Демо',
    description: '',
    tags: [],
    repos: [{ key: 'be', dir }],
    defaultRepoKey: 'be',
  });

  const before = await service.dependencies('demo');

  assert.equal(before.archivable, true);
  assert.equal(before.deletable, false, 'удалять можно только архивную запись');
  assert.deepEqual(before.reasons, []);

  await service.archive('demo', 1);

  const archived = await service.dependencies('demo');

  assert.equal(archived.deletable, false, 'со связями удалять нельзя');
  assert.equal(archived.archivable, true);
});

test('пустой архивный проект без профиля на диске удаляем', async (t) => {
  const env = await withPrefs(t);
  const service = serviceFor(env);

  await service.create({
    id: 'demo',
    title: 'Демо',
    description: '',
    tags: [],
    repos: [],
    defaultRepoKey: null,
  });
  await service.archive('demo', 1);

  const summary = await service.dependencies('demo');

  assert.deepEqual(summary, { items: [], archivable: true, deletable: true, reasons: [] });
});

test('ошибка провайдера запрещает и архив, и удаление, и называет причину', async (t) => {
  const env = await withPrefs(t);
  const service = serviceFor(env);

  service.registerDependencyProvider(provider({
    kind: 'telegram',
    label: 'Правила Telegram',
    blocksArchive: true,
    fail: 'файл правил не читается',
  }));

  await service.create({
    id: 'demo',
    title: 'Демо',
    description: '',
    tags: [],
    repos: [],
    defaultRepoKey: null,
  });

  const summary = await service.dependencies('demo');

  assert.equal(summary.archivable, false);
  assert.equal(summary.deletable, false);
  assert.match(summary.reasons.join(' '), /Правила Telegram/);
  assert.match(summary.reasons.join(' '), /файл правил не читается/);

  await assert.rejects(
    service.archive('demo', 1),
    (error) => error instanceof ProjectsError && error.status === 409 && error.code === 'active_rules',
  );
});

test('archive при блокирующей связи отвечает active_rules и запись не меняет', async (t) => {
  const env = await withPrefs(t);
  const service = serviceFor(env);

  service.registerDependencyProvider(provider({
    kind: 'github',
    label: 'Правила GitHub',
    blocksArchive: true,
    count: 1,
    items: ['issue-42'],
  }));

  await service.create({
    id: 'demo',
    title: 'Демо',
    description: '',
    tags: [],
    repos: [],
    defaultRepoKey: null,
  });

  await assert.rejects(
    service.archive('demo', 1),
    (error) => {
      assert.ok(error instanceof ProjectsError);
      assert.equal(error.status, 409);
      assert.equal(error.code, 'active_rules');
      assert.match(error.message, /Правила GitHub/);

      return true;
    },
  );

  const record = env.prefs.readStored().projects.demo;

  assert.equal(record.archivedAt, null);
  assert.equal(record.revision, 1);
});

test('сторож: сборка приложения регистрирует провайдеров и отдаёт сервис модулю', async () => {
  const source = await readFile(new URL('../../server/src/app.ts', import.meta.url), 'utf8');
  const registrations = [...source.matchAll(
    /registerDependencyProvider\(\{\s*\n\s*kind: '([a-z]+)',[\s\S]*?\n\s*\}\);/gu,
  )].map(([block, kind]) => ({ kind, blocksArchive: /blocksArchive: true/u.test(block) }));
  const kinds = registrations.map((item) => item.kind);
  const blocking = registrations.filter((item) => item.blocksArchive).map((item) => item.kind);

  // Связи собираются в одном месте: разъехавшись по модулям, они перестали бы быть
  // сводкой и стали бы набором случайных проверок.
  assert.ok(kinds.length >= 7, `провайдеров связей слишком мало: ${kinds.join(', ')}`);
  assert.equal(new Set(kinds).size, kinds.length, 'вид связи повторяется');

  // Каждый раздел, который хранит ссылку на проект, обязан быть среди провайдеров:
  // пропущенный означает связь, о которой человек узнает уже после архива.
  for (const kind of ['routes', 'factory', 'ssh', 'db', 'showcase', 'telegram', 'github']) {
    assert.ok(kinds.includes(kind), `нет провайдера связей «${kind}»: ${kinds.join(', ')}`);
  }

  // Правила переживают архив и остались бы ссылками в никуда, поэтому только они
  // запрещают архив: остальные связи человек видит, но они его не держат.
  assert.deepEqual(blocking.sort(), ['github', 'telegram']);
  assert.match(
    source,
    /register\(projectsModule, \{ config, prefs, service: projectsService \}\)/u,
    'модуль обязан получить тот же сервис, на котором зарегистрированы провайдеры',
  );
});
