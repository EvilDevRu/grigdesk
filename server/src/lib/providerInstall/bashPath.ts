import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

import { shellQuote } from '../../../../shared/lib/shellQuote.ts';
import type { InstallRoots } from './npmEnvironment.ts';

/**
 * Настройка терминала принадлежит только Bash: интерактивный `.bashrc` и эффективный
 * login-файл. Блок помечен, идемпотентен и содержит объединение активных внешних
 * bin-каталогов; порядок каталогов проверяется разрешением имён, а не текстом.
 */
export const BLOCK_START = '# >>> GrigDesk external CLI PATH >>>';
export const BLOCK_END = '# <<< GrigDesk external CLI PATH <<<';

export interface ManagedBinding {
  name: string;
  directory: string;
}

export interface FileSnapshot {
  exists: boolean;
  bytes: Buffer;
  mode: number;
  dev: number;
  ino: number;
  symlink: boolean;
}

export interface BashPathChange {
  file: string;
  action: 'create' | 'update';
  snapshot: FileSnapshot;
  block: string;
  bytes: Buffer;
}

export interface BashPathPlan {
  status: 'ok' | 'manual' | 'conflict';
  reason: string | null;
  block: string;
  directories: string[];
  changes: BashPathChange[];
}

/**
 * Один принадлежащий GrigDesk блок с объединением каталогов. Повторное применение
 * не наращивает PATH: каталоги сначала вычитаются, затем ставятся в нужном порядке.
 * Чужой PATH сохраняется, а каждая каталог-строка экранируется как POSIX-слово.
 */
export function bashPathBlock(directories: readonly string[]): string {
  const entries = directories.map((directory) => `  ${shellQuote(directory)}`).join('\n');

  return [
    BLOCK_START,
    '__grigdesk_cli_dirs=(',
    entries,
    ')',
    "__grigdesk_cli_path=''",
    'for ((__grigdesk_i=${#__grigdesk_cli_dirs[@]}-1; __grigdesk_i>=0; __grigdesk_i--)); do',
    '  __grigdesk_cli_path="${__grigdesk_cli_dirs[__grigdesk_i]}'
      + '${__grigdesk_cli_path:+:$__grigdesk_cli_path}"',
    'done',
    'if [ -n "$PATH" ]; then',
    '  IFS=: read -r -a __grigdesk_entries <<< "$PATH"',
    '  for __grigdesk_entry in "${__grigdesk_entries[@]}"; do',
    '    for __grigdesk_dir in "${__grigdesk_cli_dirs[@]}"; do',
    '      if [ "$__grigdesk_entry" = "$__grigdesk_dir" ]; then',
    '        continue 2',
    '      fi',
    '    done',
    '    __grigdesk_cli_path="${__grigdesk_cli_path}'
      + '${__grigdesk_cli_path:+:}$__grigdesk_entry"',
    '  done',
    'fi',
    'export PATH="$__grigdesk_cli_path"',
    'unset __grigdesk_cli_dirs __grigdesk_cli_path __grigdesk_entries __grigdesk_entry '
      + '__grigdesk_dir __grigdesk_i',
    BLOCK_END,
    '',
  ].join('\n');
}

const BLOCK_LINES = (text: string): string[] => text.split('\n');

/**
 * Поиск управляемого блока различает три состояния: блока нет, блок один
 * и блок повреждён или продублирован. Повреждённый блок не переписывается.
 */
export function findManagedBlock(text: string): { start: number; end: number } | 'absent' | 'invalid' {
  const lines = BLOCK_LINES(text);
  const starts: number[] = [];
  const ends: number[] = [];

  lines.forEach((line, index) => {
    if (line === BLOCK_START) {
      starts.push(index);
    }
    if (line === BLOCK_END) {
      ends.push(index);
    }
  });

  if (starts.length === 0 && ends.length === 0) {
    return 'absent';
  }
  if (starts.length !== 1 || ends.length !== 1 || (starts[0] ?? 0) >= (ends[0] ?? 0)) {
    return 'invalid';
  }

  return { start: starts[0]!, end: ends[0]! };
}

/**
 * Блок добавляется в конец файла, а при повторе заменяется на прежнем месте.
 * Возвращает null, если существующий блок повреждён: такой файл человек правил сам.
 */
export function applyManagedBlock(text: string, block: string): string | null {
  const found = findManagedBlock(text);

  if (found === 'invalid') {
    return null;
  }
  if (found === 'absent') {
    const separator = text === '' || text.endsWith('\n') ? '' : '\n';

    return `${text}${separator}${block}`;
  }

  const lines = BLOCK_LINES(text).slice(found.start, found.end + 1);

  if (lines[0] !== BLOCK_START || lines[lines.length - 1] !== BLOCK_END) {
    return null;
  }

  const body = block.endsWith('\n') ? block.slice(0, -1) : block;

  return [...BLOCK_LINES(text).slice(0, found.start), ...BLOCK_LINES(body),
    ...BLOCK_LINES(text).slice(found.end + 1)].join('\n');
}

