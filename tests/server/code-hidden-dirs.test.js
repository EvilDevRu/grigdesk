// Плагин «Код» отдаёт по HTTP любой файл под деревом репозитория — а служебные
// каталоги кокпита лежат ВНУТРИ его собственного дерева и гитигнорятся, поэтому
// в дифе их не видно, а в `ls`/`file` было видно целиком: chats/ — вся переписка
// с агентами, telegram/ и github/ — архивы каналов, server/.state — креды B24, cli-token
// и хеш пароля входа. Закрыты оба роута, куда путь приходит от клиента.
//
// Роут `git` в проверку не входит намеренно: он пути не принимает (`git diff HEAD`
// + `git status --porcelain`), а гитигнорённое туда не попадает.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import codeModule, { isHiddenPath } from '../../server/src/modules/code/index.ts';

const exec = promisify(execFile);
const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

/** Файлы репозитория: путь относительно корня → содержимое. */
async function writeTree(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, text);
  }
}

/**
 * Два репозитория проекта: `main` — сам кокпит (его chats/, telegram/ и github/ названы
 * в config), `other` — чужой код, где каталог с тем же именем ничей и прятать его
 * не за что.
 */
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cockpit-code-hidden-')));
  const main = path.join(root, 'cockpit');
  const other = path.join(root, 'other');

  await writeTree(main, {
    'src/app.js': 'export const ok = 1;\n',
    'chats/2026-08/abc.json': '{"messages":["секрет переписки"]}',
    'telegram/archive/-1001/2026-08.ndjson': '{"text":"секрет чата"}\n',
    'github/accounts/acc_1/archive/issues.ndjson': '{"title":"секрет issue"}\n',
    'server/.state/b24-creds.json': '{"password":"секрет"}',
    'server/src/app.js': 'export default 1;\n',
  });
  await writeTree(other, {
    'chats/room.md': 'чужой каталог с тем же именем',
    '.state/private.json': '{"token":"секрет"}',
  });
  for (const dir of [main, other]) await exec('git', ['-C', dir, 'init', '-q', '.']);

  const config = {
    profilesDir: path.join(root, 'profiles'), // не существует → проект кокпитный
    chatsDir: path.join(main, 'chats'),
    telegramDir: path.join(main, 'telegram'),
    githubDir: path.join(main, 'github'),
  };
  const prefs = {
    read: () => ({ projects: { demo: { repos: [{ key: 'main', dir: main }, { key: 'other', dir: other }] } } }),
  };

  const app = Fastify({ logger: false });
  app.decorate('pluginEnabled', () => true);
  app.register(codeModule, { config, prefs });
  await app.ready();
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  const ls = (dir, repo = 'main') => app.inject({
    method: 'GET',
    url: `/api/code/demo/ls?repo=${repo}${dir ? `&dir=${encodeURIComponent(dir)}` : ''}`,
  });
  const file = (p, repo = 'main') => app.inject({
    method: 'GET',
    url: `/api/code/demo/file?repo=${repo}&path=${encodeURIComponent(p)}`,
  });
  return { app, config, main, other, ls, file };
}

const names = (res) => res.json().entries.map((e) => e.name);

test('ls не показывает служебные каталоги кокпита и внутренности гита', async (t) => {
  const { ls } = await fixture(t);

  const top = await ls('');
  assert.equal(top.statusCode, 200);
  assert.deepEqual(names(top).sort(), ['server', 'src']);

  // `.state` закрыт на любой глубине, а не только в корне.
  const server = await ls('server');
  assert.equal(server.statusCode, 200);
  assert.deepEqual(names(server), ['src']);
});

test('ls самого закрытого каталога — 404, а не листинг', async (t) => {
  const { ls } = await fixture(t);
  for (const dir of ['chats', 'chats/2026-08', 'telegram', 'github', 'server/.state', '.git']) {
    const res = await ls(dir);
    assert.equal(res.statusCode, 404, dir);
    assert.equal(res.json().error, 'no_dir', dir);
  }
});

test('file не отдаёт файлы закрытых каталогов', async (t) => {
  const { file } = await fixture(t);
  for (const p of [
    'chats/2026-08/abc.json',
    'telegram/archive/-1001/2026-08.ndjson',
    'github/accounts/acc_1/archive/issues.ndjson',
    'server/.state/b24-creds.json',
    '.git/config',
  ]) {
    const res = await file(p);
    assert.equal(res.statusCode, 404, p);
    assert.equal(res.json().error, 'no_file', p);
  }
});

test('обычные файлы читаются как раньше', async (t) => {
  const { file } = await fixture(t);
  const res = await file('src/app.js');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().content, 'export const ok = 1;\n');
});

test('в чужом репозитории каталог с тем же именем не прячется, а .state прячется', async (t) => {
  const { ls, file } = await fixture(t);

  // chats/ закрыт по ФАКТИЧЕСКОМУ пути из config, поэтому одноимённый каталог
  // чужого проекта остаётся видимым: иначе плагин молча скрывал бы чужой код.
  const top = await ls('', 'other');
  assert.equal(top.statusCode, 200);
  assert.deepEqual(names(top), ['chats']);
  const own = await file('chats/room.md', 'other');
  assert.equal(own.statusCode, 200);
  assert.equal(own.json().content, 'чужой каталог с тем же именем');

  // `.state` — конвенция «секреты и рантайм» (гитигнор `**/.state/`), закрыта везде.
  const secret = await file('.state/private.json', 'other');
  assert.equal(secret.statusCode, 404);
});

test('isHiddenPath: сегмент в любом месте дерева, каталог — по точному пути', async () => {
  const dirs = ['/srv/cockpit/chats', '/srv/cockpit/telegram', '/srv/cockpit/github'];
  assert.equal(isHiddenPath('/srv/cockpit/chats', dirs), true);
  assert.equal(isHiddenPath('/srv/cockpit/chats/2026-08/x.json', dirs), true);
  assert.equal(isHiddenPath('/srv/cockpit/github/accounts/acc_1/issues.ndjson', dirs), true);
  assert.equal(isHiddenPath('/srv/cockpit/server/.state/creds.json', dirs), true);
  assert.equal(isHiddenPath('/srv/other/.git/config', dirs), true);
  assert.equal(isHiddenPath('/srv/cockpit/src/app.js', dirs), false);
  // Префикс имени — не вложенность: chats-backup рядом с chats остаётся видимым.
  assert.equal(isHiddenPath('/srv/cockpit/chats-backup/x.json', dirs), false);
  assert.equal(isHiddenPath('/srv/cockpit/src/.stateful/x.js', dirs), false);
});
