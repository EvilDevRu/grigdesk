// Чистая модель плагина «Код»: рабочие контексты и клиентское дерево Git-изменений.
// Здесь намеренно нет Vue/localStorage/API, чтобы правила можно было проверить отдельно.

import type {
  CodeGitEntry,
  CodeGitLogEntry,
  CodeRepo,
  CodeWorktree,
} from '../../../shared/plugins/code/codeContracts.ts';

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

export type GitGroupId = 'staged' | 'work' | 'commits';
export type GitStatBlock = 'add' | 'del' | 'none';

export interface GitNode {
  name: string;
  path: string;
  file: CodeGitEntry | null;
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
  file: CodeGitEntry;
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
  files: readonly CodeGitEntry[];
  title: string;
  hint: string;
  mutable: boolean;
  note?: string;
}

export interface GitGroup extends GitGroupSource {
  tree: GitNode;
  rows: (GitFileRow | GitDirectoryRow)[];
  list: {
    file: CodeGitEntry;
    name: string;
    dir: string;
  }[];
  stat: GitGroupStat;
}

type GitPayload = {
  staged?: readonly CodeGitEntry[];
  files?: readonly CodeGitEntry[];
} | null | undefined;
export interface TreeDecorations {
  files: Map<string, string>;
  directories: Set<string>;
}
export interface CommitGitGroup {
  files: readonly CodeGitEntry[];
  from: string;
  to: string;
  commits: number;
  selected: number;
  mode?: 'selection' | 'branch';
  // Правая сторона — рабочее дерево: коммиты плюс несохранённые правки одним дифом.
  work?: boolean;
}
export interface AskAgentDraftOptions {
  label: string;
  branch: string;
  absPath: string;
  line: number;
  lines?: { from: number; to: number };
  snippet?: string;
  patch?: string;
}
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
export function buildGitTree(files: readonly CodeGitEntry[] | null | undefined) {
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

function fileRow(node: GitNode, file: CodeGitEntry, depth: number, group: GitGroupId | ''): GitFileRow {
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
  files: readonly Pick<CodeGitEntry, 'add' | 'del'>[] | null | undefined,
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
 * Сливает статусы индекса и рабочего дерева для обычного файлового дерева.
 * Рабочая правка одного пути сильнее staged-снимка; каталог получает метку за
 * любого потомка, а переименование относится только к новому имени.
 */
export function treeDecorations(payload: GitPayload): TreeDecorations {
  const files = new Map<string, string>();
  const directories = new Set<string>();

  for (const entry of [...listOrEmpty(payload?.staged), ...listOrEmpty(payload?.files)]) {
    files.set(entry.path, entry.status);

    const parts = entry.path.split('/');

    parts.pop();

    for (let index = 1; index <= parts.length; index += 1) {
      directories.add(parts.slice(0, index).join('/'));
    }
  }

  return { files, directories };
}

/**
 * Склоняет счётчик коммитов для заголовка и подписи группы: «1 коммит», «3 коммита»,
 * «12 коммитов». Хвост 11…14 — исключение русского множественного числа: без него
 * живой отрезок из четырнадцати коммитов подписывался как «12 коммита».
 */
function commitCountLabel(count: number) {
  const tail = count % 100;
  const digit = count % 10;
  const word = tail >= 11 && tail <= 14
    ? 'коммитов'
    : digit === 1 ? 'коммит' : digit >= 2 && digit <= 4 ? 'коммита' : 'коммитов';

  return `${count} ${word}`;
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
export function buildGitGroups(
  payload: GitPayload,
  openDirs: ReadonlySet<string>,
  commits?: CommitGitGroup | null,
): GitGroup[] {
  const staged = listOrEmpty(payload?.staged);
  const work = listOrEmpty(payload?.files);
  const sources: [GitGroupSource, GitGroupSource] = [
    {
      id: 'staged',
      files: staged,
      title: 'В индексе',
      hint: 'git add уже забрал эти правки — они уедут в следующий коммит',
      mutable: true,
    },
    {
      id: 'work',
      files: work,
      title: staged.length ? 'В рабочем дереве' : 'Не в коммите',
      hint: staged.length
        ? 'правки поверх индекса: в коммит они пока не попадут'
        : 'несохранённые правки рабочего дерева',
      mutable: true,
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

  if (commits) {
    const tree = buildGitTree(commits.files);
    const one = commits.from === commits.to;
    const hidden = Math.max(0, commits.commits - commits.selected);
    const range = commits.mode === 'branch'
      ? `Вся ветка · ${commitCountLabel(commits.commits)}`
      : (one ? `Коммит ${commits.from}` : `Коммиты ${commits.from}…${commits.to}`);
    // «+ текущие» — в заголовке, а не только в подсказке: человек должен видеть, что в
    // дифе есть и несохранённые правки, иначе он ищет их в отдельной группе.
    const title = commits.work ? `${range} + текущие` : range;
    const hint = commits.work
      ? 'слева — до первого выбранного коммита, справа — файл на диске с несохранёнными правками'
      : 'слева — до первого выбранного коммита, справа — после последнего';

    groups.push({
      id: 'commits',
      files: commits.files,
      title,
      hint,
      mutable: false,
      ...(hidden ? { note: `в отрезке ещё ${commitCountLabel(hidden)}` } : {}),
      tree,
      rows: flattenGitTree(tree, openDirs, 'commits'),
      list: commits.files.map((file) => ({
        file,
        ...splitGitPath(file.path),
      })),
      stat: gitGroupStat(commits.files),
    });
  }

  return groups;
}

/**
 * Возвращает каталоги обеих групп ключами «группа:путь» для gitOpenDirs.
 * Одинаковые пути индекса и рабочего дерева остаются независимыми.
 */
export function gitGroupDirectoryPaths(payload: GitPayload, commits?: CommitGitGroup | null) {
  const paths = new Set<string>();

  for (const group of buildGitGroups(payload, new Set(), commits)) {
    for (const dir of gitDirectoryPaths(group.tree)) {
      paths.add(gitRef(group.id, dir));
    }
  }

  return paths;
}

/**
 * Возвращает старую и новую границы выбранного отрезка в порядке журнала.
 * Неизвестные хеши не участвуют в результате.
 */
export function commitRangeBounds(
  log: readonly CodeGitLogEntry[],
  selected: ReadonlySet<string>,
): { from: string; to: string } | null {
  const indexes = log
    .map((entry, index) => selected.has(entry.hash) ? index : -1)
    .filter((index) => index >= 0);

  if (!indexes.length) {
    return null;
  }

  const newest = Math.min(...indexes);
  const oldest = Math.max(...indexes);

  return {
    from: log[oldest]?.hash || '',
    to: log[newest]?.hash || '',
  };
}

/**
 * Добавляет либо снимает один коммит, не меняя исходный Set.
 * Пустой хеш никогда не добавляется в выбор.
 */
export function toggleCommitSelection(selected: ReadonlySet<string>, hash: string) {
  const next = new Set(selected);

  if (next.has(hash)) {
    next.delete(hash);
  } else if (hash) {
    next.add(hash);
  }

  return next;
}

/**
 * Shift-выбор добавляет весь видимый отрезок между якорем и текущей строкой.
 * Потерянный якорь сводит действие к обычному переключению строки.
 */
export function extendCommitSelection(
  log: readonly CodeGitLogEntry[],
  selected: ReadonlySet<string>,
  anchor: string,
  hash: string,
) {
  const start = log.findIndex((entry) => entry.hash === anchor);
  const end = log.findIndex((entry) => entry.hash === hash);

  if (start < 0 || end < 0) {
    return toggleCommitSelection(selected, hash);
  }

  const next = new Set(selected);

  for (let index = Math.min(start, end); index <= Math.max(start, end); index += 1) {
    const entry = log[index];

    if (entry) {
      next.add(entry.hash);
    }
  }

  return next;
}

/**
 * Удаляет выбор хешей, которых больше нет в свежем журнале.
 * Исходный Set остаётся неизменным для реактивного присваивания.
 */
export function pruneCommitSelection(
  log: readonly CodeGitLogEntry[],
  selected: ReadonlySet<string>,
) {
  const available = new Set(log.map((entry) => entry.hash));

  return new Set([...selected].filter((hash) => available.has(hash)));
}

/**
 * Пути файлов группы под каталогом. Граница — только по «/»: «src» не должен захватить
 * «src-other». Порядок — как в группе, чтобы запрос к серверу был воспроизводим.
 */
export function groupDirectoryFiles(files: readonly CodeGitEntry[], dir: string): string[] {
  if (!dir) {
    return [];
  }

  const prefix = `${dir}/`;

  return files.filter((file) => file.path.startsWith(prefix)).map((file) => file.path);
}

/**
 * Режет список на порции не длиннее потолка. Нужно действиям каталога: сервер принимает
 * не больше 500 путей за раз, а каталог бывает больше — тогда действие идёт несколькими
 * последовательными запросами вместо отказа.
 */
export function chunkList<Item>(items: readonly Item[], size: number): Item[][] {
  const chunks: Item[][] = [];
  const step = Math.max(1, Math.floor(size));

  for (let index = 0; index < items.length; index += step) {
    chunks.push(items.slice(index, index + step));
  }

  return chunks;
}

/**
 * Стабильный ключ снимка сторон: путь может содержать любой печатный разделитель.
 * JSON-кортеж не допускает коллизий между группой, путём и диапазоном.
 */
export function fileDiffKey(group: GitGroupId, path: string, range = '') {
  return JSON.stringify([group, path, range]);
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

const DRAFT_CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const DRAFT_CONTROL_GLOBAL_RE = /[\u0000-\u001f\u007f]/gu;

/**
 * Ограничивает многострочный фрагмент по строкам и сообщает об отсечённом хвосте.
 * CRLF нормализуется до LF, чтобы итог одинаково выглядел на разных рабочих копиях.
 */
function draftLines(value: string, limit: number) {
  const lines = value.replace(/\r\n?/gu, '\n').split('\n');
  const truncated = lines.length > limit;
  const visible = lines.slice(0, limit);

  if (truncated) {
    visible.push('…обрезано');
  }

  return visible.join('\n');
}

/**
 * Выбирает ограждение, которое не закроется тройными обратными кавычками исходника.
 * Для обычного текста остаётся привычный тройной Markdown-fence.
 */
function fenced(value: string, language = '') {
  const fence = value.includes('```') ? '````' : '```';

  return `${fence}${language}\n${value}\n${fence}`;
}

/**
 * Формирует только черновик нового чата: отправка сообщения намеренно остаётся человеку.
 * Управляющий символ в абсолютном пути отвергается, чтобы путь не менял структуру prompt.
 */
export function askAgentDraft(options: AskAgentDraftOptions): string {
  const absPath = String(options.absPath || '');

  if (!absPath.startsWith('/') || DRAFT_CONTROL_RE.test(absPath)) {
    throw new Error('Некорректный абсолютный путь для черновика агенту.');
  }

  const label = String(options.label || '').replace(DRAFT_CONTROL_GLOBAL_RE, ' ').trim()
    || 'без метки';
  const branch = String(options.branch || '').replace(DRAFT_CONTROL_GLOBAL_RE, ' ').trim()
    || 'не определена';
  const range = options.lines;
  const from = Math.max(1, Math.floor(Number(range?.from) || Number(options.line) || 1));
  const to = Math.max(from, Math.floor(Number(range?.to) || from));
  const suffix = range ? `:${from}-${to}` : options.line > 0 ? `:${from}` : '';
  const result = [
    `Рабочая копия ${label}, ветка ${branch}`,
    '',
    `Посмотри ${absPath}${suffix}`,
  ];

  if (options.patch) {
    result.push('', fenced(draftLines(options.patch, 200), 'diff'));
  } else if (options.snippet) {
    result.push('', fenced(draftLines(options.snippet, 80)));
  }

  return result.join('\n');
}
