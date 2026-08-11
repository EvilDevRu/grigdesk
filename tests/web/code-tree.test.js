import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCodeContexts,
  buildGitTree,
  codeContextId,
  encodeStoredCodeContext,
  flattenGitTree,
  gitDirectoryPaths,
  normalizeGitView,
  pickCodeContext,
  reconcileGitOpenDirs,
} from '../../web/src/shared/code-tree.js';

function tree(path, overrides = {}) {
  return {
    path,
    main: false,
    name: path.split('/').pop(),
    task: '',
    branch: 'feature/test',
    ...overrides,
  };
}

test('рабочие контексты объединяют репозиторий и worktree в стабильные понятные варианты', () => {
  const { contexts, unavailable } = buildCodeContexts([
    {
      key: 'engine',
      dir: '/srv/cockpit/engine',
      trees: [
        tree('/srv/cockpit/engine', { main: true, name: 'основной', branch: 'master' }),
        tree('/srv/worktrees/t46', { name: 't46', task: 't46', branch: 'task-46' }),
      ],
    },
    {
      key: 'web',
      dir: '/srv/cockpit/web',
      trees: [
        tree('/srv/worktrees/web-preview', { name: 'web-preview', branch: '(detached)' }),
        tree('/srv/worktrees/web-empty', { name: 'web-empty', branch: '' }),
      ],
    },
    { key: 'broken', dir: '/missing/repo', trees: [] },
  ]);

  assert.deepEqual(
    contexts.map(({ repoKey, treePath, label, branchLabel }) => ({
      repoKey, treePath, label, branchLabel,
    })),
    [
      {
        repoKey: 'engine',
        treePath: '/srv/cockpit/engine',
        label: 'engine · Основная · master',
        branchLabel: 'master',
      },
      {
        repoKey: 'engine',
        treePath: '/srv/worktrees/t46',
        label: 'engine · Задача t46 · task-46',
        branchLabel: 'task-46',
      },
      {
        repoKey: 'web',
        treePath: '/srv/worktrees/web-preview',
        label: 'web · Worktree web-preview · detached HEAD',
        branchLabel: 'detached HEAD',
      },
      {
        repoKey: 'web',
        treePath: '/srv/worktrees/web-empty',
        label: 'web · Worktree web-empty · ветка не определена',
        branchLabel: 'ветка не определена',
      },
    ],
  );
  assert.deepEqual(unavailable, [{ repoKey: 'broken', repoDir: '/missing/repo' }]);
  assert.equal(contexts[1].id, JSON.stringify(['engine', '/srv/worktrees/t46']));
  assert.equal(codeContextId('engine', '/srv/worktrees/t46'), contexts[1].id);

  assert.notEqual(
    codeContextId('repo:one', '/work:two'),
    codeContextId('repo', 'one:/work:two'),
  );
});

test('сохранённый контекст валидируется, а повреждённый и протухший дают безопасный main fallback', () => {
  const { contexts } = buildCodeContexts([
    {
      key: 'first',
      dir: '/first',
      trees: [tree('/first/task', { name: 'task', branch: 'task-only' })],
    },
    {
      key: 'second',
      dir: '/second',
      trees: [
        tree('/second', { main: true, name: 'основной', branch: 'main' }),
        tree('/second/task', { name: 'task', task: 't42', branch: 'task-42' }),
      ],
    },
  ]);
  const wanted = contexts[2];
  const stored = encodeStoredCodeContext(wanted);

  assert.equal(stored, JSON.stringify({
    v: 1,
    repoKey: 'second',
    treePath: '/second/task',
  }));
  assert.equal(pickCodeContext(contexts, stored), wanted);

  for (const invalid of [
    '',
    '{bad json',
    JSON.stringify({ v: 2, repoKey: 'second', treePath: '/second/task' }),
    JSON.stringify({ v: 1, repoKey: 7, treePath: '/second/task' }),
    JSON.stringify({ v: 1, repoKey: 'second', treePath: '/deleted' }),
    JSON.stringify({ v: 1, repoKey: 'foreign', treePath: '/second/task' }),
  ]) {
    assert.equal(pickCodeContext(contexts, invalid), contexts[1]);
  }
  assert.equal(pickCodeContext([], stored), null);
});

