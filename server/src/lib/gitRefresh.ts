// Обновление репозиториев проекта перед запуском (триаж, конвейер).
// Безопасность важнее свежести: рабочая копия может стоять на ветке задачи
// с незакоммиченными правками — такую НЕ трогаем, только fetch. Обновляем
// (pull --ff-only) исключительно чистый master/main; любые сомнения → пропуск
// с честной причиной в результате.
import { execFile } from 'node:child_process';

// Результат одной команды git: успех и обрезанные потоки — наружу не течёт Error.
export interface GitRun {
  ok: boolean;
  out: string;
  err: string;
}

/**
 * Запускает git в каталоге без исключений: отказ приходит полем ok и текстом err.
 * env дополняет окружение процесса — так снимок триажа отключает LFS-smudge.
 */
export function git(
  dir: string,
  args: string[],
  timeout = 30000,
  env: NodeJS.ProcessEnv = {},
): Promise<GitRun> {
  return new Promise<GitRun>((resolve) => {
    execFile('git', ['-C', dir, ...args], {
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, ...env },
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        out: (stdout || '').trim(),
        err: (stderr || err?.message || '').trim(),
      });
    });
  });
}

// Репозиторий проекта: ключ для отчёта и рабочий каталог.
export interface RepoRef {
  key: string;
  dir: string;
}

// Итог по одному репозиторию: что за ветка, тронули ли её и почему.
export interface RepoRefreshResult {
  key: string;
  branch: string;
  updated: boolean;
  reason: string;
}

export interface RefreshOptions {
  // Сколько миллисекунд можно переиспользовать завершённое обновление; 0 — только идущее.
  maxAgeMs?: number;
}

// Обновление каталога, которое делят все вызывающие: триаж и запуск конвейера не гоняют
// fetch по одному репозиторию разом, а волна задач переиспользует свежий итог.
interface SharedRefresh {
  finishedAt: number | null;
  result: Promise<RepoRefreshResult>;
}

const refreshes = new Map<string, SharedRefresh>();

/**
 * Обновляет один репозиторий: fetch всегда, pull --ff-only — только чистый master/main.
 * Любой отказ git остаётся причиной в итоге, а не исключением.
 */
async function refreshRepo(r: RepoRef): Promise<RepoRefreshResult> {
  const res = { key: r.key, branch: '?', updated: false, reason: '' };
  const fetch = await git(r.dir, ['fetch', '--quiet'], 60000);
  const branch = await git(r.dir, ['rev-parse', '--abbrev-ref', 'HEAD']);

  res.branch = branch.out || '?';

  if (!fetch.ok) {
    res.reason = `fetch не прошёл: ${fetch.err.slice(0, 120)}`;

    return res;
  }

  if (!['master', 'main'].includes(res.branch)) {
    res.reason = `ветка ${res.branch} — не трогаем (только fetch)`;

    return res;
  }

  // Только изменения ОТСЛЕЖИВАЕМЫХ файлов блокируют pull; untracked не мешают ff.
  const status = await git(r.dir, ['status', '--porcelain']);

  if (status.out.split('\n').filter((line) => line && !line.startsWith('??')).length) {
    res.reason = 'есть незакоммиченные изменения — только fetch';

    return res;
  }

  const pull = await git(r.dir, ['pull', '--ff-only', '--quiet'], 60000);

  res.updated = pull.ok;
  res.reason = pull.ok ? 'обновлён (ff-only)' : `pull не прошёл: ${pull.err.slice(0, 120)}`;

  return res;
}

/**
 * Обновление каталога с общим итогом: идущее обновление того же каталога вызывающий
 * ждёт, а завершённое не старше maxAgeMs переиспользует. Ключ в итоге — свой у каждого.
 */
function sharedRefresh(r: RepoRef, maxAgeMs: number): Promise<RepoRefreshResult> {
  let entry = refreshes.get(r.dir);

  // Завершённое обновление годно строго моложе maxAgeMs: при нуле ждут только идущее.
  if (!entry || (entry.finishedAt !== null && Date.now() - entry.finishedAt >= maxAgeMs)) {
    const started: SharedRefresh = { finishedAt: null, result: refreshRepo(r) };
    const finish = () => {
      started.finishedAt = Date.now();
    };

    started.result.then(finish, finish);
    refreshes.set(r.dir, started);
    entry = started;
  }

  return entry.result.then((result) => ({ ...result, key: r.key }));
}

/**
 * Обновляет репозитории проекта параллельно: pull только для чистого master/main, иначе
 * fetch. Вызов во время идущего обновления того же каталога ждёт его, а maxAgeMs
 * разрешает переиспользовать и недавно завершённое.
 */
export async function refreshRepos(
  repos: readonly RepoRef[] | null,
  { maxAgeMs = 0 }: RefreshOptions = {},
): Promise<RepoRefreshResult[]> {
  return Promise.all((repos || []).map((r) => sharedRefresh(r, maxAgeMs)));
}
