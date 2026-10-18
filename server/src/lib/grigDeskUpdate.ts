import { config as runtimeConfig } from '../config.ts';

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACTIVE_UPDATE_STATUSES } from '../../../shared/runtime/grigDeskUpdateContracts.ts';
import {
  GrigDeskReleaseError,
  defaultCommandRunner,
  mutatePersistentState,
  parseStableTag,
  readPersistentState,
} from './grigDeskRelease.ts';
import type {
  GrigDeskReleaseService,
  CommandRunner,
  UpdateJob,
} from './grigDeskRelease.ts';

const ACTIVE = new Set<string>(ACTIVE_UPDATE_STATUSES);
const WORKER_PATH = fileURLToPath(new URL('../workers/grigdesk-update-worker.js', import.meta.url));

function assertExpectedSha(value: unknown): void {
  if (!/^[0-9a-f]{40,64}$/i.test(String(value || ''))) {
    throw new GrigDeskReleaseError('invalid_checkout_sha', 'Некорректная ожидаемая ревизия.', 400);
  }
}

function reasonMessage(reason: string): string {
  const messages: Record<string, string> = {
    working_tree_dirty: 'Рабочее дерево содержит локальные изменения.',
    update_in_progress: 'Другое обновление GrigDesk уже выполняется.',
    branch_not_main: 'Установка релиза разрешена только в ветке main.',
    detached_head: 'Установка релиза недоступна в detached HEAD.',
    checkout_ahead: 'Текущая main опережает выбранный релиз.',
    checkout_diverged: 'История main расходится с выбранным релизом.',
    no_release_checked: 'Сначала проверьте опубликованные релизы.',
    checkout_at_release: 'Выбранный релиз уже находится в checkout.',
    release_not_newer: 'Выбранный релиз не новее запущенной версии.',
  };
  return messages[reason] || 'Обновление заблокировано текущим состоянием checkout.';
}

export interface GrigDeskUpdateManagerOptions {
  releases: GrigDeskReleaseService;
  rootDir: string;
  statePath: string;
  runner?: CommandRunner;
  spawnProcess?: typeof spawn;
  underSystemd?: () => boolean;
  desktop?: () => boolean;
  origin?: string;
  cliTokenPath?: string;
}

export class GrigDeskUpdateManager {
  private readonly releases: GrigDeskReleaseService;

  private readonly rootDir: string;

  private readonly statePath: string;

  private readonly runner: CommandRunner;

  private readonly spawnProcess: typeof spawn;

  private readonly underSystemd: () => boolean;

  private readonly desktop: () => boolean;

  private readonly origin: string | undefined;

  private readonly cliTokenPath: string | undefined;

  private readonly jobLockPath: string;

  constructor({
    releases,
    rootDir,
    statePath,
    runner = defaultCommandRunner,
    spawnProcess = spawn,
    underSystemd = () => !!process.env.INVOCATION_ID,
    desktop = () => false,
    origin,
    cliTokenPath,
  }: GrigDeskUpdateManagerOptions) {
    this.releases = releases;
    this.rootDir = rootDir;
    this.statePath = statePath;
    this.runner = runner;
    this.spawnProcess = spawnProcess;
    this.underSystemd = underSystemd;
    this.desktop = desktop;
    this.origin = origin;
    this.cliTokenPath = cliTokenPath;
    this.jobLockPath = `${statePath}.job-lock`;
  }

  async getJob(): Promise<UpdateJob | null> {
    const job = (await readPersistentState(this.statePath)).job || null;
    if (job?.status !== 'restarting') return job;
    // Первый запрос после возвращения API должен сам подтвердить новый процесс; нельзя
    // полагаться на то, что параллельно уже открыли GET /version.
    return (await this.releases.getStatus({ fresh: true })).job;
  }

