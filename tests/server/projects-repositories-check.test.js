// Проверка путей репозиториев без сохранения: что человек видит у строки формы.
//
// Проверка идёт по диску и никогда не запускает git: на недоступном каталоге или
// сетевой ФС команда висела бы, а по одному `.git` видно и рабочую копию, и копию,
// связанную с другим каталогом. Пути — доверенный ввод человека, поэтому они
// обрабатываются буквально: ни пробел, ни кириллица, ни `$(...)` в имени не особый случай.
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

import { checkRepositoryPath } from '../../server/src/lib/projects/repositoryCheck.ts';
import projectsModule from '../../server/src/modules/projects/index.ts';
import { PrefsStore } from '../../server/src/lib/prefsStore.ts';
import { parseRepositoryCheck } from '../../shared/projectsContracts.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

async function withDirs(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-repository-check-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  return root;
}

async function makeDirectory(parent, name) {
  const dir = path.join(parent, name);

  await mkdir(dir, { recursive: true });

  return dir;
}

test('git, worktree, dir, missing, file, denied различаются текстом состояния', async (t) => {
  const root = await withDirs(t);
  const repo = await makeDirectory(root, 'repo');
  const linked = await makeDirectory(root, 'linked');
  const plain = await makeDirectory(root, 'рабочая копия $(echo x)');
  const missing = path.join(root, 'нет-такого');
  const file = path.join(root, 'файл.txt');

  await mkdir(path.join(repo, '.git'));
  await writeFile(path.join(linked, '.git'), 'gitdir: /tmp/чужой-каталог\n', 'utf8');
  await writeFile(file, 'не каталог\n', 'utf8');

  const states = {
    git: (await checkRepositoryPath(repo)).state,
    worktree: (await checkRepositoryPath(linked)).state,
    dir: (await checkRepositoryPath(plain)).state,
    missing: (await checkRepositoryPath(missing)).state,
    file: (await checkRepositoryPath(file)).state,
  };

  assert.deepEqual(states, {
    git: 'git',
    worktree: 'worktree',
    dir: 'dir',
    missing: 'missing',
    file: 'file',
  });

  const result = await checkRepositoryPath(repo);

  assert.equal(result.dir, repo);
  assert.match(result.message, /git/);
  assert.match((await checkRepositoryPath(missing)).message, /нет/i);
  assert.match((await checkRepositoryPath(file)).message, /файл/i);

  // Каталог без .git, но с именем-командой: имя не подставляется в шелл.
  assert.equal((await checkRepositoryPath(await makeDirectory(root, 'обычный'))).state, 'dir');
});

test('denied: каталог без доступа отличается от отсутствующего', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('под root права доступа не проверяются');

    return;
  }

  const root = await withDirs(t);
  const lockedParent = await makeDirectory(root, 'locked');
  const locked = path.join(lockedParent, 'child');

  await mkdir(locked);
  await chmod(lockedParent, 0o000);

  // Права возвращаются до уборки каталога: иначе `rm` не сможет его прочитать,
  // и тест упадёт на уборке, а не на проверке.
  const result = await checkRepositoryPath(locked).finally(() => chmod(lockedParent, 0o755));

  assert.equal(result.state, 'denied');
  assert.match(result.message, /доступ/i);
});

test('timeout: медленный stat подменяется опцией, остальные пути отвечают', async () => {
  const slowStat = () => new Promise((resolve) => {
    setTimeout(() => resolve({ isDirectory: () => true }), 100);
  });
  const slow = await checkRepositoryPath('/srv/медленный', { timeoutMs: 10, stat: slowStat });

  assert.equal(slow.state, 'timeout');
  assert.match(slow.message, /время/i);

  const fast = await checkRepositoryPath('/srv', { timeoutMs: 3000 });
  const missing = await checkRepositoryPath('/srv/нет-такого-каталога', { timeoutMs: 3000 });

  assert.equal(fast.state, 'dir');
  assert.equal(missing.state, 'missing');
});

test('HTTP: результаты проходят parseRepositoryCheck, относительный путь — 400', async (t) => {
  const root = await withDirs(t);
  const repo = await makeDirectory(root, 'repo');
  const profilesDir = await makeDirectory(root, 'profiles');
  const routesDir = await makeDirectory(root, 'routes');
  const prefs = new PrefsStore({ prefsPath: path.join(root, 'prefs.json') });
  const app = Fastify({ logger: false });

  await mkdir(path.join(repo, '.git'));
  app.decorate('sse', { broadcast: () => {} });
  await app.register(projectsModule, {
    config: { factoryHome: root, profilesDir, routesDir },
    prefs,
  });
  t.after(() => app.close());

  const checked = await app.inject({
    method: 'POST',
    url: '/api/project-tools/repositories/check',
    payload: { repos: [{ dir: repo }, { dir: path.join(root, 'нет-такого') }] },
  });

  assert.equal(checked.statusCode, 200);
  assert.deepEqual(parseRepositoryCheck(checked.json()), {
    results: [
      { dir: repo, state: 'git', message: 'Рабочая копия git' },
      { dir: path.join(root, 'нет-такого'), state: 'missing', message: 'Каталога нет' },
    ],
  });

  const relative = await app.inject({
    method: 'POST',
    url: '/api/project-tools/repositories/check',
    payload: { repos: [{ dir: 'srv/repo' }] },
  });

  assert.equal(relative.statusCode, 400);
  assert.equal(relative.json().error, 'bad_dir');
});
