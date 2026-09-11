// Контекст изменений для модели: что из репозитория стенда доезжает до промпта.
//
// Главное свойство — честность о рабочем дереве: попытка конвейера до отгрузки
// держит готовую работу незакоммиченной, и разбор, который смотрит только на
// коммиты, рассказывал бы о пустой задаче. Второе — файлы окружения стенда с его
// схемами и паролями в промпт не попадают.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { collectDiffContext } from '../../server/src/lib/showcase/script/context.ts';

const run = promisify(execFile);

async function git(cwd, args) {
  await run('git', ['-C', cwd, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.test',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.test',
    },
  });
}

/**
 * Репозиторий задачи: главная ветка с базовым коммитом и ветка задачи, на которой
 * правка ещё не закоммичена, — ровно так выглядит стенд попытки перед отгрузкой.
 */
async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-context-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  await git(root, ['init', '-q', '-b', 'main']);
  await writeFile(path.join(root, 'app.js'), 'export const filter = false;\n', 'utf8');
  await writeFile(path.join(root, '.env.testing'), 'DB_PASSWORD=секрет-стенда\n', 'utf8');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-q', '-m', 'база']);
  await git(root, ['checkout', '-q', '-b', 'route-task-1']);

  return root;
}

test('незакоммиченная правка ветки попадает в контекст', async (t) => {
  const root = await repository(t);

  await writeFile(path.join(root, 'app.js'), 'export const filter = true;\n', 'utf8');

  const context = await collectDiffContext([{ name: 'frontend', path: root, branch: 'route-task-1' }]);

  assert.match(context.diff, /\+export const filter = true;/);
  assert.match(context.base, /^frontend:[0-9a-f]{12}$/);
  assert.equal(context.truncated, false);
});

test('новый файл без коммита тоже виден модели', async (t) => {
  const root = await repository(t);

  await mkdir(path.join(root, 'components'), { recursive: true });
  await writeFile(path.join(root, 'components', 'Clear.vue'), '<template>x</template>\n', 'utf8');

  const context = await collectDiffContext([{ name: 'frontend', path: root, branch: 'route-task-1' }]);

  assert.match(context.diff, /новый файл components\/Clear\.vue/);
  assert.match(context.diff, /<template>x<\/template>/);
});

test('файлы окружения стенда в промпт не попадают', async (t) => {
  const root = await repository(t);

  await writeFile(path.join(root, '.env.testing'), 'DB_PASSWORD=другой-секрет\n', 'utf8');
  await writeFile(path.join(root, '.env.local'), 'TOKEN=новый\n', 'utf8');
  await writeFile(path.join(root, 'app.js'), 'export const filter = null;\n', 'utf8');

  const context = await collectDiffContext([{ name: 'backend', path: root, branch: 'route-task-1' }]);

  assert.doesNotMatch(context.diff, /секрет/);
  assert.doesNotMatch(context.diff, /TOKEN=новый/);
  assert.match(context.diff, /filter = null/);
});

test('без изменений контекст пуст и честно об этом говорит', async (t) => {
  const root = await repository(t);
  const context = await collectDiffContext([{ name: 'backend', path: root, branch: 'route-task-1' }]);

  assert.equal(context.diff, '');
  assert.equal(context.base, 'не определена');
});