const internal = (target: string, roots: InstallRoots): boolean => {
  const resolved = path.resolve(target);
  const rootsList = [roots.dataHome, roots.installationRoot, roots.runtimeRoot]
    .map((root) => path.resolve(root));

  return rootsList.some((root) => resolved === root || resolved.startsWith(root + path.sep));
};

/**
 * Каталоги управляемого блока — только абсолютные внешние bin-каталоги.
 * Внутренние пути GrigDesk в PATH пользователя не попадают.
 */
export function externalDirectories(directories: readonly string[], roots: InstallRoots): string[] {
  const result: string[] = [];

  for (const directory of directories) {
    if (!path.isAbsolute(directory) || internal(directory, roots)) {
      continue;
    }

    const resolved = path.resolve(directory);

    if (!result.includes(resolved)) {
      result.push(resolved);
    }
  }

  return result;
}

const executableFile = (file: string): Promise<boolean> =>
  fs.stat(file).then((stat) => stat.isFile(), () => false)
    .then((file_) => file_ && fs.access(file, constants.X_OK).then(() => true, () => false));

/** Каталог, который первым разрешает имя: он и определяет команду человеку. */
/**
 * Каталог, который первым разрешает имя: он и определяет команду человеку.
 * Поиск идёт только по точке установки, без запуска shell.
 */
async function ownerOf(order: readonly string[], name: string): Promise<string | null> {
  for (const directory of order) {
    if (await executableFile(path.join(directory, name))) {
      return directory;
    }
  }

  return null;
}

/** Порядок выполним, только если каждое управляемое имя находится в своём каталоге. */
/**
 * Порядок каталогов выполним, только если каждое активное имя находит свой bin.
 * Иначе перестановка только замаскировала бы чужую копию.
 */
async function orderResolves(order: readonly string[], bindings: readonly ManagedBinding[]):
  Promise<boolean> {
  for (const binding of bindings) {
    const owner = await ownerOf(order, binding.name);

    if (!owner || path.resolve(owner) !== path.resolve(binding.directory)) {
      return false;
    }
  }

  return true;
}

/**
 * Перестановки ограничены тремя каталогами: сначала пробуется естественный порядок
 * «новый, затем прочие», затем остальные перестановки с новым каталогом впереди.
 * Невыполнимый порядок означает конфликт, а не запись блока в случайном виде.
 */
export function directoryOrders(first: string, rest: readonly string[]): string[][] {
  const queue: string[][] = [[first, ...rest]];

  for (const permutation of permutations(rest)) {
    queue.push([first, ...permutation]);
  }

  return queue;
}

