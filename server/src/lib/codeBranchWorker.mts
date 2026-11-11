// Этот файл копируется в папку данных перед запуском. Все runtime imports — built-ins:
// переключение checkout не может удалить исполняемый код и оборвать следующие этапы.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { fstatSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import type {
  CodeBranch, CodeBranchJob, CodeBranchSettings,
} from '../../../shared/plugins/code/codeBranchContracts.ts';

const execute = promisify(execFile);

export interface BranchPlan {
  root: string;
  ref: string;
  branch: string;
  commit: string;
  beforeBranch: string;
  beforeCommit: string;
  remote: boolean;
}

export interface BranchWorkerInput {
  plan: BranchPlan;
  settings: CodeBranchSettings;
  job: CodeBranchJob;
}

/**
 * Git получает буквальные аргументы и не запускает checkout hooks или submodules.
 * Вывод сетевых команд сюда не попадает: выбор работает по уже известным refs.
 */
async function git(root: string, args: string[]): Promise<string> {
  const result = await execute('git', [
    '-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'submodule.recurse=false', ...args,
  ], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });

  return result.stdout.trim();
}

/**
 * Список содержит только ветки, без символических remote HEAD и произвольных ревизий.
 * Полное имя ref различает одинаковые имена на нескольких remotes.
 */
export async function listCodeBranches(root: string): Promise<CodeBranch[]> {
  const current = await git(root, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => '');
  const output = await git(root, [
    'for-each-ref', '--sort=refname',
    '--format=%(refname)%00%(objectname)%00%(symref)%00%(worktreepath)',
    'refs/heads/', 'refs/remotes/',
  ]);

  return output.split('\n').filter(Boolean).flatMap((line): CodeBranch[] => {
    const [ref = '', commit = '', symbolic = '', occupied = ''] = line.split('\0');

    if (symbolic) {
      return [];
    }

    const kind = ref.startsWith('refs/heads/') ? 'local' : 'remote';

    return [{
      ref,
      name: ref.replace(/^refs\/(heads|remotes)\//u, ''),
      kind,
      commit,
      current: ref === current,
      occupied,
    }];
  });
}

/**
 * Чистота включает индекс, untracked и незавершённые Git-операции.
 * Даже не конфликтующая правка не переносится молча на другую ветку.
 */
export async function assertCleanCodeBranch(root: string): Promise<void> {
  const status = await git(root, ['status', '--porcelain=v1', '--untracked-files=normal']);

  if (status) {
    throw new Error('Сначала сохраните изменения: индекс, рабочие и новые файлы должны быть чистыми.');
  }

  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    const location = await git(root, ['rev-parse', '--git-path', marker]);

    if (await fs.stat(path.resolve(root, location)).then(() => true, () => false)) {
      throw new Error('Сначала завершите текущую операцию Git.');
    }
  }
}

/**
 * Фиксирует исходный и целевой коммиты до остановки стенда.
 * Занятая worktree ветка и коллизия локального имени отклоняются заранее.
 */
export async function planCodeBranchSwitch(root: string, ref: string): Promise<BranchPlan> {
  const branches = await listCodeBranches(root);
  const target = branches.find((item) => item.ref === ref);
  const current = branches.find((item) => item.current);

  if (!target || !current) {
    throw new Error('Выберите существующую ветку. Detached HEAD не поддерживается.');
  }

  await assertCleanCodeBranch(root);

  const remote = target.kind === 'remote';
  const branch = remote ? target.name.slice(target.name.indexOf('/') + 1) : target.name;

  await git(root, ['check-ref-format', '--branch', branch]);

  if (target.occupied && path.resolve(target.occupied) !== path.resolve(root)) {
    throw new Error('Эта ветка уже открыта в другой рабочей копии.');
  }
  if (remote && branches.some((item) => item.ref === `refs/heads/${branch}`)) {
    throw new Error(`Локальная ветка «${branch}» уже существует. Выберите её в списке.`);
  }

  return {
    root,
    ref,
    branch,
    commit: target.commit,
    beforeBranch: current.name,
    beforeCommit: current.commit,
    remote,
  };
}

/**
 * Запись через rename не оставляет половину JSON при закрытии сервера.
 * Единственный writer задания — отсоединённый worker, а не HTTP polling.
 */
async function saveJob(directory: string, job: CodeBranchJob): Promise<void> {
  const target = path.join(directory, 'job.json');

  await fs.writeFile(`${target}.tmp`, JSON.stringify(job), { mode: 0o600 });
  await fs.rename(`${target}.tmp`, target);
}

/**
 * Каждый этап — конечная команда управления процессом, например docker compose up -d.
 * Таймаут останавливает собственную группу команды и не даёт запустить следующий этап.
 */
