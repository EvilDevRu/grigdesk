// Обновление репозиториев проекта перед запуском (триаж, конвейер).
// Безопасность важнее свежести: рабочая копия может стоять на ветке задачи
// с незакоммиченными правками — такую НЕ трогаем, только fetch. Обновляем
// (pull --ff-only) исключительно чистый master/main; любые сомнения → пропуск
// с честной причиной в результате.
import { execFile } from 'node:child_process';

// Результат одной команды git: успех и обрезанные потоки — наружу не течёт Error.
interface GitRun {
  ok: boolean;
  out: string;
  err: string;
}

function git(dir: string, args: string[], timeout = 30000): Promise<GitRun> {
  return new Promise<GitRun>((resolve) => {
    execFile('git', ['-C', dir, ...args], { timeout, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, out: (stdout || '').trim(), err: (stderr || err?.message || '').trim() }));
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

/** Обновляет репозитории проекта: pull только для чистого master/main, иначе fetch. */
export async function refreshRepos(repos: readonly RepoRef[] | null): Promise<RepoRefreshResult[]> {
  const results: RepoRefreshResult[] = [];
  for (const r of repos || []) {
    const res = { key: r.key, branch: '?', updated: false, reason: '' };
    results.push(res);
    const fetch = await git(r.dir, ['fetch', '--quiet'], 60000);
    const branch = await git(r.dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    res.branch = branch.out || '?';
    if (!fetch.ok) {
      res.reason = `fetch не прошёл: ${fetch.err.slice(0, 120)}`;
      continue;
    }
    if (!['master', 'main'].includes(res.branch)) {
      res.reason = `ветка ${res.branch} — не трогаем (только fetch)`;
      continue;
    }
    // Только изменения ОТСЛЕЖИВАЕМЫХ файлов блокируют pull; untracked не мешают ff.
    const status = await git(r.dir, ['status', '--porcelain']);
    if (status.out.split('\n').filter((line) => line && !line.startsWith('??')).length) {
      res.reason = 'есть незакоммиченные изменения — только fetch';
      continue;
    }
    const pull = await git(r.dir, ['pull', '--ff-only', '--quiet'], 60000);
    if (pull.ok) {
      res.updated = true;
      res.reason = 'обновлён (ff-only)';
    } else {
      res.reason = `pull не прошёл: ${pull.err.slice(0, 120)}`;
    }
  }
  return results;
}
