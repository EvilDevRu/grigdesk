// Выбор строки должен менять только выбранные файлы, даже если их имена похожи
// на Git pathspec. Все операции выполняются в отдельных временных репозиториях.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  stageWorktreeChanges,
  unstageWorktreeChanges,
  worktreeChanges,
} from '../../server/src/lib/git.ts';

const exec = promisify(execFile);
const git = (cwd, args) => exec('git', ['-C', cwd, '--literal-pathspecs', ...args]);
const magicPath = ':(glob)*.txt';
const otherPath = 'outside.txt';

/**
 * Фикстура создаёт репозиторий с HEAD либо без первого коммита. Это проверяет
 * обе команды снятия с индекса: restore и rm --cached.
 */
async function repository(t, withHead) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-code-literal-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await git(root, ['init', '-q', '-b', 'main', '.']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await git(root, ['config', 'user.name', 'test']);

  if (withHead) {
    await writeFile(path.join(root, 'base.md'), 'base\n');
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-qm', 'init']);
  }

  return root;
}

for (const withHead of [true, false]) {
  const state = withHead ? 'с HEAD' : 'до первого коммита';

  test(`CODE-PATHS: stage/unstage ${state} сохраняет соседний файл при pathspec-имени`, async (t) => {
    const root = await repository(t, withHead);
    await writeFile(path.join(root, magicPath), 'selected\n');
    await writeFile(path.join(root, otherPath), 'outside\n');

    const stage = await stageWorktreeChanges(root, { paths: [magicPath] });
    assert.deepEqual(stage, { ok: true, changed: 1 });

    let changes = await worktreeChanges(root);
    assert.deepEqual(changes.staged.map((file) => file.path), [magicPath]);
    assert.deepEqual(changes.files.map((file) => file.path), [otherPath]);

    await stageWorktreeChanges(root, { all: true });
    const unstage = await unstageWorktreeChanges(root, { paths: [magicPath] });
    assert.deepEqual(unstage, { ok: true, changed: 1 });

    changes = await worktreeChanges(root);
    assert.deepEqual(changes.staged.map((file) => file.path), [otherPath]);
    assert.deepEqual(changes.files.map((file) => file.path), [magicPath]);
    assert.equal(await readFile(path.join(root, magicPath), 'utf8'), 'selected\n');
    assert.equal(await readFile(path.join(root, otherPath), 'utf8'), 'outside\n');
  });
}

test('CODE-PATHS: старый путь переименования тоже передаётся Git буквально', async (t) => {
  const root = await repository(t, true);
  await writeFile(path.join(root, magicPath), 'renamed content\n');
  await writeFile(path.join(root, otherPath), 'outside base\n');
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-qm', 'tracked files']);

  await git(root, ['mv', magicPath, 'renamed.txt']);
  await writeFile(path.join(root, otherPath), 'outside changed\n');
  await git(root, ['add', otherPath]);

  const before = await worktreeChanges(root);
  assert.equal(before.staged.find((file) => file.path === 'renamed.txt')?.oldPath, magicPath);

  const result = await unstageWorktreeChanges(root, { paths: ['renamed.txt'] });
  assert.deepEqual(result, { ok: true, changed: 1 });

  const after = await worktreeChanges(root);
  assert.deepEqual(after.staged.map((file) => file.path), [otherPath]);
  assert.equal(await readFile(path.join(root, 'renamed.txt'), 'utf8'), 'renamed content\n');
  assert.equal(after.staged[0].newContent, 'outside changed\n');
});