async function command(text: string, input: BranchWorkerInput): Promise<void> {
  if (!text.trim()) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn('bash', ['--noprofile', '--norc', '-c', text], {
      cwd: input.plan.root,
      detached: true,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        ...process.env,
        GRIGDESK_BRANCH: input.plan.branch,
        GRIGDESK_COMMIT: input.plan.commit,
        GIT_TERMINAL_PROMPT: '0',
      },
    });
    const timer = setTimeout(() => {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // Группа могла завершиться одновременно с таймаутом.
        }
      }
    }, 20 * 60_000);

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);

      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Команда завершилась: ${signal || code}. См. журнал.`));
      }
    });
  });
}

/**
 * Подготовка и сборка могут сами менять Git; чужой checkout нельзя запускать как целевой.
 * Сверяем и символическую ветку, и коммит перед каждым следующим этапом.
 */
async function assertPlannedHead(plan: BranchPlan): Promise<void> {
  const actual = await git(plan.root, ['rev-parse', 'HEAD']);
  const branch = await git(plan.root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);

  if (actual !== plan.commit || branch !== plan.branch) {
    throw new Error('Ветка или коммит изменились во время запуска. Готовность не подтверждена.');
  }
}

/**
 * Остановка предшествует checkout, а запуск возможен только после успешной сборки.
 * При сбое сохраняются достигнутый шаг и checkout; автоматического reset/rollback нет.
 */
export async function runCodeBranchJob(directory: string, input: BranchWorkerInput): Promise<void> {
  const { plan, settings, job } = input;
  const step = async (name: CodeBranchJob['step']) => {
    job.step = name;
    console.log(`\n[${name}] ${new Date().toISOString()}`);
    await saveJob(directory, job);
  };

  try {
    await step('checking');

    const before = await planCodeBranchSwitch(plan.root, plan.ref);

    if (JSON.stringify(before) !== JSON.stringify(plan)) {
      throw new Error('Ветки изменились после подтверждения. Обновите список и повторите.');
    }

    await step('stop');
    await command(settings.stop, input);
    await assertCleanCodeBranch(plan.root);

    const fresh = await planCodeBranchSwitch(plan.root, plan.ref);

    if (JSON.stringify(fresh) !== JSON.stringify(plan)) {
      throw new Error('Ветки изменились во время остановки стенда.');
    }

    await step('switch');

    if (plan.remote) {
      await git(plan.root, ['switch', '--no-overwrite-ignore', '-c', plan.branch, '--track', plan.ref]);
    } else {
      await git(plan.root, ['switch', '--no-overwrite-ignore', '--no-guess', plan.branch]);
    }

    for (const name of ['prepare', 'build', 'start', 'check'] as const) {
      await step(name);
      await assertPlannedHead(plan);
      await command(settings[name], input);
    }

    await assertPlannedHead(plan);

    job.status = 'succeeded';
    job.step = 'done';
  } catch (error) {
    job.status = 'failed';
    job.message = error instanceof Error ? error.message : String(error);
    console.error(job.message);
  } finally {
    job.finishedAt = Date.now();
    await saveJob(directory, job);
  }
}

/**
 * Явный вход вызывается и исходным Node, и генератором упакованных helpers.
 * Все пути задания получены от сервера, а не из содержимого checkout.
 */
export async function main(): Promise<void> {
  const directory = process.argv[2]!;
  const input: BranchWorkerInput = JSON.parse(await fs.readFile(path.join(directory, 'input.json'), 'utf8'));

  try {
    // У standalone worker нет runtime-зависимостей из checkout. Identity пишется
    // здесь, чтобы PID принадлежал worker-у, включая запуск через systemd-run scope.
    const stat = await fs.readFile(`/proc/${process.pid}/stat`, 'utf8');
    const cmdline = (await fs.readFile(`/proc/${process.pid}/cmdline`, 'utf8'))
      .split('\0').filter(Boolean).join(' ');

    await fs.writeFile(path.join(directory, 'owner.json'), JSON.stringify({
      pid: process.pid,
      starttime: stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u)[19],
      cmdline,
      script: process.argv[1],
      nonce: directory,
    }), { mode: 0o600 });

    // Без унаследованного lock fd ни один внешний эффект не разрешён.
    const inherited = fstatSync(3);
    const atPath = await fs.stat(path.join(directory, '..', 'runtime.lock'));

    if (!inherited.isFile() || inherited.dev !== atPath.dev || inherited.ino !== atPath.ino) {
      throw new Error('Наследуемый fd не принадлежит runtime lock.');
    }
  } catch {
    input.job.status = 'failed';
    input.job.message = 'Исполнитель не получил блокировку рабочей папки.';
    input.job.finishedAt = Date.now();
    await saveJob(directory, input.job);

    return;
  }

  await runCodeBranchJob(directory, input);
}

// Генератор main-helper ставит этот маркер до импорта и сам вызывает main один раз.
// Прямой вход не использует top-level await: модуль входит также в CJS payload сервера.
const marked = globalThis as typeof globalThis & { __grigdeskHelperEntry?: string };

if (process.argv[1] === fileURLToPath(import.meta.url) && !marked.__grigdeskHelperEntry) {
  void main();
}
