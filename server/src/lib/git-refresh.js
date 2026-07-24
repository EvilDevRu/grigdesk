// Обновление репозиториев проекта перед запуском (триаж, конвейер).
// Безопасность важнее свежести: рабочая копия может стоять на ветке задачи
// с незакоммиченными правками — такую НЕ трогаем, только fetch. Обновляем
// (pull --ff-only) исключительно чистый master/main; любые сомнения → пропуск
// с честной причиной в результате.
import { execFile } from 'node:child_process';

function git(dir, args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, ...args], { timeout, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, out: (stdout || '').trim(), err: (stderr || err?.message || '').trim() }));
  });
}

/**
 * @param {Array<{key:string, dir:string}>} repos
 * @returns {Promise<Array<{key:string, branch:string, updated:boolean, reason:string}>>}
 */
export async function refreshRepos(repos) {
  const results = [];
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
    if (status.out.split('\n').filter((l) => l && !l.startsWith('??')).length) {
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
