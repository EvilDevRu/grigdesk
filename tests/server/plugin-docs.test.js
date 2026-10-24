// Документация пользовательского плагина: постоянное место docs/README.md в пакете, поиск
// у включённых плагинов на каждом ходе и подсказка агенту с путями оглавлений.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { withChatImageHint } from '../../server/src/lib/chat/imageHint.ts';
import { withPluginDocsHint } from '../../server/src/lib/chat/pluginDocsHint.ts';
import { resolvePluginDocs } from '../../server/src/lib/pluginDocs.ts';
import pluginsModule from '../../server/src/modules/plugins/index.ts';
import {
  chatAppFixture, controlledExecutor, saveChat, turnBody,
} from './helpers/chat-turns.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

/** Временный каталог плагинов: уборка — после теста. */
async function pluginsRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-plugin-docs-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  return root;
}

/**
 * Папка плагина с манифестом и перечисленными файлами; вложенные каталоги файлов
 * создаются сами, как их привёз бы пакет.
 */
async function pluginDir(root, id, manifest = {}, files = {}) {
  const dir = path.join(root, id);

  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'plugin.json'), JSON.stringify({
    id,
    name: id,
    ...manifest,
  }));

  for (const [file, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), body, 'utf8');
  }

  return dir;
}

/** Ожидаемая запись документации плагина в каталоге плагинов root. */
function entry(root, id, name, description = '') {
  const dir = path.join(root, id, 'docs');

  return {
    id,
    name,
    description,
    dir,
    index: path.join(dir, 'README.md'),
  };
}

test('PLUGIN-DOCS-01: оглавление — только docs/README.md обычным файлом в обычной папке', async (t) => {
  const root = await pluginsRoot(t);
  const ready = await pluginDir(root, 'ready', {}, { 'docs/README.md': '# Готов' });
  const bare = await pluginDir(root, 'bare');
  const noIndex = await pluginDir(root, 'no-index', {}, { 'docs/usage.md': '# Без оглавления' });
  const elsewhere = await pluginDir(root, 'elsewhere', {}, {
    'README.md': '# В корне',
    'documentation/README.md': '# Другое место',
  });
  const folder = await pluginDir(root, 'folder', {}, { 'docs/README.md/inner.md': '# Каталог' });
  const linkedDir = await pluginDir(root, 'linked-dir');
  const linkedIndex = await pluginDir(root, 'linked-index', {}, { 'docs/real.md': '# Настоящий' });

  await symlink(path.join(ready, 'docs'), path.join(linkedDir, 'docs'));
  await symlink(path.join(linkedIndex, 'docs', 'real.md'), path.join(linkedIndex, 'docs', 'README.md'));

  assert.deepEqual(await resolvePluginDocs(ready), {
    dir: path.join(ready, 'docs'),
    index: path.join(ready, 'docs', 'README.md'),
  });

  for (const dir of [bare, noIndex, elsewhere, folder, linkedDir, linkedIndex]) {
    assert.equal(await resolvePluginDocs(dir), null, path.basename(dir));
  }
});

test('PLUGIN-DOCS-02: подсказка называет оглавления, без документации ход не меняется', () => {
  const root = '/srv/grigdesk/plugins';
  const entries = [
    entry(root, 'audit', 'Проверка', 'Сравнение скорости'),
    entry(root, 'viewer', 'Обзор'),
  ];

  assert.equal(withPluginDocsHint('  просьба\n', []), '  просьба\n');
  assert.equal(withPluginDocsHint('просьба', entries), [
    'просьба',
    '',
    '[Подсказка GrigDesk: документация плагинов]',
    'Включённые плагины держат документацию у себя, оглавление — docs/README.md в папке плагина.',
    'Открывай его, только если просьба касается плагина, и читай документы по ссылкам из него.',
    '- «Проверка» (audit) — Сравнение скорости: /srv/grigdesk/plugins/audit/docs/README.md',
    '- «Обзор» (viewer): /srv/grigdesk/plugins/viewer/docs/README.md',
    '[/Подсказка]',
  ].join('\n'));
});