function permutations(items: readonly string[]): string[][] {
  if (items.length <= 1) {
    return [[...items]];
  }

  return items.flatMap((item, index) => permutations([...items.slice(0, index),
    ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
}

/**
 * Естественный порядок «новый каталог, затем прочие» пробуется первым; дальше
 * перебираются перестановки. Невыполнимый расклад — конфликт, а не запись блока.
 */
export async function chooseDirectoryOrder(input: {
  added: string;
  existing: readonly string[];
  bindings: readonly ManagedBinding[];
}): Promise<{ order: string[]; conflict: false } | { order: []; conflict: true }> {
  const existing = input.existing.filter((directory) => path.resolve(directory)
    !== path.resolve(input.added));

  for (const order of directoryOrders(path.resolve(input.added), existing)) {
    if (await orderResolves(order, input.bindings)) {
      return { order, conflict: false };
    }
  }

  return { order: [], conflict: true };
}

/**
 * Снимок цели сравнивается дважды за запись: до временного файла и перед rename.
 * Нечитаемый или нерегулярный объект сохраняется как есть без содержимого.
 */
async function snapshotOf(file: string): Promise<FileSnapshot> {
  const held = await fs.lstat(file).catch(() => null);

  if (!held) {
    return {
      exists: false,
      bytes: Buffer.alloc(0),
      mode: 0o644,
      dev: 0,
      ino: 0,
      symlink: false,
    };
  }
  if (!held.isFile()) {
    return {
      exists: true,
      bytes: Buffer.alloc(0),
      mode: held.mode & 0o777,
      dev: held.dev,
      ino: held.ino,
      symlink: held.isSymbolicLink(),
    };
  }

  return {
    exists: true,
    bytes: await fs.readFile(file),
    mode: held.mode & 0o777,
    dev: held.dev,
    ino: held.ino,
    symlink: false,
  };
}

/**
 * Существующий `.bash_profile` сохраняет свою роль login-файла; `.profile` не
 * подменяется новым `.bash_profile`. Отсутствие обоих создаёт обычный `.profile`.
 */
async function loginFile(home: string): Promise<string> {
  for (const name of ['.bash_profile', '.bash_login', '.profile']) {
    const file = path.join(home, name);

    if (await fs.lstat(file).then(() => true, () => false)) {
      return file;
    }
  }

  return path.join(home, '.profile');
}

/**
 * План записи не создаёт каталогов и не меняет HOME: только снимки двух файлов
 * и точный текст блока. Символьная ссылка или необычный файл — ручная настройка.
 */
export async function planBashPath(input: {
  home: string;
  roots: InstallRoots;
  directories: readonly string[];
}): Promise<BashPathPlan> {
  const directories = externalDirectories(input.directories, input.roots);
  const block = bashPathBlock(directories);
  const files = [...new Set([path.join(input.home, '.bashrc'), await loginFile(input.home)])];
  const changes: BashPathChange[] = [];

  for (const file of files) {
    const snapshot = await snapshotOf(file);

    if (snapshot.symlink) {
      return {
        status: 'manual',
        reason: 'shell_rc_symlink',
        block,
        directories,
        changes: [],
      };
    }

    const held = await fs.lstat(file).catch(() => null);

    if (held && !held.isFile()) {
      return {
        status: 'manual',
        reason: 'shell_rc_not_regular',
        block,
        directories,
        changes: [],
      };
    }
    if (held && (held.mode & 0o200) === 0) {
      return {
        status: 'manual',
        reason: 'shell_rc_readonly',
        block,
        directories,
        changes: [],
      };
    }

    const text = snapshot.exists ? snapshot.bytes.toString('utf8') : '';
    const applied = applyManagedBlock(text, block);

    if (applied === null) {
      return {
        status: 'conflict',
        reason: 'shell_block_invalid',
        block,
        directories,
        changes: [],
      };
    }

    changes.push({
      file,
      action: snapshot.exists ? 'update' : 'create',
      snapshot,
      block,
      bytes: Buffer.from(applied),
    });
  }

  return {
    status: 'ok',
    reason: null,
    block,
    directories,
    changes,
  };
}

const sameSnapshot = (left: FileSnapshot, right: FileSnapshot): boolean => left.exists === right.exists
  && left.symlink === right.symlink && left.ino === right.ino && left.dev === right.dev
  && left.mode === right.mode && left.bytes.equals(right.bytes);

/**
 * Синхронизация каталога закрепляет rename после записи. Недоступный дескриптор
 * не отменяет уже опубликованный файл: истина остаётся на диске.
 */
async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r').catch(() => null);

  if (!handle) {
    return;
  }

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Writer сверяет снимок bytes+mode+identity до и после временного файла и лишь
 * затем делает rename. Родительский каталог не chmod-ится: HOME принадлежит человеку.
 */
async function writeOne(change: BashPathChange): Promise<'written' | 'changed'> {
  const current = await snapshotOf(change.file);

  if (!sameSnapshot(current, change.snapshot)) {
    return 'changed';
  }

  const directory = path.dirname(change.file);
  const temporary = path.join(directory,
    `.${path.basename(change.file)}-${process.pid}-${Date.now()}-${Math.random()
      .toString(16).slice(2)}.tmp`);
  const mode = change.snapshot.exists ? change.snapshot.mode : 0o644;
  const handle = await fs.open(temporary, 'wx', mode);

  try {
    await handle.writeFile(change.bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    const again = await snapshotOf(change.file);

    if (!sameSnapshot(again, change.snapshot)) {
      return 'changed';
    }

    await fs.rename(temporary, change.file);
    await fsyncDirectory(directory);

    return 'written';
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

/**
 * Файлы пишутся по очереди: успешный `.bashrc` не откатывается из-за отказа второго
 * файла, а итог честно сообщает, что запись была частичной.
 */
export async function writeBashPathPlan(plan: BashPathPlan):
  Promise<{ status: 'written' | 'partial' | 'changed'; written: string[] }> {
  const written: string[] = [];

  for (const change of plan.changes) {
    const result = await writeOne(change).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'EACCES'
        || (error as NodeJS.ErrnoException).code === 'EPERM'
        || (error as NodeJS.ErrnoException).code === 'EROFS') {
        return 'changed' as const;
      }

      throw error;
    });

    if (result !== 'written') {
      return { status: written.length ? 'partial' : 'changed', written };
    }

    written.push(change.file);
  }

  return { status: 'written', written };
}
