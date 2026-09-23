// Проверка пути к репозиторию: что лежит на диске, без запуска процессов.
//
// Git-команды здесь были бы дороже и опаснее: на недоступном каталоге или сетевой ФС
// `git status` висит до таймаута, а нам нужно ровно одно — рабочая копия это или нет.
// По `.git` это видно: каталог — обычная копия, файл с `gitdir:` — копия, связанная
// с другим каталогом (worktree). Путь приходит от человека, поэтому не подставляется
// ни в шелл, ни в команду: он только читается.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Stats } from 'node:fs';

export type RepositoryState =
  | 'git'
  | 'worktree'
  | 'dir'
  | 'missing'
  | 'file'
  | 'denied'
  | 'timeout';

export interface RepositoryCheckResult {
  dir: string;
  state: RepositoryState;
  message: string;
}

// Тексты одинаковы у библиотеки и у HTTP: форма показывает ровно то, что вернул сервер.
const MESSAGES: Record<RepositoryState, string> = {
  git: 'Рабочая копия git',
  worktree: 'Рабочая копия, связанная с другим каталогом',
  dir: 'Каталог без .git',
  missing: 'Каталога нет',
  file: 'По пути файл, а не каталог',
  denied: 'Нет доступа к каталогу',
  timeout: 'Проверка не уложилась во время',
};

type StatLike = (target: string) => Promise<Stats>;

export interface RepositoryCheckOptions {
  timeoutMs?: number;
  // Подменяемый stat: им проверяется и таймаут — медленная файловая система
  // в тесте иначе не воспроизводится.
  stat?: StatLike;
}

const TIMEOUT = Symbol('timeout');

/** Ожидание с уборкой таймера: без clearTimeout проверка держала бы событийный цикл. */
function delay(ms: number): { promise: Promise<typeof TIMEOUT>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;

  const promise = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
  });

  return { promise, cancel: () => clearTimeout(timer) };
}

function stateOfError(err: unknown): RepositoryState {
  const code = (err as { code?: unknown } | null)?.code;

  if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
  if (code === 'EACCES' || code === 'EPERM') return 'denied';

  throw err;
}

async function probe(dir: string, stat: StatLike): Promise<RepositoryState> {
  let root: Stats;

  try {
    root = await stat(dir);
  } catch (err) {
    return stateOfError(err);
  }

  if (!root.isDirectory()) {
    return 'file';
  }

  let dotGit: Stats;

  try {
    dotGit = await stat(path.join(dir, '.git'));
  } catch {
    // `.git` нет или он не читается — для формы это обычный каталог.
    return 'dir';
  }

  if (dotGit.isDirectory()) {
    return 'git';
  }

  try {
    const pointer = await fs.readFile(path.join(dir, '.git'), 'utf8');

    if (pointer.startsWith('gitdir:')) {
      return 'worktree';
    }
  } catch {
    // Файл `.git` есть, но не читается: рабочей копией он не доказан.
  }

  return 'dir';
}

/**
 * Состояние пути для строки формы: каталог, рабочая копия, файл, отсутствие, отказ
 * доступа или превышение времени. Проверка целиком ограничена `timeoutMs`, поэтому
 * медленная ФС даёт `timeout`, а не повисшую форму.
 */
export async function checkRepositoryPath(
  dir: string,
  { timeoutMs = 3000, stat = fs.stat as StatLike }: RepositoryCheckOptions = {},
): Promise<RepositoryCheckResult> {
  const timer = delay(timeoutMs);
  const outcome = await Promise.race([
    probe(dir, stat),
    timer.promise,
  ]);

  timer.cancel();

  const state = outcome === TIMEOUT ? 'timeout' : outcome;

  return { dir, state, message: MESSAGES[state] };
}

/**
 * Проверка списка путей с ограничением параллельности: форма шлёт до нескольких
 * десятков строк, и открывать их все разом на медленной ФС нельзя.
 */
export async function checkRepositoryPaths(
  dirs: string[],
  { concurrency = 4, ...options }: RepositoryCheckOptions & { concurrency?: number } = {},
): Promise<RepositoryCheckResult[]> {
  const results = new Array<RepositoryCheckResult>(dirs.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < dirs.length) {
      const index = next;
      const dir = dirs[index];

      next += 1;

      if (dir !== undefined) {
        results[index] = await checkRepositoryPath(dir, options);
      }
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, dirs.length)) },
    () => worker(),
  );

  await Promise.all(workers);

  return results;
}
