// Чистая модель плагина «Код»: рабочие контексты и клиентское дерево Git-изменений.
// Здесь намеренно нет Vue/localStorage/API, чтобы правила можно было проверить отдельно.

const STORED_CONTEXT_VERSION = 1;

function compareNames(a, b) {
  return a < b ? -1 : (a > b ? 1 : 0);
}

function branchLabel(branch) {
  if (branch === '(detached)') return 'detached HEAD';
  return branch || 'ветка не определена';
}

function worktreeLabel(tree) {
  if (tree.main) return 'Основная';
  if (tree.task) return `Задача ${tree.task}`;
  return `Worktree ${tree.name || 'без имени'}`;
}

export function codeContextId(repoKey, treePath) {
  return JSON.stringify([repoKey, treePath]);
}

export function buildCodeContexts(repos) {
  const contexts = [];
  const unavailable = [];
  for (const sourceRepo of Array.isArray(repos) ? repos : []) {
    const repoKey = String(sourceRepo?.key || '');
    const repoDir = String(sourceRepo?.dir || '');
    const trees = (Array.isArray(sourceRepo?.trees) ? sourceRepo.trees : [])
      .filter((item) => typeof item?.path === 'string' && item.path);
    if (!trees.length) {
      unavailable.push({ repoKey, repoDir });
      continue;
    }
    for (const sourceTree of trees) {
      const treePath = sourceTree.path;
      const branch = typeof sourceTree.branch === 'string' ? sourceTree.branch : '';
      const context = {
        id: codeContextId(repoKey, treePath),
        repoKey,
        repoDir,
        treePath,
        main: !!sourceTree.main,
        name: typeof sourceTree.name === 'string' ? sourceTree.name : '',
        task: typeof sourceTree.task === 'string' ? sourceTree.task : '',
        branch,
        branchLabel: branchLabel(branch),
      };
      context.label = `${repoKey} · ${worktreeLabel(context)} · ${context.branchLabel}`;
      contexts.push(context);
    }
  }
  return { contexts, unavailable };
}

export function encodeStoredCodeContext(context) {
  return JSON.stringify({
    v: STORED_CONTEXT_VERSION,
    repoKey: context.repoKey,
    treePath: context.treePath,
  });
}

function decodeStoredCodeContext(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const stored = JSON.parse(raw);
    if (
      stored?.v !== STORED_CONTEXT_VERSION
      || typeof stored.repoKey !== 'string'
      || typeof stored.treePath !== 'string'
    ) return null;
    return stored;
  } catch {
    return null;
  }
}

export function pickCodeContext(contexts, storedRaw) {
  if (!Array.isArray(contexts) || !contexts.length) return null;
  const stored = decodeStoredCodeContext(storedRaw);
  if (stored) {
    const id = codeContextId(stored.repoKey, stored.treePath);
    const match = contexts.find((context) => context.id === id);
    if (match) return match;
  }
  return contexts.find((context) => context.main) || contexts[0];
}

export function normalizeGitView(value) {
  return value === 'list' ? 'list' : 'tree';
}

function gitNode(name = '', path = '') {
  return { name, path, file: null, children: new Map() };
}

export function buildGitTree(files) {
  const root = gitNode();
  for (const file of Array.isArray(files) ? files : []) {
    if (typeof file?.path !== 'string' || !file.path) continue;
    const parts = file.path.split('/');
    let node = root;
    let path = '';
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      if (!node.children.has(part)) node.children.set(part, gitNode(part, path));
      node = node.children.get(part);
    }
    node.file = file;
  }
  return root;
}

function sortedChildren(node) {
  return [...node.children.values()].sort((a, b) => compareNames(a.name, b.name));
}

export function gitDirectoryPaths(tree) {
  const paths = new Set();
  const walk = (node) => {
    for (const child of sortedChildren(node)) {
      if (!child.children.size) continue;
      paths.add(child.path);
      walk(child);
    }
  };
  if (tree) walk(tree);
  return paths;
}