test('вид Git принимает только tree/list и по умолчанию выбирает дерево', () => {
  assert.equal(normalizeGitView('tree'), 'tree');
  assert.equal(normalizeGitView('list'), 'list');
  assert.equal(normalizeGitView(null), 'tree');
  assert.equal(normalizeGitView('grid'), 'tree');
});

test('Git-дерево сохраняет исходные файлы, детерминированно сортирует и делит путь только по /', () => {
  const files = [
    { path: 'z.js', status: 'M', add: 1, del: 2 },
    { path: 'src/a.js', status: 'A', add: 3, del: 0 },
    { path: 'src/B.js', status: 'D', add: 0, del: 4 },
    { path: '.env', status: 'M', binary: false },
    { path: 'src/deep/Юникод file.js', status: 'R', tooBig: true },
    { path: 'src/deep/back\\slash.js', status: 'M' },
    { path: 'renamed.js', status: 'R', oldContent: 'old', newContent: 'new' },
  ];
  const treeRoot = buildGitTree(files);
  const dirs = gitDirectoryPaths(treeRoot);
  const rows = flattenGitTree(treeRoot, dirs);

  assert.deepEqual([...dirs], ['src', 'src/deep']);
  assert.deepEqual(rows.map(({ kind, path, depth, key }) => ({ kind, path, depth, key })), [
    { kind: 'dir', path: 'src', depth: 0, key: 'dir:src' },
    { kind: 'dir', path: 'src/deep', depth: 1, key: 'dir:src/deep' },
    { kind: 'file', path: 'src/deep/back\\slash.js', depth: 2, key: 'file:src/deep/back\\slash.js' },
    { kind: 'file', path: 'src/deep/Юникод file.js', depth: 2, key: 'file:src/deep/Юникод file.js' },
    { kind: 'file', path: 'src/B.js', depth: 1, key: 'file:src/B.js' },
    { kind: 'file', path: 'src/a.js', depth: 1, key: 'file:src/a.js' },
    { kind: 'file', path: '.env', depth: 0, key: 'file:.env' },
    { kind: 'file', path: 'renamed.js', depth: 0, key: 'file:renamed.js' },
    { kind: 'file', path: 'z.js', depth: 0, key: 'file:z.js' },
  ]);
  assert.equal(rows.find((row) => row.path === 'renamed.js').file, files[6]);
  assert.equal(rows.find((row) => row.path === 'src/deep/Юникод file.js').file.tooBig, true);

  const collapsed = flattenGitTree(treeRoot, new Set());
  assert.deepEqual(collapsed.map((row) => row.path), ['src', '.env', 'renamed.js', 'z.js']);
});

test('Git-дерево не теряет коллизии файла и одноимённого каталога в обоих направлениях', () => {
  for (const files of [
    [
      { path: 'foo', status: 'D' },
      { path: 'foo/bar.js', status: 'A' },
    ],
    [
      { path: 'foo/bar.js', status: 'D' },
      { path: 'foo', status: 'A' },
    ],
  ]) {
    const treeRoot = buildGitTree(files);
    assert.deepEqual(
      flattenGitTree(treeRoot, new Set(['foo'])).map(({ kind, path, depth, key }) => ({
        kind, path, depth, key,
      })),
      [
        { kind: 'dir', path: 'foo', depth: 0, key: 'dir:foo' },
        { kind: 'file', path: 'foo', depth: 0, key: 'file:foo' },
        { kind: 'file', path: 'foo/bar.js', depth: 1, key: 'file:foo/bar.js' },
      ],
    );
    assert.deepEqual(
      flattenGitTree(treeRoot, new Set()).map(({ kind, path }) => ({ kind, path })),
      [
        { kind: 'dir', path: 'foo' },
        { kind: 'file', path: 'foo' },
      ],
    );
  }
});

test('после Git refresh сохраняются старые состояния, новые каталоги раскрываются, удалённые исчезают', () => {
  const previousDirs = new Set(['kept-open', 'kept-closed', 'removed']);
  const previousOpen = new Set(['kept-open', 'removed']);
  const nextDirs = new Set(['kept-open', 'kept-closed', 'added']);

  assert.deepEqual(
    [...reconcileGitOpenDirs(nextDirs, previousOpen, previousDirs)],
    ['kept-open', 'added'],
  );
  assert.deepEqual(
    [...reconcileGitOpenDirs(nextDirs, null, null)],
    ['kept-open', 'kept-closed', 'added'],
  );
});
