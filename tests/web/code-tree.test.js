import assert from 'node:assert/strict';
import test from 'node:test';

import {
  askAgentDraft,
  buildCodeContexts,
  buildGitGroups,
  chunkList,
  groupDirectoryFiles,
  commitRangeBounds,
  extendCommitSelection,
  fileDiffKey,
  buildGitTree,
  codeContextId,
  encodeStoredCodeContext,
  flattenGitTree,
  GIT_STAT_BLOCKS,
  gitDirectoryPaths,
  gitGroupDirectoryPaths,
  gitGroupStat,
  gitRef,
  normalizeGitView,
  pickCodeContext,
  pruneCommitSelection,
  reconcileGitOpenDirs,
  splitGitPath,
  treeDecorations,
  toggleCommitSelection,
} from '../../web/src/shared/codeTree.ts';

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

test('итог группы: сумма строк по файлам и полоска из пяти квадратиков, как на GitHub', () => {
  assert.equal(GIT_STAT_BLOCKS, 5);

  // Пока строк не больше пяти, квадратик равен строке.
  assert.deepEqual(gitGroupStat([{ add: 1, del: 0 }, { add: 1, del: 2 }]), {
    add: 2,
    del: 2,
    total: 4,
    blocks: ['add', 'add', 'del', 'del', 'none'],
  });
  // Дальше — доли с округлением вниз, остаток полоски нейтральный.
  assert.deepEqual(gitGroupStat([{ add: 7, del: 3 }]).blocks, ['add', 'add', 'add', 'del', 'none']);
  // Ненулевая сторона не исчезает с полоски даже при ничтожной доле.
  assert.deepEqual(gitGroupStat([{ add: 998, del: 2 }]).blocks, ['add', 'add', 'add', 'add', 'del']);
  assert.deepEqual(gitGroupStat([{ add: 1, del: 4999 }]).blocks, ['add', 'del', 'del', 'del', 'del']);

  // Бинарные и файлы без счётчиков дают пустой итог — панель его не рисует.
  assert.deepEqual(gitGroupStat([{ binary: true }, { add: 0, del: 0 }]), {
    add: 0,
    del: 0,
    total: 0,
    blocks: ['none', 'none', 'none', 'none', 'none'],
  });
  assert.equal(gitGroupStat(null).total, 0);

  // Группа несёт готовый итог: шаблон список не пересчитывает.
  const payload = { staged: [], files: [{ path: 'a.js', status: 'M', add: 4, del: 1 }] };
  assert.deepEqual(buildGitGroups(payload, new Set())[0].stat, {
    add: 4,
    del: 1,
    total: 5,
    blocks: ['add', 'add', 'add', 'add', 'del'],
  });
  assert.equal(buildGitGroups({ staged: [], files: [] }, new Set())[0].stat.total, 0);
});

test('метки дерева сливают индекс и рабочие правки, сохраняя каталоги и новое имя', () => {
  const decorations = treeDecorations({
    staged: [
      { path: 'src/app.js', status: 'M' },
      { path: 'same', status: 'D' },
    ],
    files: [
      { path: 'src/app.js', status: 'D' },
      { path: 'same/child.js', status: 'A' },
      { path: 'renamed/new.js', oldPath: 'old.js', status: 'R' },
    ],
  });

  assert.deepEqual([...decorations.files], [
    ['src/app.js', 'D'],
    ['same', 'D'],
    ['same/child.js', 'A'],
    ['renamed/new.js', 'R'],
  ]);
  assert.deepEqual([...decorations.directories], ['src', 'same', 'renamed']);
  assert.equal(decorations.files.has('old.js'), false);
  assert.equal(decorations.files.get('src/app.js'), 'D',
    'рабочее дерево имеет приоритет над индексом');
});

test('выбор коммитов задаёт непрерывные границы, shift-отрезок и очищается по журналу', () => {
  const log = ['ccccccc', 'bbbbbbb', 'aaaaaaa'].map((hash) => ({ hash, subject: hash, when: '' }));

  assert.deepEqual(commitRangeBounds(log, new Set(['ccccccc', 'aaaaaaa'])), {
    from: 'aaaaaaa',
    to: 'ccccccc',
  });
  assert.equal(commitRangeBounds(log, new Set()), null);
  assert.equal(commitRangeBounds(log, new Set(['missing'])), null);
  assert.deepEqual([...toggleCommitSelection(new Set(), 'ccccccc')], ['ccccccc']);
  assert.deepEqual([...toggleCommitSelection(new Set(['ccccccc']), 'ccccccc')], []);
  assert.deepEqual(
    [...extendCommitSelection(log, new Set(['ccccccc']), 'ccccccc', 'aaaaaaa')],
    ['ccccccc', 'bbbbbbb', 'aaaaaaa'],
  );
  assert.deepEqual([...pruneCommitSelection(log, new Set(['ccccccc', 'missing']))], ['ccccccc']);
});

test('группа выбранных коммитов неизменяема, последняя и имеет отдельный ключ кеша', () => {
  const payload = { staged: [], files: [] };
  const commits = {
    files: [{ path: 'src/a.ts', status: 'M', add: 3, del: 1, binary: false }],
    from: 'aaaaaaa',
    to: 'ccccccc',
    commits: 3,
    selected: 2,
  };
  const groups = buildGitGroups(payload, new Set(['commits:src']), commits);

  assert.deepEqual(groups.map((group) => group.id), ['work', 'commits']);
  assert.equal(groups[1].title, 'Коммиты aaaaaaa…ccccccc');
  assert.equal(groups[1].note, 'в отрезке ещё 1 коммит');
  assert.equal(groups[1].mutable, false);
  assert.deepEqual([...gitGroupDirectoryPaths(payload, commits)], ['commits:src']);
  assert.notEqual(fileDiffKey('work', 'src/a.ts'), fileDiffKey('commits', 'src/a.ts', 'a:c'));
});

