import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  DEFAULT_CODE_BRANCH_SETTINGS, parseCodeBranchSettings,
} from '../../../shared/plugins/code/codeBranchContracts.ts';
import type {
  CodeBranchJob, CodeBranchOverview, CodeBranchSettings,
} from '../../../shared/plugins/code/codeBranchContracts.ts';
import { acquireKernelFileLock } from './kernelLock.ts';
import { CodeGitError } from './git.ts';
import { helperCommand } from './runtimePaths.ts';
import { processIdentityMatches } from './speech/modelJobsProcess.ts';
import type { OwnedProcessIdentity } from './speech/modelJobsProcess.ts';
import { listCodeBranches, planCodeBranchSwitch } from './codeBranchWorker.mts';
import type { BranchWorkerInput } from './codeBranchWorker.mts';

const execute = promisify(execFile);

/**
 * Чтение JSON различает отсутствие и повреждение состояния.
 * Повреждённые команды не заменяются молча настройками по умолчанию.
 */
async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

/**
 * У каждого сохранения собственный temporary file: два окна не делят имя перед rename.
 * Настройки находятся в папке данных и не меняются вместе с Git checkout.
 */
async function writeJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;

  await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await fs.rename(temporary, file);
}

/**
 * Команды — явные настройки человека, с ограниченным размером и без NUL.
 * Адрес служит ссылкой: готовность доказывает отдельная конечная команда check.
 */
function validatedSettings(value: unknown): CodeBranchSettings {
  let settings: CodeBranchSettings;

  try {
    settings = parseCodeBranchSettings(value);
  } catch {
    throw new CodeGitError('bad_branch_settings', 'Некорректная форма команд запуска.', 400);
  }

  for (const field of Object.values(settings)) {
    if (field.length > 8_000 || field.includes('\0')) {
      throw new CodeGitError('bad_branch_settings', 'Поле настройки слишком длинное или содержит NUL.', 400);
    }
  }

  if (!settings.returnBranch.trim() || /[\s\x00-\x1f]/u.test(settings.returnBranch)) {
    throw new CodeGitError('bad_branch_settings', 'Укажите имя ветки возврата.', 400);
  }
  if (settings.url) {
    let url;

    try {
      url = new URL(settings.url);
    } catch {
      throw new CodeGitError('bad_branch_settings', 'Адрес приложения должен быть HTTP(S) URL.', 400);
    }

    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new CodeGitError(
        'bad_branch_settings', 'Адрес приложения должен быть HTTP(S) URL без пароля.', 400,
      );
    }
  }

  return settings;
}

/**
 * Один основной checkout имеет один runtime и один наследуемый kernel lock.
 * HTTP только читает журнал; исполнение продолжает worker из собственной копии кода.
 */
export class CodeBranchRuns {
  private readonly launching = new Set<string>();

  constructor(privateStateDir: string, serverRoot?: string) {
    this.directory = path.join(privateStateDir, 'code-branches');
    this.serverRoot = serverRoot || '';
  }

  private readonly directory: string;
  private readonly serverRoot: string;

  private location(root: string): string {
    return path.join(this.directory, createHash('sha256').update(root).digest('hex'));
  }

  /**
   * Проба kernel lock видит и worker предыдущего процесса сервера.
   * Файл замка не удаляется, иначе другой inode разрушил бы взаимное исключение.
   */
  async busy(root: string): Promise<boolean> {
    if (this.launching.has(root)) {
      return true;
    }

    try {
      await fs.stat(path.join(this.location(root), 'runtime.lock'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }

      throw error;
    }

    try {
      const lock = await this.lock(root);

      await lock.release();

      return false;
    } catch (error) {
      if ((error as { code?: string }).code === 'branch_busy') {
        return true;
      }

      throw error;
    }
  }

  private lock(root: string) {
    return acquireKernelFileLock({
      lockPath: path.join(this.location(root), 'runtime.lock'),
      timeoutMs: 1,
      timeoutCode: 'branch_busy',
      errorFactory: (code, message) => new CodeGitError(code, message),
    });
  }

  /**
   * Снимок различает текущий Git и результат последнего запуска.
   * Исчезнувший worker превращается в понятный отказ, а не вечный progress.
   */
  async overview(root: string): Promise<CodeBranchOverview> {
    const directory = this.location(root);
    const branches = await listCodeBranches(root);
    const stored = await readJson(path.join(directory, 'settings.json'));
    const current = await readJson(path.join(directory, 'current.json')) as { id: string } | null;
    let job: CodeBranchJob | null = null;
    let log = '';

    if (current) {
      const work = path.join(directory, current.id);

      job = await readJson(path.join(work, 'job.json')) as CodeBranchJob | null;

      if (job?.status === 'running' && Date.now() - job.startedAt > 10_000) {
        const owner = await readJson(path.join(work, 'owner.json')) as OwnedProcessIdentity | null;

        if (!processIdentityMatches(owner) && !await this.busy(root)) {
          job = {
            ...job,
            status: 'failed',
            message: 'Исполнитель остановился. Проверьте стенд и повторите.',
          };
        }
      }

      const file = await fs.open(path.join(work, 'output.log'), 'r').catch(() => null);

      if (file) {
        try {
          const size = (await file.stat()).size;
          const buffer = Buffer.alloc(Math.min(size, 65_536));
          const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));

          log = buffer.subarray(0, bytesRead).toString('utf8');
        } finally {
          await file.close();
        }
      }
    }

