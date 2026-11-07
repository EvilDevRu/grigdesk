import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { AuthStore } from '../../server/src/lib/authStore.ts';
import authPlugin from '../../server/src/plugins/auth.ts';
import codeModule from '../../server/src/modules/code/index.ts';

const exec = promisify(execFile);
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = require('fastify');

/**
 * Команды с pathspec получают буквальные пути, как и проверяемые серверные действия.
 * check-ignore сам принимает имена файлов и не поддерживает режим literal pathspec.
 * Его вывод оставляем без восьмеричного экранирования кириллицы для точной сверки имени.
 * Возвращаем stdout без trim, чтобы проверки замечали потерю переводов строк.
 */
export const git = async (root, args, options = {}) => {
  const commandOptions = args[0] === 'check-ignore'
    ? ['-c', 'core.quotePath=false'] : ['--literal-pathspecs'];
  const result = await exec('git', ['-C', root, ...commandOptions, ...args], options);

  return result.stdout;
};

/**
 * Создаёт собственный временный Git и настоящий HTTP-модуль без внешних сервисов.
 * Служебные данные фикстуры находятся вне репозитория и удаляются после закрытия приложения.
 */
export async function reviewFixture(t, { files = { 'app.txt': 'a\nb\nc\nd\n' }, unborn = false,
  auth = false } = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-review-'));
  const root = path.join(temp, 'repo');
  let enabled = true;
  let app;

  t.after(async () => {
    await app?.close();
    await rm(temp, { recursive: true, force: true });
  });
  await mkdir(root);
  await git(root, ['init', '-q', '-b', 'main']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await git(root, ['config', 'user.name', 'test']);
  await git(root, ['config', 'core.autocrlf', 'false']);

  const write = async (file, content) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  };

  for (const [file, content] of Object.entries(files)) {
    await write(file, content);
  }

  if (!unborn) {
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-qm', 'База']);
  }

  app = Fastify({ logger: false });

  if (auth) {
    const authStore = new AuthStore({
      legacyAccountPath: path.join(temp, 'account.json'),
      sessionsPath: path.join(temp, 'sessions.json'),
    });

    await app.register(authPlugin, { authStore });
  }

  app.decorate('pluginEnabled', () => enabled);
  app.register(codeModule, {
    config: {
      profilesDir: path.join(temp, 'profiles'),
      chatsDir: path.join(root, 'chats'),
      dataStateDir: path.join(root, 'private-state'),
    },
    prefs: { read: () => ({ projects: { demo: { repos: [{ key: 'main', dir: root }] } } }) },
  });
  await app.ready();

  const request = (action, payload, query = {}) => app.inject({
    method: payload === undefined ? 'GET' : 'POST',
    url: `/api/code/demo/${action}?${new URLSearchParams({ repo: 'main', ...query })}`,
    ...(payload === undefined ? {} : { payload }),
  });

  return {
    temp,
    root,
    app,
    write,
    request,
    disable: () => {
      enabled = false;
    },
  };
}

/**
 * Снимок включает именно байты настоящего индекса, не только видимый Git diff.
 * Он позволяет доказать отсутствие скрытой записи при stale, отказе и чужом lock.
 */
export async function indexBytes(root) {
  const location = (await git(root, ['rev-parse', '--git-path', 'index'])).trim();

  try {
    return await readFile(path.resolve(root, location));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

/**
 * Проверяет маршрут до декодирования: отсутствие новой возможности даёт осмысленный RED.
 * Ошибка фикстуры или JSON никогда не подменяет требуемый ответ публичного API.
 */
export function success(response, label) {
  assert.equal(response.statusCode, 200, `${label}: ${response.body}`);

  return response.json();
}

/**
 * Реальный merge создаёт UU, AA либо modify/delete, а не искусственный статус U.
 * Содержимое каждой стадии впоследствии сверяется непосредственно через git show.
 */
export async function mergeConflict(fixture, kind = 'UU') {
  const { root, write } = fixture;

  await git(root, ['checkout', '-qb', 'incoming']);

  if (kind === 'AA') {
    await write('conflict.txt', 'incoming\n');
    await git(root, ['add', 'conflict.txt']);
  } else if (kind === 'UD') {
    await git(root, ['rm', 'app.txt']);
  } else {
    await write('app.txt', 'incoming\n');
  }

  await git(root, ['commit', '-qam', 'Входящая']);
  await git(root, ['checkout', '-q', 'main']);
  await write(kind === 'AA' ? 'conflict.txt' : 'app.txt', 'ours\n');
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-qm', 'Наша']);
  await assert.rejects(git(root, ['merge', '--no-edit', 'incoming']), { code: 1 });

  return kind === 'AA' ? 'conflict.txt' : 'app.txt';
}
