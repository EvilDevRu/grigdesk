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

function fileRow(node, depth) {
  return {
    kind: 'file',
    key: `file:${node.path}`,
    name: node.name,
    path: node.path,
    depth,
    file: node.file,
  };
}

export function flattenGitTree(tree, openDirs) {
  const rows = [];
  const open = openDirs instanceof Set ? openDirs : new Set();
  const walk = (node, depth) => {
    const children = sortedChildren(node);
    const directories = children.filter((child) => child.children.size);
    const files = children.filter((child) => !child.children.size && child.file);
    for (const child of directories) {
      rows.push({
        kind: 'dir',
        key: `dir:${child.path}`,
        name: child.name,
        path: child.path,
        depth,
      });
      // Файл мог быть удалён и заменён одноимённым каталогом (или наоборот).
      if (child.file) rows.push(fileRow(child, depth));
      if (open.has(child.path)) walk(child, depth + 1);
    }
    for (const child of files) rows.push(fileRow(child, depth));
  };
  if (tree) walk(tree, 0);
  return rows;
}

export function reconcileGitOpenDirs(nextDirs, previousOpen, previousDirs) {
  const next = nextDirs instanceof Set ? nextDirs : new Set();
  if (!(previousOpen instanceof Set) || !(previousDirs instanceof Set)) return new Set(next);
  return new Set([...next].filter((path) => !previousDirs.has(path) || previousOpen.has(path)));
}
