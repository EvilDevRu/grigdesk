import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCodeContexts,
  buildGitGroups,
  buildGitTree,
  codeContextId,
  encodeStoredCodeContext,
  flattenGitTree,
  gitDirectoryPaths,
  gitGroupDirectoryPaths,
  gitRef,
  normalizeGitView,
  pickCodeContext,
  reconcileGitOpenDirs,
  splitGitPath,
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

test('группы Git: индекс первым, пустая группа не рисуется, один путь живёт в обеих', () => {
  const staged = [{ path: 'src/a.js', status: 'M', oldContent: 'head', newContent: 'index' }];
  const work = [{ path: 'src/a.js', status: 'M', oldContent: 'index', newContent: 'worktree' }];

  const both = buildGitGroups({ staged, files: work }, new Set(['staged:src', 'work:src']));
  assert.deepEqual(both.map((group) => group.id), ['staged', 'work']);
  // Второй заголовок зависит от наличия первого: пока индекс пуст, делить нечего.
  assert.deepEqual(both.map((group) => group.title), ['В индексе', 'В рабочем дереве']);

  // Ключи строк разведены по группам, поэтому выбор одного файла не выбирает второй.
  const refs = both.map((group) => group.rows.find((row) => row.kind === 'file').ref);
  assert.deepEqual(refs, ['staged:src/a.js', 'work:src/a.js']);
  assert.equal(gitRef('staged', 'src/a.js'), 'staged:src/a.js');
  assert.equal(both[0].rows.find((row) => row.kind === 'file').file.newContent, 'index');
  assert.equal(both[1].rows.find((row) => row.kind === 'file').file.newContent, 'worktree');

  const onlyWork = buildGitGroups({ staged: [], files: work }, new Set(['work:src']));
  assert.deepEqual(onlyWork.map((group) => ({ id: group.id, title: group.title })), [
    { id: 'work', title: 'Не в коммите' },
  ]);

  const onlyStaged = buildGitGroups({ staged, files: [] }, new Set());
  assert.deepEqual(onlyStaged.map((group) => group.id), ['staged']);

  // Совсем чистое дерево оставляет один пустой заголовок: панели нужно место под
  // переключатель вида и «изменений нет».
  const empty = buildGitGroups({ staged: [], files: [] }, new Set());
  assert.deepEqual(empty.map((group) => ({ id: group.id, files: group.files, rows: group.rows })), [
    { id: 'work', files: [], rows: [] },
  ]);
  assert.deepEqual(buildGitGroups(null, new Set()).map((group) => group.id), ['work']);
});

test('каталоги Git-групп раскрываются независимо друг от друга', () => {
  const payload = {
    staged: [{ path: 'src/a.js', status: 'M' }],
    files: [{ path: 'src/b.js', status: 'M' }],
  };
  assert.deepEqual([...gitGroupDirectoryPaths(payload)], ['staged:src', 'work:src']);

  const open = new Set(['staged:src']);
  const [stagedGroup, workGroup] = buildGitGroups(payload, open);
  assert.deepEqual(stagedGroup.rows.map((row) => row.path), ['src', 'src/a.js']);
  // Одноимённый каталог соседней группы остаётся свёрнутым: наборы не пересекаются.
  assert.deepEqual(workGroup.rows.map((row) => row.path), ['src']);
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

test('путь изменения делится на имя файла и каталог над ним', () => {
  assert.deepEqual(splitGitPath('mutants/core/build_shell.py'), {
    name: 'build_shell.py',
    dir: 'mutants/core',
  });
  assert.deepEqual(splitGitPath('uv.lock'), { name: 'uv.lock', dir: '' });
  assert.deepEqual(splitGitPath(''), { name: '', dir: '' });
  assert.deepEqual(splitGitPath(undefined), { name: '', dir: '' });

  // Хвостовой слэш — не каталог: имя пустое, и подставлять вместо него предка нельзя.
  assert.deepEqual(splitGitPath('src/'), { name: '', dir: 'src' });
});

test('группа изменений несёт готовые строки плоского списка в порядке ответа сервера', () => {
  const payload = {
    staged: [],
    files: [
      { path: 'src/deep/b.js', status: 'M' },
      { path: 'root.md', status: 'D' },
    ],
  };
  const [group] = buildGitGroups(payload, new Set());

  assert.deepEqual(group.list.map((entry) => [entry.name, entry.dir]), [
    ['b.js', 'src/deep'],
    ['root.md', ''],
  ]);
  assert.equal(group.list[0].file, payload.files[0]);

  // Чистое дерево тоже отдаёт список: шаблон не должен различать пустую группу.
  assert.deepEqual(buildGitGroups({ staged: [], files: [] }, new Set())[0].list, []);
});
