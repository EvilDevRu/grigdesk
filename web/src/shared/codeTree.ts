// Чистая модель плагина «Код»: рабочие контексты и клиентское дерево Git-изменений.
// Здесь намеренно нет Vue/localStorage/API, чтобы правила можно было проверить отдельно.

import type { CodeRepo, CodeGitFile, CodeWorktree } from '../../../shared/codeContracts.ts';

export interface CodeContext {
  id: string;
  repoKey: string;
  repoDir: string;
  treePath: string;
  main: boolean;
  name: string;
  task: string;
  branch: string;
  branchLabel: string;
  treeLabel: string;
  label: string;
}

export type GitGroupId = 'staged' | 'work';
export type GitStatBlock = 'add' | 'del' | 'none';

export interface GitNode {
  name: string;
  path: string;
  file: CodeGitFile | null;
  children: Map<string, GitNode>;
}

interface GitRowBase {
  key: string;
  ref: string;
  group: GitGroupId | '';
  name: string;
  path: string;
  depth: number;
}

export interface GitFileRow extends GitRowBase {
  kind: 'file';
  file: CodeGitFile;
}

export interface GitDirectoryRow extends GitRowBase {
  kind: 'dir';
}

export interface GitGroupStat {
  add: number;
  del: number;
  total: number;
  blocks: GitStatBlock[];
}

interface GitGroupSource {
  id: GitGroupId;
  files: readonly CodeGitFile[];
  title: string;
  hint: string;
}

export interface GitGroup extends GitGroupSource {
  tree: GitNode;
  rows: (GitFileRow | GitDirectoryRow)[];
  list: {
    file: CodeGitFile;
    name: string;
    dir: string;
  }[];
  stat: GitGroupStat;
}

type GitPayload = {
  staged?: readonly CodeGitFile[];
  files?: readonly CodeGitFile[];
} | null | undefined;
type StoredContext = Pick<CodeContext, 'repoKey' | 'treePath'>;

const STORED_CONTEXT_VERSION = 1;

/**
 * Сохраняет мягкий fallback коллекций для локальных вызовов из legacy JS.
 * Элементы уже типизированы вызывающим кодом; проверку HTTP выполняет codeApi.
 */
