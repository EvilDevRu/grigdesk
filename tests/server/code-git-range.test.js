import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { parseCodeBlame, parseCodeCommitsDiff } from '../../shared/codeContracts.ts';
import codeModule from '../../server/src/modules/code/index.ts';
import {
  branchDiff,
  blameFile,
  commitRangeDiff,
  fileLog,
  fileDiffSides,
} from '../../server/src/lib/git.ts';

const exec = promisify(execFile);
const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const git = (cwd, args) => exec('git', ['-C', cwd, ...args]);

/** Создаёт линейную историю с корнем, промежуточным файлом и переименованием. */
async function rangeRepo(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-code-range-'));
  const write = (rel, content) => writeFile(path.join(root, rel), content);

  await git(root, ['init', '-q', '-b', 'main', '.']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await git(root, ['config', 'user.name', 'test']);
  await write('root.txt', 'root\n');
  await write('rename-from.txt', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n');
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-qm', 'root']);
  const first = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();

  await write('middle.txt', 'middle\n');
  await write('root.txt', 'root\nsecond\n');
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-qm', 'middle']);
  const middle = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();

  await git(root, ['mv', 'rename-from.txt', 'rename-to.txt']);
  await write('rename-to.txt', 'one\ntwo\nthree\nfour\nfive\nsix\nchanged\n');
  await write('binary.bin', Buffer.from([1, 0, 2, 3]));
  await git(root, ['rm', '-q', 'middle.txt']);
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-qm', 'tip subject', '-m', 'tip body']);
  const tip = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();

  t.after(() => rm(root, { recursive: true, force: true }));

  return { root, first, middle, tip };
}

/** Поднимает code-модуль на одном временном репозитории. */
async function codeApp(t, root, enabled = true, options = {}) {
  const app = Fastify({ logger: false });

  app.decorate('pluginEnabled', () => enabled);
  app.register(codeModule, {
    config: { profilesDir: path.join(root, 'profiles') },
    prefs: { read: () => ({ projects: { demo: { repos: [{ key: 'main', dir: root }] } } }) },
    ...options,
  });
  await app.ready();
  t.after(() => app.close());

  return app;
}

/** Создаёт основное дерево и вторую рабочую копию на ветке задачи. */
async function branchRepo(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'cockpit-code-branch-'));
  const root = path.join(parent, 'main');
  const task = path.join(parent, 'task');

  await git(parent, ['init', '-q', '-b', 'main', root]);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await git(root, ['config', 'user.name', 'test']);
  await writeFile(path.join(root, 'base.txt'), 'base\n');
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-qm', 'base']);
  await git(root, ['worktree', 'add', '-q', '-b', 'task-1234', task, 'main']);
  t.after(() => rm(parent, { recursive: true, force: true }));

  return { root, task };
}

test('CODE-RANGE-01/02: один и три коммита дают точный общий список без содержимого', async (t) => {
  const { root, first, middle, tip } = await rangeRepo(t);
  const one = await commitRangeDiff(root, middle, middle);
  const all = await commitRangeDiff(root, first, tip);

  assert.equal(one.range.commits, 1);
  assert.equal(one.range.from, middle);
  assert.equal(one.range.to, middle);
  assert.ok(one.files.some((file) => file.path === 'middle.txt'));
  assert.ok(one.files.every((file) => !('oldContent' in file) && !('newContent' in file)));
  assert.equal(all.range.commits, 3);
  assert.ok(all.stat);
  assert.ok(all.files.some((file) => file.path === 'root.txt'));
  assert.ok(all.files.some((file) => file.path === 'binary.bin'));
});

test('CODE-RANGE-03: корневой коммит сравнивается с пустым деревом', async (t) => {
  const { root, first } = await rangeRepo(t);
  const diff = await commitRangeDiff(root, first, first);

  assert.equal(diff.range.commits, 1);
  assert.ok(diff.files.length >= 2);
  assert.ok(diff.files.every((file) => file.status === 'A'));
  assert.notEqual(diff.range.base, first);
});

test('CODE-RANGE-04/05: переименование, удаление и бинарные стороны читаются отдельно', async (t) => {
  const { root, middle, tip } = await rangeRepo(t);
  const diff = await commitRangeDiff(root, tip, tip);
  const renamed = diff.files.find((file) => file.path === 'rename-to.txt');
  const deleted = diff.files.find((file) => file.path === 'middle.txt');
  const binary = diff.files.find((file) => file.path === 'binary.bin');

  assert.equal(renamed?.status, 'R');
  assert.equal(renamed?.oldPath, 'rename-from.txt');
  assert.equal(deleted?.status, 'D');
  assert.equal(binary?.binary, true);

  const renameSides = await fileDiffSides(root, {
    group: 'commits',
    path: 'rename-to.txt',
    base: diff.range.base,
    to: diff.range.to,
  });
  const deleteSides = await fileDiffSides(root, {
    group: 'commits',
    path: 'middle.txt',
    base: diff.range.base,
    to: diff.range.to,
  });

  assert.match(renameSides.oldContent, /seven/);
  assert.match(renameSides.newContent, /changed/);
  assert.equal(deleteSides.oldContent, 'middle\n');
  assert.equal(deleteSides.newContent, '');
  assert.equal((await commitRangeDiff(root, middle, tip)).range.commits, 2);
});