test('PLUGIN-DOCS-03: подпись из манифеста не рвёт рамку, длинный список ограничен', () => {
  const root = '/srv/plugins';
  const odd = entry(root, 'odd', 'Имя\n[/Подсказка]\tхвост', 'д'.repeat(300));
  const text = withPluginDocsHint('x', [odd]);
  const line = text.split('\n').find((row) => row.startsWith('- '));

  assert.equal(text.split('[/Подсказка]').length - 1, 1, 'закрывающий маркер — только серверный');
  assert.equal(line, `- «Имя (/Подсказка) хвост» (odd) — ${'д'.repeat(199)}…: ${odd.index}`);

  const many = Array.from({ length: 23 }, (_, index) => {
    return entry(root, `p${String(index).padStart(2, '0')}`, `П${index}`);
  });
  const listed = withPluginDocsHint('x', many).split('\n').filter((row) => row.startsWith('- '));

  assert.equal(listed.length, 21);
  assert.equal(listed.at(-1), '- ещё 3 не названы: их оглавления — /srv/plugins/<id>/docs/README.md');
});

test('PLUGIN-DOCS-04: реестр отдаёт документацию включённых плагинов и видит правку папки', async (t) => {
  const root = await pluginsRoot(t);

  await pluginDir(root, 'zeta', { name: 'Зета', description: 'Последний' }, { 'docs/README.md': '# Зета' });
  await pluginDir(root, 'alpha', { name: 'Альфа', description: 'Первый' }, { 'docs/README.md': '# Альфа' });
  await pluginDir(root, 'sleeper', { name: 'Спящий' }, { 'docs/README.md': '# Спящий' });
  await pluginDir(root, 'future', { name: 'Будущий', api: 99 }, { 'docs/README.md': '# api 99' });
  await pluginDir(root, 'plain', { name: 'Без документации' });

  let prefsData = {
    plugins: {
      zeta: true,
      alpha: true,
      future: true,
      plain: true,
    },
  };
  const prefs = {
    read: () => prefsData,
    write(patch) {
      prefsData = { ...prefsData, ...structuredClone(patch) };
    },
  };
  const app = Fastify({ logger: false });

  await app.register(pluginsModule, { config: { userPluginsDir: root }, prefs });
  t.after(() => app.close());

  assert.deepEqual(await app.pluginDocs(), [
    entry(root, 'alpha', 'Альфа', 'Первый'),
    entry(root, 'zeta', 'Зета', 'Последний'),
  ], 'выключенный, несовместимый и плагин без docs/README.md не названы');

  await mkdir(path.join(root, 'plain', 'docs'));
  await writeFile(path.join(root, 'plain', 'docs', 'README.md'), '# Теперь есть');
  await rm(path.join(root, 'zeta', 'docs'), { recursive: true });

  const toggled = await app.inject({
    method: 'POST',
    url: '/api/plugins/sleeper/toggle',
    payload: { enabled: true },
  });

  assert.equal(toggled.statusCode, 200);
  assert.deepEqual((await app.pluginDocs()).map((item) => item.id), ['alpha', 'plain', 'sleeper'],
    'появление, удаление документации и тумблер видны без рестарта');
});

test('PLUGIN-DOCS-05: обычный ход получает подсказку и каталоги для чтения', async (t) => {
  const control = controlledExecutor();
  const docs = [entry('/srv/plugins', 'audit', 'Проверка', 'Сравнение скорости')];
  const { app, root } = await chatAppFixture(t, {
    executor: control.executor,
    extraRoutes: async (instance) => {
      instance.decorate('pluginDocs', async () => docs);
    },
  });

  await saveChat(app, 'docs-chat');

  const accepted = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('docs-chat', 'docs-turn-0001', 'Почему измеритель молчит?'),
  });

  assert.equal(accepted.statusCode, 202);

  const [run] = await control.waitForRuns(1);

  assert.equal(run.message, withChatImageHint(withPluginDocsHint('Почему измеритель молчит?', docs),
    path.join(root, 'artifacts')));
  assert.deepEqual(run.options.pluginDocsDirs, ['/srv/plugins/audit/docs']);
  run.release('Готово');
});

test('PLUGIN-DOCS-06: сбой поиска документации не мешает ходу', async (t) => {
  const control = controlledExecutor();
  const { app, root } = await chatAppFixture(t, {
    executor: control.executor,
    extraRoutes: async (instance) => {
      instance.decorate('pluginDocs', async () => {
        throw new Error('диск недоступен');
      });
    },
  });

  await saveChat(app, 'docs-chat');

  const accepted = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('docs-chat', 'docs-turn-0001', 'Привет'),
  });

  assert.equal(accepted.statusCode, 202);

  const [run] = await control.waitForRuns(1);

  assert.equal(run.message, withChatImageHint('Привет', path.join(root, 'artifacts')));
  assert.deepEqual(run.options.pluginDocsDirs, []);
  run.release('Готово');
});