function listOrEmpty<Item>(value: readonly Item[] | null | undefined): readonly Item[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Сортирует имена детерминированно, независимо от локали браузера.
 * Регистр и Unicode сохраняют прежний порядок строк дерева.
 */
function compareNames(a: string, b: string) {
  return a < b ? -1 : (a > b ? 1 : 0);
}

function branchLabel(branch: string) {
  if (branch === '(detached)') {
    return 'detached HEAD';
  }

  return branch || 'ветка не определена';
}

/**
 * Создаёт короткую метку дерева для общего селектора и шапки панели.
 * Приоритет задачи сохраняется даже при техническом имени worktree.
 */
function worktreeLabel(tree: Pick<CodeContext, 'main' | 'task' | 'name'>) {
  if (tree.main) {
    return 'Основная';
  }
  if (tree.task) {
    return `Задача ${tree.task}`;
  }

  return `Worktree ${tree.name || 'без имени'}`;
}

/**
 * Кодирует пару репозитория и дерева без неоднозначных разделителей.
 * Двоеточия внутри пути не могут столкнуть два разных контекста.
 */
export function codeContextId(repoKey: string, treePath: string) {
  return JSON.stringify([repoKey, treePath]);
}

/**
 * Собирает доступные рабочие контексты и отдельно отмечает репозитории без деревьев.
 * Сохраняет порядок сервера и не создаёт контекст для дерева без пути.
 */
export function buildCodeContexts(repos: readonly CodeRepo[] | null | undefined) {
  const contexts: CodeContext[] = [];
  const unavailable: {
    repoKey: string;
    repoDir: string;
  }[] = [];

  for (const sourceRepo of listOrEmpty(repos)) {
    const repoKey = String(sourceRepo?.key || '');
    const repoDir = String(sourceRepo?.dir || '');
    const trees = listOrEmpty<CodeWorktree>(sourceRepo?.trees)
      .filter((item) => typeof item?.path === 'string' && item.path);

    if (!trees.length) {
      unavailable.push({
        repoKey,
        repoDir,
      });
      continue;
    }

    for (const sourceTree of trees) {
      const treePath = sourceTree.path;
      const branch = typeof sourceTree.branch === 'string' ? sourceTree.branch : '';
      const context: CodeContext = {
        id: codeContextId(repoKey, treePath),
        repoKey,
        repoDir,
        treePath,
        main: !!sourceTree.main,
        name: typeof sourceTree.name === 'string' ? sourceTree.name : '',
        task: typeof sourceTree.task === 'string' ? sourceTree.task : '',
        branch,
        branchLabel: branchLabel(branch),
        treeLabel: '',
        label: '',
      };
      // Метка без ключа репозитория нужна там, где репозиторий уже назван рядом:
      // иначе в шапке «Кода» одно и то же слово стояло дважды подряд.
      context.treeLabel = `${worktreeLabel(context)} · ${context.branchLabel}`;
      context.label = `${repoKey} · ${context.treeLabel}`;
      contexts.push(context);
    }
  }

  return {
    contexts,
    unavailable,
  };
}

/**
 * Сохраняет только адрес выбранного контекста и версию формата.
 * Метки и ветки при восстановлении всегда берутся из свежего списка деревьев.
 */
export function encodeStoredCodeContext(context: StoredContext) {
  return JSON.stringify({
    v: STORED_CONTEXT_VERSION,
    repoKey: context.repoKey,
    treePath: context.treePath,
  });
}

/**
 * Проверяет версию и поля записи localStorage перед восстановлением выбора.
 * Повреждённая запись возвращает null и не блокирует открытие панели.
 */
function decodeStoredCodeContext(raw: unknown): StoredContext | null {
  if (typeof raw !== 'string' || !raw) {
    return null;
  }

  try {
    const stored: unknown = JSON.parse(raw);

    if (
      typeof stored !== 'object' || stored === null
      || !('v' in stored) || stored.v !== STORED_CONTEXT_VERSION
      || !('repoKey' in stored) || !('treePath' in stored)
      || typeof stored.repoKey !== 'string'
      || typeof stored.treePath !== 'string'
    ) {
      return null;
    }

    return {
      repoKey: stored.repoKey,
      treePath: stored.treePath,
    };
  } catch {
    return null;
  }
}

/**
 * Восстанавливает доступный сохранённый контекст, иначе выбирает основное дерево.
 * Исчезнувший worktree не оставляет панель с несуществующим адресом.
 */
export function pickCodeContext(contexts: readonly CodeContext[], storedRaw: unknown): CodeContext | null {
  const available = listOrEmpty(contexts);

  if (!available.length) {
    return null;
  }

  const stored = decodeStoredCodeContext(storedRaw);

  if (stored) {
    const id = codeContextId(stored.repoKey, stored.treePath);
    const match = available.find((context) => context.id === id);

    if (match) {
      return match;
    }
  }

  return available.find((context) => context.main) || available[0] || null;
}

/**
 * Сохраняет два поддерживаемых вида Git-панели.
 * Неизвестная настройка возвращает привычное представление деревом.
 */
export function normalizeGitView(value: unknown): 'list' | 'tree' {
  return value === 'list' ? 'list' : 'tree';
}

function gitNode(name = '', path = ''): GitNode {
  return {
    name,
    path,
    file: null,
    children: new Map(),
  };
}

/**
 * Собирает дерево путей, сохраняя ссылки на исходные объекты изменений.
 * Один узел может одновременно содержать удалённый файл и новый каталог.
 */
export function buildGitTree(files: readonly CodeGitFile[] | null | undefined) {
  const root = gitNode();

  for (const file of listOrEmpty(files)) {
    if (typeof file?.path !== 'string' || !file.path) {
      continue;
    }

    const parts = file.path.split('/');
    let node = root;
    let path = '';

    for (const part of parts) {
      path = path ? `${path}/${part}` : part;

      const child = node.children.get(part) || gitNode(part, path);

      node.children.set(part, child);
      node = child;
    }

    node.file = file;
  }

  return root;
}

function sortedChildren(node: GitNode) {
  return [...node.children.values()].sort((a, b) => compareNames(a.name, b.name));
}

/**
 * Перечисляет все каталоги изменений независимо от текущего раскрытия.
 * Этот набор нужен для сохранения выбора после обновления Git.
 */
export function gitDirectoryPaths(tree: GitNode | null) {
  const paths = new Set<string>();
  /**
   * Обходит только каталоги, включая вложенные свёрнутые узлы.
   * Файлы не добавляются в набор раскрытия.
   */
  const walk = (node: GitNode) => {
    for (const child of sortedChildren(node)) {
      if (!child.children.size) {
        continue;
      }

      paths.add(child.path);
      walk(child);
    }
  };

  if (tree) {
    walk(tree);
  }

  return paths;
}

/**
 * Путь изменения — на имя файла и каталог над ним. Плоский список показывает
 * сначала имя: обрезание с конца съедало именно его, оставляя человеку общий
 * для десятка строк префикс каталога.
 */
export function splitGitPath(path: string) {
  const value = String(path || '');
  const cut = value.lastIndexOf('/');

  return cut < 0
    ? {
      name: value,
      dir: '',
    }
    : {
      name: value.slice(cut + 1),
      dir: value.slice(0, cut),
    };
}

/**
 * Ключ строки в пределах всей панели. Один и тот же путь законно присутствует и в
 * индексе, и в рабочем дереве с РАЗНЫМИ дифами, поэтому выбор адресуется парой
 * «группа + путь», а не путём. Группа — фиксированное слово без двоеточий, поэтому
 * разбор однозначен даже у пути с двоеточием внутри.
 */
export function gitRef(group: GitGroupId | '', path: string) {
  return group ? `${group}:${path}` : String(path);
}

function fileRow(node: GitNode, file: CodeGitFile, depth: number, group: GitGroupId | ''): GitFileRow {
  return {
    kind: 'file',
    key: group ? `${group}:file:${node.path}` : `file:${node.path}`,
    ref: gitRef(group, node.path),
    group: group || '',
    name: node.name,
    path: node.path,
    depth,
    file,
  };
}

/**
 * Создаёт видимые строки с каталогами перед файлами и стабильными ключами групп.
 * Коллизия файла и каталога сохраняет обе строки даже при свёрнутом каталоге.
 */
export function flattenGitTree(
  tree: GitNode | null,
  openDirs: ReadonlySet<string>,
  group: GitGroupId | '' = '',
) {
  const rows: (GitFileRow | GitDirectoryRow)[] = [];
  const open: ReadonlySet<string> = openDirs instanceof Set ? openDirs : new Set<string>();
  /**
   * Раскладывает один уровень и спускается только в открытые каталоги.
   * Глубина относится к отображению и не меняет путь исходного файла.
   */
  const walk = (node: GitNode, depth: number) => {
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
      if (child.file) {
        rows.push(fileRow(child, child.file, depth, group));
      }
      if (open.has(ref)) {
        walk(child, depth + 1);
      }
    }
    for (const child of files) {
      if (child.file) {
        rows.push(fileRow(child, child.file, depth, group));
      }
    }
  };

  if (tree) {
    walk(tree, 0);
  }

  return rows;
}