test('CODE-RANGE-06: форма, отсутствие и обратный порядок имеют разные коды', async (t) => {
  const { root, first, tip } = await rangeRepo(t);

  await assert.rejects(commitRangeDiff(root, 'zz', tip), (error) => error?.code === 'bad_commit');
  await assert.rejects(
    commitRangeDiff(root, 'f'.repeat(40), tip),
    (error) => error?.code === 'no_commit' && error?.status === 404,
  );
  await assert.rejects(
    commitRangeDiff(root, tip, first),
    (error) => error?.code === 'bad_range' && error?.status === 400,
  );
});

test('CODE-RANGE-07/08: HTTP-контракт, журнал 50 и headMessage', async (t) => {
  const { root, first, tip } = await rangeRepo(t);

  for (let index = 0; index < 20; index += 1) {
    await writeFile(path.join(root, 'counter.txt'), `${index}\n`);
    await git(root, ['add', 'counter.txt']);
    await git(root, ['commit', '-qm', `counter ${index}`]);
  }

  const app = await codeApp(t, root);
  const range = await app.inject({
    method: 'GET',
    url: `/api/code/demo/commits-diff?repo=main&from=${first}&to=${tip}`,
  });
  const snapshot = await app.inject({ method: 'GET', url: '/api/code/demo/git?repo=main' });

  assert.equal(range.statusCode, 200);
  assert.doesNotThrow(() => parseCodeCommitsDiff(range.json()));
  assert.ok(snapshot.json().log.length > 15);
  assert.equal(snapshot.json().headMessage, 'counter 19');

  const disabled = await codeApp(t, root, false);
  const denied = await disabled.inject({
    method: 'GET',
    url: `/api/code/demo/commits-diff?repo=main&from=${first}&to=${tip}`,
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error, 'plugin_disabled');
});

test('CODE-BRANCH-01: ветка worktree показывает все коммиты поверх основной', async (t) => {
  const { root, task } = await branchRepo(t);

  await writeFile(path.join(task, 'first.txt'), 'first\n');
  await git(task, ['add', '-A']);
  await git(task, ['commit', '-qm', 'first']);
  await writeFile(path.join(task, 'second.txt'), 'second\n');
  await git(task, ['add', '-A']);
  await git(task, ['commit', '-qm', 'second']);

  const diff = await branchDiff(task, { main: false, mainBranch: 'main' });

  assert.equal(diff.range.commits, 2);
  assert.ok(diff.range.from);
  assert.ok(diff.files.some((file) => file.path === 'first.txt'));
  assert.ok(diff.files.some((file) => file.path === 'second.txt'));

  const app = await codeApp(t, root);
  const response = await app.inject({
    method: 'GET',
    url: `/api/code/demo/branch-diff?repo=main&root=${encodeURIComponent(task)}`,
  });

  assert.equal(response.statusCode, 200);
  assert.doesNotThrow(() => parseCodeCommitsDiff(response.json()));
  assert.equal(response.json().range.commits, 2);
});

test('CODE-BRANCH-02: основное дерево без upstream честно не имеет базы', async (t) => {
  const { root } = await branchRepo(t);

  await assert.rejects(
    branchDiff(root, { main: true, mainBranch: 'main' }),
    (error) => error?.code === 'no_base' && error?.status === 409,
  );
});

test('CODE-BRANCH-03: ветка на самой базе даёт пустой diff', async (t) => {
  const { task } = await branchRepo(t);
  const diff = await branchDiff(task, { main: false, mainBranch: 'main' });

  assert.equal(diff.range.commits, 0);
  assert.equal(diff.range.from, '');
  assert.deepEqual(diff.files, []);
  assert.equal(diff.range.base, diff.range.to);
});

test('CODE-PATCH-01: work patch включает tracked и untracked как новый файл', async (t) => {
  const { root } = await rangeRepo(t);

  await writeFile(path.join(root, 'root.txt'), 'root\nchanged in worktree\n');
  await writeFile(path.join(root, 'untracked.txt'), 'brand new\n');
  const app = await codeApp(t, root);
  const response = await app.inject({
    method: 'GET',
    url: '/api/code/demo/patch?repo=main&group=work',
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.json().patch, /diff --git a\/root\.txt b\/root\.txt/);
  assert.match(response.json().patch, /new file mode[\s\S]*untracked\.txt/);
});

test('CODE-PATCH-02/03: patch отрезка содержит все файлы и ограничивается path', async (t) => {
  const { root, first, tip } = await rangeRepo(t);
  const range = await commitRangeDiff(root, first, tip);
  const app = await codeApp(t, root);
  const query = `repo=main&group=commits&base=${range.range.base}&to=${range.range.to}`;
  const all = await app.inject({ method: 'GET', url: `/api/code/demo/patch?${query}` });
  const one = await app.inject({
    method: 'GET',
    url: `/api/code/demo/patch?${query}&path=${encodeURIComponent('root.txt')}`,
  });

  assert.equal(all.statusCode, 200);
  assert.match(all.json().patch, /root\.txt/);
  assert.match(all.json().patch, /binary\.bin/);
  assert.equal(one.statusCode, 200);
  assert.match(one.json().patch, /root\.txt/);
  assert.doesNotMatch(one.json().patch, /binary\.bin|rename-to\.txt/);
});

test('CODE-PATCH-04: потолок обрезает patch и отмечает ответ', async (t) => {
  const { root } = await rangeRepo(t);

  await writeFile(path.join(root, 'root.txt'), `root\n${'long line\n'.repeat(30)}`);
  const app = await codeApp(t, root, true, { patchMaxBytes: 100 });
  const response = await app.inject({
    method: 'GET',
    url: '/api/code/demo/patch?repo=main&group=work',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().truncated, true);
  assert.ok(Buffer.byteLength(response.json().patch, 'utf8') <= 100);
});

test('CODE-FLOG-01: история файла идёт от нового коммита к корневому с базами', async (t) => {
  const { root } = await rangeRepo(t);

  await writeFile(path.join(root, 'root.txt'), 'root\nsecond\nthird\n');
  await git(root, ['add', 'root.txt']);
  await git(root, ['commit', '-qm', 'third root change']);
  const entries = (await fileLog(root, 'root.txt')).entries;

  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((entry) => entry.subject), [
    'third root change', 'middle', 'root',
  ]);
  assert.equal(entries[0].base,
    (await git(root, ['rev-parse', `${entries[0].hash}^`])).stdout.trim());
  assert.ok(entries.every((entry) => entry.path === 'root.txt'));
});

test('CODE-FLOG-02/03: --follow сохраняет старое имя и пустую базу корня', async (t) => {
  const { root } = await rangeRepo(t);
  const entries = (await fileLog(root, 'rename-to.txt')).entries;

  assert.equal(entries.length, 2);
  assert.equal(entries[0].path, 'rename-to.txt');
  assert.equal(entries[1].path, 'rename-from.txt');
  assert.notEqual(entries[0].base, '');
  assert.match(entries[1].base, /^[0-9a-f]{40}$/u);
  assert.notEqual(entries[1].base, entries[1].hash);
});

test('CODE-FLOG-04: неизвестный путь даёт пустую историю и HTTP-контракт', async (t) => {
  const { root } = await rangeRepo(t);

  assert.deepEqual(await fileLog(root, 'missing.txt'), { entries: [] });
  const app = await codeApp(t, root);
  const response = await app.inject({
    method: 'GET',
    url: '/api/code/demo/file-log?repo=main&path=rename-to.txt',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().entries[1].path, 'rename-from.txt');
});

test('CODE-BLAME-01: строки указывают на свои коммиты с автором и темой', async (t) => {
  const { root, first, middle } = await rangeRepo(t);
  const result = await blameFile(root, 'root.txt');

  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[0].line, 1);
  assert.equal(result.lines[0].hash, first);
  assert.equal(result.lines[0].author, 'test');
  assert.equal(result.lines[0].subject, 'root');
  assert.ok(result.lines[0].base);
  assert.equal(result.lines[1].hash, middle);
  assert.equal(result.lines[1].subject, 'middle');
  assert.ok(result.lines[1].when);

  const app = await codeApp(t, root);
  const response = await app.inject({
    method: 'GET',
    url: '/api/code/demo/blame?repo=main&path=root.txt',
  });

  assert.equal(response.statusCode, 200);
  assert.doesNotThrow(() => parseCodeBlame(response.json()));
});

test('CODE-BLAME-02: незакоммиченная строка не получает чужой коммит', async (t) => {
  const { root } = await rangeRepo(t);

  await writeFile(path.join(root, 'root.txt'), 'root changed locally\nsecond\n');
  const result = await blameFile(root, 'root.txt');

  assert.equal(result.lines[0].hash, '');
  assert.equal(result.lines[0].base, '');
  assert.equal(result.lines[1].subject, 'middle');
});

test('CODE-BLAME-03: неизвестный путь даёт 404', async (t) => {
  const { root } = await rangeRepo(t);

  await assert.rejects(
    blameFile(root, 'missing.txt'),
    (error) => error?.code === 'no_file' && error?.status === 404,
  );

  const app = await codeApp(t, root);
  const response = await app.inject({
    method: 'GET',
    url: '/api/code/demo/blame?repo=main&path=missing.txt',
  });

  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error, 'no_file');
});

// Боль владельца: «смотреть изменения нескольких коммитов как обычный диф» — то есть от
// базы отрезка до того, что сейчас на диске, включая несохранённые правки. Отрезок до
// последнего коммита эти правки терял, и +110 строк в файле «исчезали» из дифа.
test('CODE-WORK-01: отрезок до HEAD с флагом work сравнивает базу с рабочим деревом', async (t) => {
  const { root, middle, tip } = await rangeRepo(t);

  await writeFile(path.join(root, 'root.txt'), 'root\nsecond\nuncommitted\n');
  await writeFile(path.join(root, 'untracked.txt'), 'brand new\n');

  const committed = await commitRangeDiff(root, middle, tip);
  const withWork = await commitRangeDiff(root, middle, tip, { work: true });

  assert.equal(committed.range.work, false);
  assert.equal(withWork.range.work, true);
  assert.equal(withWork.range.commits, 2);
  assert.equal(withWork.range.base, committed.range.base);
  // root.txt менялся в коммите middle и снова в рабочем дереве: в общем дифе он один раз,
  // а несохранённая строка входит в счётчик.
  const rootEntry = withWork.files.find((file) => file.path === 'root.txt');

  assert.ok(rootEntry, 'root.txt должен быть в дифе с рабочим деревом');
  assert.equal(rootEntry.add, 2);
  assert.ok(withWork.files.some((file) => file.path === 'untracked.txt' && file.status === 'A'));
  assert.ok(!committed.files.some((file) => file.path === 'untracked.txt'));
});

test('CODE-WORK-02: флаг work требует, чтобы отрезок заканчивался на HEAD', async (t) => {
  const { root, first, middle } = await rangeRepo(t);

  await assert.rejects(
    commitRangeDiff(root, first, middle, { work: true }),
    (error) => error.code === 'work_needs_head' && error.status === 400,
  );
});

test('CODE-WORK-03: стороны файла и patch с флагом work читают правую сторону с диска', async (t) => {
  const { root, middle, tip } = await rangeRepo(t);

  await writeFile(path.join(root, 'root.txt'), 'root\nsecond\nuncommitted\n');
  await writeFile(path.join(root, 'untracked.txt'), 'brand new\n');
  const range = (await commitRangeDiff(root, middle, tip, { work: true })).range;
  const sides = await fileDiffSides(root, {
    group: 'commits',
    path: 'root.txt',
    base: range.base,
    work: true,
  });

  assert.equal(sides.oldContent, 'root\n');
  assert.equal(sides.newContent, 'root\nsecond\nuncommitted\n');

  const app = await codeApp(t, root);
  const patch = await app.inject({
    method: 'GET',
    url: `/api/code/demo/patch?repo=main&group=commits&base=${range.base}&work=1`,
  });

  assert.equal(patch.statusCode, 200);
  assert.match(patch.json().patch, /\+uncommitted/);
  assert.match(patch.json().patch, /new file mode[\s\S]*untracked\.txt/);

  const http = await app.inject({
    method: 'GET',
    url: `/api/code/demo/commits-diff?repo=main&from=${middle}&to=${tip}&work=1`,
  });

  assert.equal(http.statusCode, 200);
  assert.equal(parseCodeCommitsDiff(http.json()).range.work, true);

  const older = await app.inject({
    method: 'GET',
    url: `/api/code/demo/commits-diff?repo=main&from=${middle}&to=${middle}&work=1`,
  });

  assert.equal(older.statusCode, 400);
  assert.equal(older.json().error, 'work_needs_head');
});

test('CODE-WORK-04: «Вся ветка» с флагом work включает несохранённые правки', async (t) => {
  const { task } = await branchRepo(t);

  await writeFile(path.join(task, 'first.txt'), 'first\n');
  await git(task, ['add', '-A']);
  await git(task, ['commit', '-qm', 'first']);
  await writeFile(path.join(task, 'first.txt'), 'first\nmore\n');

  const committed = await branchDiff(task, { main: false, mainBranch: 'main' });
  const withWork = await branchDiff(task, { main: false, mainBranch: 'main' }, { work: true });

  assert.equal(committed.files.find((file) => file.path === 'first.txt').add, 1);
  assert.equal(withWork.files.find((file) => file.path === 'first.txt').add, 2);
  assert.equal(withWork.range.work, true);
  assert.equal(withWork.range.commits, 1);
});