/**
 * Ключ строки в пределах всей панели. Один и тот же путь законно присутствует и в
 * индексе, и в рабочем дереве с РАЗНЫМИ дифами, поэтому выбор адресуется парой
 * «группа + путь», а не путём. Группа — фиксированное слово без двоеточий, поэтому
 * разбор однозначен даже у пути с двоеточием внутри.
 */
export function gitRef(group, path) {
  return group ? `${group}:${path}` : String(path);
}

function fileRow(node, depth, group) {
  return {
    kind: 'file',
    key: group ? `${group}:file:${node.path}` : `file:${node.path}`,
    ref: gitRef(group, node.path),
    group: group || '',
    name: node.name,
    path: node.path,
    depth,
    file: node.file,
  };
}

export function flattenGitTree(tree, openDirs, group = '') {
  const rows = [];
  const open = openDirs instanceof Set ? openDirs : new Set();
  const walk = (node, depth) => {
    const children = sortedChildren(node);
    const directories = children.filter((child) => child.children.size);
    const files = children.filter((child) => !child.children.size && child.file);
    for (const child of directories) {
      const ref = gitRef(group, child.path);
      rows.push({
        kind: 'dir',
        key: group ? `${group}:dir:${child.path}` : `dir:${child.path}`,
        ref,
        group: group || '',
        name: child.name,
        path: child.path,
        depth,
      });
      // Файл мог быть удалён и заменён одноимённым каталогом (или наоборот).
      if (child.file) rows.push(fileRow(child, depth, group));
      if (open.has(ref)) walk(child, depth + 1);
    }
    for (const child of files) rows.push(fileRow(child, depth, group));
  };
  if (tree) walk(tree, 0);
  return rows;
}

/**
 * Группы изменений панели «Код» — как Source Control в VS Code: сначала индекс,
 * затем рабочее дерево. Пустая группа не рисуется вовсе.
 *
 * Заголовок второй группы зависит от наличия первой намеренно: пока индекс пуст
 * (обычное состояние прогонов фабрики — она ничего не индексирует), делить нечего
 * и привычное «Не в коммите» остаётся точным. Как только индекс не пуст, «не в
 * коммите» верно уже для обеих групп, и разделяющим становится сам индекс.
 */
export function buildGitGroups(payload, openDirs) {
  const staged = Array.isArray(payload?.staged) ? payload.staged : [];
  const work = Array.isArray(payload?.files) ? payload.files : [];
  const sources = [
    {
      id: 'staged',
      files: staged,
      title: 'В индексе',
      hint: 'git add уже забрал эти правки — они уедут в следующий коммит',
    },
    {
      id: 'work',
      files: work,
      title: staged.length ? 'В рабочем дереве' : 'Не в коммите',
      hint: staged.length
        ? 'правки поверх индекса: в коммит они пока не попадут'
        : 'несохранённые правки рабочего дерева',
    },
  ];
  const groups = sources
    .filter((source) => source.files.length)
    .map((source) => {
      const tree = buildGitTree(source.files);
      return { ...source, tree, rows: flattenGitTree(tree, openDirs, source.id) };
    });
  if (groups.length) return groups;
  // Чистое дерево: одна пустая группа остаётся, чтобы панели было куда поставить
  // заголовок, переключатель вида и честное «изменений нет».
  return [{ ...sources[1], tree: buildGitTree([]), rows: [] }];
}

/** Все каталоги обеих групп — ключами «группа:путь», как их видит `gitOpenDirs`. */
export function gitGroupDirectoryPaths(payload) {
  const paths = new Set();
  for (const group of buildGitGroups(payload, new Set())) {
    for (const dir of gitDirectoryPaths(group.tree)) paths.add(gitRef(group.id, dir));
  }
  return paths;
}

export function reconcileGitOpenDirs(nextDirs, previousOpen, previousDirs) {
  const next = nextDirs instanceof Set ? nextDirs : new Set();
  if (!(previousOpen instanceof Set) || !(previousDirs instanceof Set)) return new Set(next);
  return new Set([...next].filter((path) => !previousDirs.has(path) || previousOpen.has(path)));
}
