// Панель «Код» показывает изменения ДВУМЯ группами, как Source Control в VS Code:
// индекс против HEAD и рабочее дерево против индекса.
//
// Одного «diff HEAD» человеку мало, и это воспроизводимо: файл, проиндексированный и
// затем возвращённый в рабочем дереве к состоянию HEAD, из такого дифа исчезает целиком,
// хотя его изменение уедет в ближайший коммит. Частично проиндексированный файл при этом
// выглядит одной записью, и что попадёт в коммит, а что останется — не видно.
//
// Приёмка задач (`taskDiff`) намеренно осталась одной величиной «что сделано поверх HEAD»:
// фабрика индекс не трогает, и делить ей нечего.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import codeModule from '../../server/src/modules/code/index.ts';
import { taskDiff, unquotePath, worktreeChanges } from '../../server/src/lib/git.ts';

const exec = promisify(execFile);
const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

const git = (cwd, args) => exec('git', ['-C', cwd, ...args]);

/** Репозиторий со всеми интересными состояниями индекса разом. */
async function repo(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-git-staged-'));
  const write = (rel, text) => writeFile(path.join(root, rel), text);

  await git(root, ['init', '-q', '-b', 'main', '.']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await git(root, ['config', 'user.name', 'test']);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await write('src/partial.js', 'base\n');
  await write('src/reverted.js', 'head\n');
  // Длинный файл намеренно: git считает переименованием только достаточно похожий,
  // иначе разложит его на пару «удалён/добавлен» и проверять будет нечего.
  await write('src/renamed-from.js', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n');
  await write('src/dropped.js', 'bye\n');
  await write('README.md', 'doc\n');
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-qm', 'init']);

  // 1. Часть правок проиндексирована, часть дописана уже поверх индекса.
  await write('src/partial.js', 'base\nstaged\n');
  await git(root, ['add', 'src/partial.js']);
  await write('src/partial.js', 'base\nstaged\nwork\n');
  // 2. Изменение уехало в индекс, а рабочее дерево вернули к HEAD.
  await write('src/reverted.js', 'indexed\n');
  await git(root, ['add', 'src/reverted.js']);
  await write('src/reverted.js', 'head\n');
  // 3. Новый файл в индексе и совсем новый файл мимо индекса.
  await write('src/added.js', 'fresh\n');
  await git(root, ['add', 'src/added.js']);
  await write('untracked.js', 'nobody knows\n');
  // 4. Удаление в индексе.
  await git(root, ['rm', '-q', 'src/dropped.js']);
  // 5. Переименование в индексе с правкой содержимого.
  await git(root, ['mv', 'src/renamed-from.js', 'src/renamed-to.js']);
  await write('src/renamed-to.js', 'one\ntwo\nthree\nfour\nfive\nsix\nmoved\n');
  await git(root, ['add', 'src/renamed-to.js']);
  // 6. Правка мимо индекса — только рабочее дерево.
  await write('README.md', 'doc\nmore\n');

  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, write };
}

const byPath = (files) => new Map(files.map((f) => [f.path, f]));

test('CODE-GIT-01: индекс и рабочее дерево — разные группы с разными сторонами дифа', async (t) => {
  const { root } = await repo(t);
  const changes = await worktreeChanges(root);

  const staged = byPath(changes.staged);
  const work = byPath(changes.files);

  // Частично проиндексированный файл законно виден в ОБЕИХ группах, и стороны разные:
  // в индексе HEAD→индекс, в рабочем дереве индекс→рабочее дерево.
  assert.equal(staged.get('src/partial.js').oldContent, 'base\n');
  assert.equal(staged.get('src/partial.js').newContent, 'base\nstaged\n');
  assert.equal(work.get('src/partial.js').oldContent, 'base\nstaged\n');
  assert.equal(work.get('src/partial.js').newContent, 'base\nstaged\nwork\n');

  // Группа проставлена сервером: клиенту не нужно догадываться по спискам.
  assert.equal(staged.get('src/partial.js').group, 'staged');
  assert.equal(work.get('src/partial.js').group, 'work');

  // Правка мимо индекса в индексной группе не появляется, и наоборот.
  assert.equal(staged.has('README.md'), false);
  assert.equal(work.get('README.md').status, 'M');
  assert.equal(work.has('src/added.js'), false);

  assert.equal(changes.branch, 'main');
});

test('CODE-GIT-02: проиндексированное изменение видно, даже когда рабочее дерево вернули к HEAD', async (t) => {
  const { root } = await repo(t);
  const changes = await worktreeChanges(root);

  // Именно этот файл раньше исчезал из панели целиком: `git diff HEAD` его не видит,
  // а в коммит его изменение уедет.
  const staged = byPath(changes.staged).get('src/reverted.js');
  assert.equal(staged.status, 'M');
  assert.equal(staged.oldContent, 'head\n');
  assert.equal(staged.newContent, 'indexed\n');

  // В рабочем дереве он тоже изменён — обратной правкой относительно индекса.
  const work = byPath(changes.files).get('src/reverted.js');
  assert.equal(work.oldContent, 'indexed\n');
  assert.equal(work.newContent, 'head\n');

  // Старое «одно число поверх HEAD» его действительно не показывает.
  const acceptance = byPath((await taskDiff(root)).files);
  assert.equal(acceptance.has('src/reverted.js'), false);
});

test('CODE-GIT-03: новые и удалённые файлы попадают в свою группу с пустой стороной', async (t) => {
  const { root } = await repo(t);
  const changes = await worktreeChanges(root);
  const staged = byPath(changes.staged);
  const work = byPath(changes.files);

  assert.equal(staged.get('src/added.js').status, 'A');
  assert.equal(staged.get('src/added.js').oldContent, '');
  assert.equal(staged.get('src/added.js').newContent, 'fresh\n');

  assert.equal(staged.get('src/dropped.js').status, 'D');
  assert.equal(staged.get('src/dropped.js').oldContent, 'bye\n');
  assert.equal(staged.get('src/dropped.js').newContent, '');

  // Неотслеживаемый файл: в индексе его нет по определению, поэтому «до» пусто.
  assert.equal(work.get('untracked.js').status, 'A');
  assert.equal(work.get('untracked.js').oldContent, '');
  assert.equal(work.get('untracked.js').newContent, 'nobody knows\n');
  assert.equal(staged.has('untracked.js'), false);
});

test('CODE-GIT-04: переименование берёт «до» по старому пути и считает строки', async (t) => {
  const { root } = await repo(t);
  const staged = byPath((await worktreeChanges(root)).staged).get('src/renamed-to.js');

  assert.equal(staged.status, 'R');
  assert.equal(staged.oldPath, 'src/renamed-from.js');
  assert.equal(staged.oldContent, 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n');
  assert.equal(staged.newContent, 'one\ntwo\nthree\nfour\nfive\nsix\nmoved\n');
  // numstat пишет переименование одной строкой «old => new»; без её раскрытия
  // счётчики не находили файл по настоящему пути и показывали 0/0.
  assert.equal(staged.add, 1);
  assert.equal(staged.del, 1);
});

test('CODE-GIT-05: не-ASCII путь приезжает читаемым и с содержимым', async (t) => {
  const { root, write } = await repo(t);
  await write('заметка.md', 'первая строка\n');
  await git(root, ['add', 'заметка.md']);
  await git(root, ['commit', '-qm', 'note']);
  await write('заметка.md', 'первая строка\nвторая\n');

  const work = byPath((await worktreeChanges(root)).files).get('заметка.md');
  // С дефолтным core.quotePath=true git отдал бы «"\320\267\320\260..."», и такой
  // файл не открылся бы ни по имени, ни через git show — диф выходил пустым.
  assert.ok(work, 'файл с кириллическим именем не найден в изменениях');
  assert.equal(work.oldContent, 'первая строка\n');
  assert.equal(work.newContent, 'первая строка\nвторая\n');

  assert.equal(unquotePath('"с пробелом.md"'), 'с пробелом.md');
  assert.equal(unquotePath('"\\321\\204.txt"'), 'ф.txt');
  assert.equal(unquotePath('обычный.md'), 'обычный.md');
});

test('CODE-GIT-06: роут /api/code/:project/git отдаёт обе группы', async (t) => {
  const { root } = await repo(t);
  const app = Fastify({ logger: false });
  app.decorate('pluginEnabled', () => true);
  app.register(codeModule, {
    config: {
      profilesDir: path.join(root, 'no-profiles'),
      chatsDir: path.join(root, 'chats'),
      telegramDir: path.join(root, 'telegram'),
      githubDir: path.join(root, 'github'),
    },
    prefs: { read: () => ({ projects: { demo: { repos: [{ key: 'main', dir: root }] } } }) },
  });
  await app.ready();
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/api/code/demo/git?repo=main' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.staged.some((f) => f.path === 'src/added.js'), 'индексная группа не доехала');
  assert.ok(body.files.some((f) => f.path === 'untracked.js'), 'рабочее дерево не доехало');
  assert.ok(Array.isArray(body.log), 'коммиты не доехали');
});

test('CODE-GIT-07: приёмка задачи по-прежнему одна величина «поверх HEAD»', async (t) => {
  const { root } = await repo(t);
  const diff = await taskDiff(root);

  // Никаких групп: контракт /api/tasks/:id/diff не менялся.
  assert.equal(diff.staged, undefined);
  const files = byPath(diff.files);
  // Проиндексированное входит сюда наравне с рабочим деревом — это и есть «поверх HEAD».
  assert.equal(files.get('src/partial.js').oldContent, 'base\n');
  assert.equal(files.get('src/partial.js').newContent, 'base\nstaged\nwork\n');
  assert.equal(files.get('src/added.js').status, 'A');
  assert.equal(files.get('untracked.js').status, 'A');
});

test('CODE-GIT-08: неотслеживаемый файл считает строки сам, а бинарный так и помечен', async (t) => {
  const { root, write } = await repo(t);
  // Без завершающего перевода строки: git считает незавершённый хвост отдельной строкой.
  await write('fresh.txt', 'one\ntwo\nthree');
  await write('blob.bin', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a]));

  const work = byPath((await worktreeChanges(root)).files);
  // Раньше у неотслеживаемого файла было «+0»: в diff его нет, и numstat о нём молчит.
  assert.deepEqual([work.get('untracked.js').add, work.get('untracked.js').del], [1, 0]);
  assert.deepEqual([work.get('fresh.txt').add, work.get('fresh.txt').del], [3, 0]);
  assert.equal(work.get('blob.bin').binary, true);
  assert.equal(work.get('blob.bin').add, 0);
  assert.equal(work.get('blob.bin').newContent, '');

  // Приёмка задачи видит те же числа: новый файл там тоже не «+0».
  const acceptance = byPath((await taskDiff(root)).files);
  assert.equal(acceptance.get('fresh.txt').add, 3);
  assert.equal(acceptance.get('blob.bin').binary, true);
});