test('режим «с текущими изменениями» виден в заголовке группы, подсказке и ключе кеша', () => {
  const payload = { staged: [], files: [] };
  const source = {
    files: [],
    from: 'aaaaaaa',
    to: 'ccccccc',
    commits: 3,
    selected: 2,
    work: true,
  };
  const [, range] = buildGitGroups(payload, new Set(), source);
  const [, one] = buildGitGroups(payload, new Set(), { ...source, from: 'ccccccc', selected: 1 });
  const [, branch] = buildGitGroups(payload, new Set(), { ...source, mode: 'branch', selected: 3 });
  const [, plain] = buildGitGroups(payload, new Set(), { ...source, work: false });

  assert.equal(range.title, 'Коммиты aaaaaaa…ccccccc + текущие');
  assert.equal(one.title, 'Коммит ccccccc + текущие');
  assert.equal(branch.title, 'Вся ветка · 3 коммита + текущие');
  assert.equal(plain.title, 'Коммиты aaaaaaa…ccccccc');
  assert.match(range.hint, /на диске/);
  assert.doesNotMatch(plain.hint, /на диске/);
  assert.notEqual(fileDiffKey('commits', 'a.ts', 'b:c:work'), fileDiffKey('commits', 'a.ts', 'b:c'));
});

test('файлы каталога группы собираются по префиксу пути, порции ограничены потолком', () => {
  const files = [
    { path: 'src/a.js', status: 'M', add: 1, del: 0, binary: false },
    { path: 'src/deep/b.js', status: 'A', add: 1, del: 0, binary: false },
    { path: 'src-other/c.js', status: 'M', add: 1, del: 0, binary: false },
    { path: 'top.js', status: 'D', add: 0, del: 1, binary: false },
  ];

  // «src-other/c.js» начинается с «src», но лежит в другом каталоге — граница только по «/».
  assert.deepEqual(groupDirectoryFiles(files, 'src'), ['src/a.js', 'src/deep/b.js']);
  assert.deepEqual(groupDirectoryFiles(files, 'src/deep'), ['src/deep/b.js']);
  assert.deepEqual(groupDirectoryFiles(files, ''), []);
  assert.deepEqual(chunkList(['a', 'b', 'c', 'd', 'e'], 2), [['a', 'b'], ['c', 'd'], ['e']]);
  assert.deepEqual(chunkList([], 2), []);
});

test('счётчик коммитов в подписи и заголовке ветки склоняется по-русски', () => {
  const payload = { staged: [], files: [] };
  const note = (commits, selected) => buildGitGroups(payload, new Set(), {
    files: [],
    from: 'aaaaaaa',
    to: 'ccccccc',
    commits,
    selected,
  })[1].note;
  const branch = (commits) => buildGitGroups(payload, new Set(), {
    files: [],
    from: 'aaaaaaa',
    to: 'ccccccc',
    commits,
    selected: 0,
    mode: 'branch',
  })[1].title;

  // Живой случай: 14 коммитов в отрезке при двух выбранных показывались как «12 коммита».
  assert.equal(note(14, 2), 'в отрезке ещё 12 коммитов');
  assert.equal(note(4, 1), 'в отрезке ещё 3 коммита');
  assert.equal(note(7, 2), 'в отрезке ещё 5 коммитов');
  assert.equal(note(23, 1), 'в отрезке ещё 22 коммита');
  assert.equal(note(2, 1), 'в отрезке ещё 1 коммит');
  assert.equal(branch(1), 'Вся ветка · 1 коммит');
  assert.equal(branch(3), 'Вся ветка · 3 коммита');
  assert.equal(branch(11), 'Вся ветка · 11 коммитов');
  assert.equal(branch(21), 'Вся ветка · 21 коммит');
});

test('черновик агенту описывает worktree, строку, диапазон и безопасные лимиты', () => {
  assert.equal(askAgentDraft({
    label: 'Задача t42',
    branch: 'task-42',
    absPath: '/work/t42/src/a.ts',
    line: 7,
  }), [
    'Рабочая копия Задача t42, ветка task-42',
    '',
    'Посмотри /work/t42/src/a.ts:7',
  ].join('\n'));

  const snippet = ['const fence = ```;', ...Array.from({ length: 85 }, (_, index) => `line ${index}`)]
    .join('\n');
  const ranged = askAgentDraft({
    label: 'Основная',
    branch: 'main',
    absPath: '/repo/src/a.ts',
    line: 3,
    lines: { from: 3, to: 88 },
    snippet,
  });

  assert.match(ranged, /Посмотри \/repo\/src\/a\.ts:3-88/);
  assert.match(ranged, /````\nconst fence = ```;/);
  assert.match(ranged, /…обрезано\n````$/);
  assert.equal(ranged.split('\n').filter((line) => /^line \d+$/u.test(line)).length, 79);
});

test('черновик diff ограничен 200 строками и отвергает управляющий символ пути', () => {
  const patch = Array.from({ length: 205 }, (_, index) => `+line ${index}`).join('\n');
  const draft = askAgentDraft({
    label: 'Worktree review',
    branch: 'review',
    absPath: '/repo/src/a.ts',
    line: 0,
    patch,
  });

  assert.match(draft, /```diff\n\+line 0/);
  assert.match(draft, /…обрезано\n```$/);
  assert.equal(draft.split('\n').filter((line) => /^\+line \d+$/u.test(line)).length, 200);
  assert.throws(() => askAgentDraft({
    label: 'Основная', branch: 'main', absPath: '/repo/bad\npath.ts', line: 1,
  }), /путь/i);
});