// Столько квадратиков в полоске итога, как в сводке GitHub.
export const GIT_STAT_BLOCKS = 5;

/**
 * Итог группы, как сводка pull request на GitHub: сумма добавленных и удалённых строк по
 * всем файлам и раскладка полоски из пяти квадратиков. Пока строк не больше пяти,
 * квадратик — одна строка; дальше доли округляются вниз, но ненулевая сторона всегда
 * оставляет себе хотя бы один: две удалённые строки на фоне тысячи добавленных не должны
 * исчезать с полоски. Остаток — нейтральный.
 */
export function gitGroupStat(
  files: readonly Pick<CodeGitFile, 'add' | 'del'>[] | null | undefined,
): GitGroupStat {
  let add = 0;
  let del = 0;

  for (const file of listOrEmpty(files)) {
    add += Number(file?.add) || 0;
    del += Number(file?.del) || 0;
  }

  const total = add + del;
  let addBlocks = add;
  let delBlocks = del;

  if (total > GIT_STAT_BLOCKS) {
    addBlocks = Math.max(Math.floor((add / total) * GIT_STAT_BLOCKS), add ? 1 : 0);
    delBlocks = Math.max(Math.floor((del / total) * GIT_STAT_BLOCKS), del ? 1 : 0);
  }

  const blocks: GitStatBlock[] = [
    ...Array.from<GitStatBlock>({ length: addBlocks }).fill('add'),
    ...Array.from<GitStatBlock>({ length: delBlocks }).fill('del'),
    ...Array.from<GitStatBlock>({ length: GIT_STAT_BLOCKS - addBlocks - delBlocks }).fill('none'),
  ];

  return {
    add,
    del,
    total,
    blocks,
  };
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
export function buildGitGroups(payload: GitPayload, openDirs: ReadonlySet<string>): GitGroup[] {
  const staged = listOrEmpty(payload?.staged);
  const work = listOrEmpty(payload?.files);
  const sources: [GitGroupSource, GitGroupSource] = [
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

      return {
        ...source,
        tree,
        rows: flattenGitTree(tree, openDirs, source.id),
        list: source.files.map((file) => ({
          file,
          ...splitGitPath(file.path),
        })),
        stat: gitGroupStat(source.files),
      };
    });

  if (groups.length) {
    return groups;
  }
  // Чистое дерево: одна пустая группа остаётся, чтобы панели было куда поставить
  // заголовок, переключатель вида и честное «изменений нет».
  return [{
    ...sources[1],
    tree: buildGitTree([]),
    rows: [],
    list: [],
    stat: gitGroupStat([]),
  }];
}

/**
 * Возвращает каталоги обеих групп ключами «группа:путь» для gitOpenDirs.
 * Одинаковые пути индекса и рабочего дерева остаются независимыми.
 */
export function gitGroupDirectoryPaths(payload: GitPayload) {
  const paths = new Set<string>();

  for (const group of buildGitGroups(payload, new Set())) {
    for (const dir of gitDirectoryPaths(group.tree)) {
      paths.add(gitRef(group.id, dir));
    }
  }

  return paths;
}

/**
 * Сохраняет раскрытие известных каталогов и раскрывает впервые появившиеся.
 * Отсутствие прежних наборов означает первый снимок: раскрываются все каталоги.
 */
export function reconcileGitOpenDirs(
  nextDirs: ReadonlySet<string>,
  previousOpen?: ReadonlySet<string> | null,
  previousDirs?: ReadonlySet<string> | null,
) {
  const next: ReadonlySet<string> = nextDirs instanceof Set ? nextDirs : new Set<string>();

  if (!(previousOpen instanceof Set) || !(previousDirs instanceof Set)) {
    return new Set(next);
  }

  return new Set([...next].filter((path) => !previousDirs.has(path) || previousOpen.has(path)));
}
