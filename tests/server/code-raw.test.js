// Плагин «Код» показывает картинки и объявляет карту деревьев для моста из чата.
//
// Раньше JSON-роут `file` был единственным путём к содержимому: любой файл с NUL-байтом
// в первых 8000 он помечал `binary` и отдавал пустоту, поэтому PNG в разделе «Код»
// выглядел как сломанный файл. Сырые байты отдаёт отдельный `raw` — с теми же
// проверками root/скрытых каталогов, но собственным потолком размера.
//
// `roots` — навигация, а не доступ: клиент по ней превращает файловую ссылку из ответа
// агента в открытие файла панелью, а читает всё равно обычными ls/file/raw.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import codeModule, { RAW_IMAGE_TYPES, RAW_MAX_BYTES } from '../../server/src/modules/code/index.ts';

const exec = promisify(execFile);
const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

// Минимальный валидный PNG 1×1 — важны сигнатура и то, что внутри есть NUL-байты:
// именно из-за них JSON-роут считает файл бинарным.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function fixture(t, { enabled = true } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'grigdesk-code-raw-')));
  const main = path.join(root, 'grigdesk');
  const wt = path.join(root, 'grigdesk-worktree');

  await mkdir(path.join(main, 'web/public'), { recursive: true });
  await mkdir(path.join(main, 'chats'), { recursive: true });
  await writeFile(path.join(main, 'web/public/icon-192.png'), PNG);
  await writeFile(path.join(main, 'web/public/logo.svg'), '<svg onload="alert(1)"></svg>');
  await writeFile(path.join(main, 'web/public/huge.png'), Buffer.alloc(RAW_MAX_BYTES + 1, 7));
  await writeFile(path.join(main, 'src.js'), 'export const ok = 1;\n');
  await writeFile(path.join(main, 'chats/avatar.png'), PNG);

  await exec('git', ['-C', main, 'init', '-q', '-b', 'main', '.']);
  await exec('git', ['-C', main, 'config', 'user.email', 'test@example.com']);
  await exec('git', ['-C', main, 'config', 'user.name', 'test']);
  await exec('git', ['-C', main, 'add', '-A']);
  await exec('git', ['-C', main, 'commit', '-qm', 'init']);
  await exec('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'task-1234', wt]);

  const config = {
    profilesDir: path.join(root, 'profiles'), // не существует → проект GrigDesk
    chatsDir: path.join(main, 'chats'),
    telegramDir: path.join(main, 'telegram'),
    githubDir: path.join(main, 'github'),
  };
  const prefs = {
    read: () => ({ projects: { demo: { repos: [{ key: 'main', dir: main }] } } }),
  };

  const app = Fastify({ logger: false });
  app.decorate('pluginEnabled', () => enabled);
  app.register(codeModule, { config, prefs });
  await app.ready();
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  const raw = (p, query = '') => app.inject({
    method: 'GET',
    url: `/api/code/demo/raw?repo=main&path=${encodeURIComponent(p)}${query}`,
  });
  return { app, main, wt, raw };
}

test('CODE-RAW-01: картинка отдаётся байтами с точным типом и без кэша', async (t) => {
  const { raw, main } = await fixture(t);
  const res = await raw('web/public/icon-192.png');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.equal(res.headers['cache-control'], 'private, no-store');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(res.rawPayload, await readFile(path.join(main, 'web/public/icon-192.png')));
});

test('CODE-RAW-02: не-картинка и SVG отвергаются, а не отдаются как есть', async (t) => {
  const { raw } = await fixture(t);
  // SVG умеет исполнять скрипты в контексте страницы — тот же запрет, что у документов.
  const svg = await raw('web/public/logo.svg');
  assert.equal(svg.statusCode, 415);
  assert.equal(svg.json().error, 'not_image');

  const js = await raw('src.js');
  assert.equal(js.statusCode, 415);
  assert.equal(js.json().error, 'not_image');
});

test('CODE-RAW-03: потолок размера и выход за корень закрыты', async (t) => {
  const { raw } = await fixture(t);
  const big = await raw('web/public/huge.png');
  assert.equal(big.statusCode, 413);
  assert.equal(big.json().error, 'too_big');

  const outside = await raw('../../etc/passwd.png');
  assert.equal(outside.statusCode, 400);
  assert.equal(outside.json().error, 'bad_path');
});

test('CODE-RAW-04: скрытые каталоги закрыты и для сырых байтов', async (t) => {
  const { raw } = await fixture(t);
  // chats/ гитигнорится и в дифе не виден — через raw он тоже не должен читаться.
  const res = await raw('chats/avatar.png');
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'no_file');
});

test('CODE-RAW-05: выключенный плагин закрывает raw и roots', async (t) => {
  const { app, raw } = await fixture(t, { enabled: false });
  const res = await raw('web/public/icon-192.png');
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'plugin_disabled');

  const roots = await app.inject({ method: 'GET', url: '/api/code/roots' });
  assert.equal(roots.statusCode, 403);

  const stage = await app.inject({
    method: 'POST',
    url: '/api/code/demo/stage?repo=main',
    payload: { all: true },
  });
  assert.equal(stage.statusCode, 403);
  assert.equal(stage.json().error, 'plugin_disabled');
});

test('CODE-ROOTS-01: карта деревьев перечисляет и основное дерево, и worktree', async (t) => {
  const { app, main, wt } = await fixture(t);
  const res = await app.inject({ method: 'GET', url: '/api/code/roots' });
  assert.equal(res.statusCode, 200);
  const roots = res.json().roots;
  const byRoot = new Map(roots.map((item) => [item.root, item]));

  assert.deepEqual(byRoot.get(main), { project: 'demo', repo: 'main', root: main, main: true, branch: 'main' });
  // Именно worktree делает мост осмысленным: ссылка на файл задачи обязана открыть
  // её рабочую копию, а не одноимённый файл основного дерева.
  assert.deepEqual(byRoot.get(wt), { project: 'demo', repo: 'main', root: wt, main: false, branch: 'task-1234' });
});

test('CODE-RAW-06: список типов сервера совпадает с расширениями панели', async () => {
  // Разъехались бы молча: сервер отвечал бы 415 на файл, который панель уже показала
  // картинкой, — на экране остался бы пустой предпросмотр без объяснения.
  const panel = await readFile(new URL('../../web/src/views/code/CodePanel.vue', import.meta.url), 'utf8');
  const source = panel.match(/const IMAGE_EXT = \/\\\.\(\?:([^)]+)\)\$\/i;/)?.[1];
  assert.ok(source, 'в CodePanel.vue не найден IMAGE_EXT');

  // `jpe?g` в регулярке покрывает два расширения — разворачиваем в тот же список.
  const fromPanel = new Set(source.split('|').flatMap((item) => (
    item === 'jpe?g' ? ['jpg', 'jpeg'] : [item]
  )));
  assert.deepEqual([...fromPanel].sort(), [...RAW_IMAGE_TYPES.keys()].sort());
});