  /**
   * Сверяет запрос worker с сохранённым заданием перезапуска.
   * Проверка не подтверждает новый сервер через fresh-статус релизов.
   */
  async isRestarting(jobId: string): Promise<boolean> {
    const job = (await readPersistentState(this.statePath)).job;

    return job?.id === jobId && job.status === 'restarting';
  }

  async recover(): Promise<void> {
    const job = await this.getJob();
    if (!job || !ACTIVE.has(job.status) || job.status === 'restarting') return;
    let lockExists = false;
    try { await stat(this.jobLockPath); lockExists = true; } catch { /* lock отсутствует */ }
    let workerAlive = false;
    const workerPid = Number(job.workerPid);
    if (workerPid) {
      try { process.kill(workerPid, 0); workerAlive = true; } catch { /* PID уже завершился */ }
    }
    const age = Date.now() - new Date(String(job.updatedAt || job.createdAt || 0)).getTime();
    if (workerAlive || (lockExists && age < 2 * 60_000)) return;
    await mutatePersistentState(this.statePath, (state) => ({
      ...state,
      job: state.job?.id === job.id ? {
        ...state.job,
        status: 'failed', stage: 'failed', completedAt: new Date().toISOString(),
        error: { code: 'worker_disappeared', message: 'Worker обновления завершился без результата.' },
      } : state.job,
    }));
    await rm(this.jobLockPath, { recursive: true, force: true });
    this.releases.invalidate();
  }

  async assertIdle(): Promise<void> {
    const job = await this.getJob();
    if (ACTIVE.has(String(job?.status))) {
      throw new GrigDeskReleaseError('update_in_progress', reasonMessage('update_in_progress'), 409);
    }
  }

  async startApply({ expectedCheckoutSha, allowDirty = false }: {
    expectedCheckoutSha: string;
    allowDirty?: boolean;
  }): Promise<UpdateJob> {
    assertExpectedSha(expectedCheckoutSha);
    // allowDirty зарезервирован протоколом, но MVP намеренно не принимает его, пока
    // dirty-snapshot digest не сможет доказать неизменность каждого файла.
    if (allowDirty) {
      throw new GrigDeskReleaseError(
        'dirty_apply_not_supported',
        'Применение dirty checkout пока недоступно: сначала зафиксируйте изменения.',
        409,
      );
    }
    return this.#start('apply', { expectedCheckoutSha: expectedCheckoutSha.toLowerCase() });
  }

  async startUpdate({ targetTag, expectedCheckoutSha }: {
    targetTag: string;
    expectedCheckoutSha: string;
  }): Promise<UpdateJob> {
    if (!parseStableTag(targetTag)) {
      throw new GrigDeskReleaseError('invalid_target_tag', 'Цель должна быть стабильным тегом vMAJOR.MINOR.PATCH.', 400);
    }
    assertExpectedSha(expectedCheckoutSha);
    return this.#start('update', { targetTag, expectedCheckoutSha: expectedCheckoutSha.toLowerCase() });
  }