    const actual = branches.find((item) => item.current);

    return {
      branches,
      settings: stored === null ? { ...DEFAULT_CODE_BRANCH_SETTINGS } : validatedSettings(stored),
      job,
      actualBranch: actual?.name || '',
      actualCommit: actual?.commit || '',
      log,
    };
  }

  /**
   * Сохранение не запускает команды и не меняет ветку.
   * Текущий worker использует уже зафиксированный снимок настроек.
   */
  async configure(root: string, value: unknown): Promise<void> {
    const settings = validatedSettings(value);

    await fs.mkdir(this.location(root), { recursive: true, mode: 0o700 });
    await writeJson(path.join(this.location(root), 'settings.json'), settings);
  }

  /**
   * Lock и marker ставятся до проверки агентов: новый ход уже видит занятость.
   * Worker наследует fd и держит runtime до конца всех конечных команд профиля.
   */
  async start(
    root: string,
    ref: string,
    expected: { commit: string; head: string },
    agentsBusy: () => Promise<boolean>,
  ): Promise<void> {
    const lock = await this.lock(root);

    this.launching.add(root);

    try {
      if (await agentsBusy()) {
        throw new CodeGitError('agents_busy', 'В этой папке работает агент. Дождитесь завершения хода.');
      }

      const snapshot = await this.overview(root);
      const settings = snapshot.settings;

      const required = ['stop', 'build', 'start', 'check'] as const;

      if (required.some((key) => !settings[key].trim())) {
        throw new CodeGitError(
          'branch_not_configured', 'Задайте команды остановки, сборки, запуска и проверки готовности.',
        );
      }

      const plan = await planCodeBranchSwitch(root, ref).catch((error: Error) => {
        throw new CodeGitError('branch_switch_refused', error.message);
      });

      if (plan.commit !== expected.commit || plan.beforeCommit !== expected.head) {
        throw new CodeGitError('branch_changed', 'Ветки изменились. Обновите список и подтвердите заново.');
      }

      // User scope отделяет worker от cgroup останавливаемого приложения.
      // Для собственного checkout без этой гарантии сервер не трогаем.
      const systemd = await execute('systemctl', ['--user', 'show-environment'], {
        timeout: 3_000,
      }).then(() => true, () => false);
      const serverRoot = this.serverRoot
        ? await fs.realpath(this.serverRoot).catch(() => this.serverRoot) : '';

      if (!systemd && serverRoot && (root === serverRoot || serverRoot.startsWith(`${root}${path.sep}`))) {
        throw new CodeGitError(
          'branch_self_runtime_unavailable',
          'Для переключения самого GrigDesk нужен доступный пользовательский systemd. Стенд не остановлен.',
        );
      }

      const id = randomUUID();
      const work = path.join(this.location(root), id);
      const job: CodeBranchJob = {
        id,
        status: 'running',
        step: 'checking',
        branch: plan.branch,
        commit: plan.commit,
        url: settings.url,
        startedAt: Date.now(),
        finishedAt: 0,
        message: '',
      };
      const input: BranchWorkerInput = {
        plan,
        settings,
        job,
      };

      await fs.mkdir(work, { recursive: true, mode: 0o700 });
      await writeJson(path.join(work, 'input.json'), input);
      await writeJson(path.join(work, 'job.json'), job);

      const helper = helperCommand('code-branch-worker', [work]);
      const source = helper.args[0]!;
      const script = path.join(work, `worker${path.extname(source)}`);

      await fs.copyFile(source, script);

      const log = await fs.open(path.join(work, 'output.log'), 'a', 0o600);

      try {
        const args = systemd ? [
          '--user', '--scope', '--quiet', `--unit=grigdesk-code-${id}`,
          helper.command, script, work,
        ] : [script, work];
        const child = spawn(systemd ? 'systemd-run' : helper.command, args, {
          cwd: work,
          detached: true,
          stdio: ['ignore', log.fd, log.fd, lock.inheritedFd()],
          env: process.env,
        });

        await new Promise<void>((resolve, reject) => {
          child.once('spawn', resolve);
          child.once('error', reject);
        });
        child.unref();

        await writeJson(path.join(this.location(root), 'current.json'), { id });
      } finally {
        await log.close();
      }
    } finally {
      this.launching.delete(root);
      await lock.release();
    }
  }
}