  async #start(kind: 'apply' | 'update', request: {
    expectedCheckoutSha: string;
    targetTag?: string;
  }): Promise<UpdateJob> {
    let locked = false;
    await mkdir(path.dirname(this.statePath), { recursive: true });
    try {
      await mkdir(this.jobLockPath, { mode: 0o700 });
      locked = true;
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'EEXIST') {
        throw new GrigDeskReleaseError('update_in_progress', reasonMessage('update_in_progress'), 409);
      }
      throw error;
    }

    try {
      const status = await this.releases.getStatus({ fresh: true });
      if (ACTIVE.has(String(status.job?.status))) {
        throw new GrigDeskReleaseError('update_in_progress', reasonMessage('update_in_progress'), 409);
      }
      if (status.checkout.sha !== request.expectedCheckoutSha) {
        throw new GrigDeskReleaseError('checkout_changed', 'Checkout изменился после открытия подтверждения.', 409);
      }
      if (kind === 'apply') {
        const reason = status.applyBlockReasons?.[0];
        if (reason) throw new GrigDeskReleaseError(reason, reasonMessage(reason), 409);
      } else {
        if (status.latest?.tag !== request.targetTag) {
          throw new GrigDeskReleaseError('target_not_checked', 'Тег не совпадает с последним проверенным релизом.', 409);
        }
        const reason = status.installBlockReasons?.[0];
        if (reason) throw new GrigDeskReleaseError(reason, reasonMessage(reason), 409);
      }

      const now = new Date().toISOString();
      // К этому месту `update` уже сверил тег с последней проверкой, поэтому релиз
      // известен; `apply` берёт цель из самого checkout и в него не заглядывает.
      const latest = status.latest;
      const job: UpdateJob = {
        id: randomUUID(),
        kind,
        status: 'queued',
        stage: 'queued',
        createdAt: now,
        updatedAt: now,
        targetSha: kind === 'update' ? latest?.sha ?? null : status.checkout.sha,
        targetVersion: kind === 'update' ? latest?.version ?? null : status.checkout.version,
        targetTag: kind === 'update' ? latest?.tag ?? null : null,
        expectedCheckoutSha: request.expectedCheckoutSha,
        previousRunningInstanceId: status.running.instanceId,
        error: null,
      };
      await writeFile(path.join(this.jobLockPath, 'owner.json'), `${JSON.stringify({ id: job.id })}\n`, { mode: 0o600 });
      await mutatePersistentState(this.statePath, (state) => ({ ...state, job }));
      await this.#launch(job);
      this.releases.invalidate();
      return job;
    } catch (error) {
      if (locked) await rm(this.jobLockPath, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * Выбирает владельца перезапуска и запускает worker прежним способом каждого режима.
   * Приложение получает только origin и путь токена, содержимое токена не входит в argv.
   */
  async #launch(job: UpdateJob): Promise<void> {
    const mode = this.desktop() ? 'desktop' : this.underSystemd() ? 'systemd' : 'script';
    const workerArgs = [
      WORKER_PATH,
      '--root', this.rootDir,
      '--work-root', path.join(this.rootDir, '.state'),
      '--state', this.statePath,
      '--job', job.id,
      '--mode', mode,
    ];

    if (mode === 'desktop') {
      workerArgs.push('--origin', this.origin ?? '', '--token-file', this.cliTokenPath ?? '');
    }

    if (mode === 'systemd') {
      const result = await this.runner('systemd-run', [
        '--user', '--collect', '--quiet',
        '--unit=grigdesk-update-worker',
        '--property=Type=exec',
        `--working-directory=${this.rootDir}`,
        `--setenv=GRIGDESK_HOME=${runtimeConfig.dataHome}`,
        `--setenv=PATH=${process.env.PATH || ''}`,
        process.execPath, ...workerArgs,
      ], { cwd: this.rootDir, timeout: 15_000, maxBuffer: 256 * 1024 });
      if (result.code !== 0) {
        await mutatePersistentState(this.statePath, (state) => ({
          ...state,
          job: state.job?.id === job.id ? {
            ...state.job,
            status: 'failed', stage: 'launch', updatedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            error: { code: 'worker_launch_failed', message: 'Не удалось запустить отдельный systemd worker.' },
          } : state.job,
        }));

        throw new GrigDeskReleaseError(
          'worker_launch_failed', 'Не удалось запустить worker обновления.', 503,
        );
      }
      return;
    }

    try {
      const child = this.spawnProcess(process.execPath, workerArgs, {
        cwd: this.rootDir,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    } catch {
      await mutatePersistentState(this.statePath, (state) => ({
        ...state,
        job: state.job?.id === job.id ? {
          ...state.job,
          status: 'failed', stage: 'launch', updatedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          error: { code: 'worker_launch_failed', message: 'Не удалось запустить worker обновления.' },
        } : state.job,
      }));

      throw new GrigDeskReleaseError(
        'worker_launch_failed', 'Не удалось запустить worker обновления.', 503,
      );
    }
  }
}
