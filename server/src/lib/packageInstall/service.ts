import { packagePolicy } from './packagePolicy.ts';
import type { PackageKind } from './packagePolicy.ts';
import type {
  PluginInstallErrorInfo,
  PluginInstallJob,
  PluginInstallInfo,
  PluginVersionRef,
  PluginSourceRef,
  PluginInstallRecord,
  PluginInstallPreview,
  PluginInstalledVersion,
} from '../../../../shared/plugins/pluginInstallContracts.ts';
import { isInstallSha } from '../../../../shared/plugins/pluginInstallValues.ts';
import { createDefaultPluginSources } from './sources.ts';
import type { PluginSourceRegistry } from './sources.ts';
import type { NpmRunner } from './npm.ts';
import { runCommand } from './runCommand.ts';
import type { PluginCommandRunner, PluginWorkspaceBudget } from './runCommand.ts';
import type { FastifyBaseLogger } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { acquireKernelFileLock } from '../kernelLock.ts';
import type { KernelFileLock } from '../kernelLock.ts';
import {
  PluginInstallStateStore,
  emptyInstallState,
  summarizeInstallJob,
  getRollbackReceipt,
} from './stateStore.ts';
import type {
  DirectoryIdentity,
  PluginInstallState,
  PluginApplyIntent,
  InstallBaseSnapshot,
} from './stateStore.ts';
import { errorInfo, installError } from './errors.ts';
import {
  readPluginManifest,
  validatePluginPackage,
  validatePreparedPluginPackage,
} from './validatePackage.ts';
import { createNpmRunner, prepareNpmDependencies } from './npm.ts';
import { computePayloadDigest } from './payloadDigest.ts';
import { safeGitConfigDigest } from './gitMetadata.ts';
import { isDeepStrictEqual } from 'node:util';
import { terminateOwnedWorker } from './workerIdentity.ts';
import type { ApplyFs } from './applyPackage.ts';
import { applyIntent, createApplyFs, recoverApply } from './applyPackage.ts';
import {
  installedSnapshot, installedWebModuleDir, sameSource, sensitivePluginFile,
} from './serviceSnapshots.ts';
import { compareSemVer } from '../releaseCommon.ts';
import { workspaceWithinBudget } from './workspaceBudget.ts';

export interface PluginRecoveryResult {
  blockedIds: string[] | '*';
  error: PluginInstallErrorInfo | null;
}

export interface PluginReplacementLease {
  finish(outcome: 'installed' | 'reverted' | 'blocked'): Promise<void>;
}

export interface PluginInstallRuntime {
  isLoaded(id: string): boolean;
  prepareReplace(id: string, signal: AbortSignal): Promise<PluginReplacementLease>;
  refresh(): Promise<void>;
}

export interface PluginInstallServiceOptions {
  packageKind?: PackageKind;
  pluginsDir: string;
  statePath: string;
  grigDeskVersion: string;
  reservedIds: readonly string[];
  sources?: PluginSourceRegistry;
  runNpm?: NpmRunner;
  now?: () => Date;
  stagingLimits?: Omit<PluginWorkspaceBudget, 'root'>;
  log?: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
}

interface CachedDescription {
  key: string;
  expiresAt: number;
  pending: Promise<PluginInstallInfo>;
}

export interface InstallRequest {
  url: unknown;
  version?: string;
  expectedSha?: string;
  expectedId?: string;
  replaceModified?: boolean;
}

export interface RollbackRequest {
  requestId: string;
  expectedRevision: number;
  expectedPreviousDigest: string;
}

export type PluginInstallPort = Pick<PluginInstallService,
  | 'bindRuntime' | 'recover' | 'health' | 'close' | 'describe' | 'listVersions'
  | 'startInstall' | 'startUpdate' | 'currentJob' | 'getJob' | 'apply' | 'cancel'
  | 'rollback' | 'checkUpdates' | 'restartRequired' | 'refreshCatalog'
>;

/**
 * Сервис владеет подготовкой пакета, admission и durable installer state.
 * Runtime binding задаёт отдельный допуск к будущей публикации.
 */
export class PluginInstallService {
  readonly options: PluginInstallServiceOptions;
  readonly workDir: string;
  readonly store: PluginInstallStateStore;
  private readonly sources: PluginSourceRegistry;
  private readonly npm: NpmRunner;
  private readonly now: () => Date;
  private readonly descriptions = new Map<string, CachedDescription>();
  private descriptionEpoch = 0;
  private readonly restarts = new Set<string>();
  private readonly reads = new Set<Promise<unknown>>();
  private readonly readWaiters: Array<() => void> = [];
  private readSlots = 0;
  private readonly run: PluginCommandRunner;
  private readonly commands = new Set<Promise<unknown>>();
  private readonly mutations = new Set<Promise<unknown>>();
  private readonly closingSignal = new AbortController();
  private state = emptyInstallState();
  private owner: KernelFileLock | null = null;
  private runtime: PluginInstallRuntime | null = null;
  private preparation: Promise<void> = Promise.resolve();
  private recovery: Promise<PluginRecoveryResult> | null = null;
  private closing: Promise<void> | null = null;
  private checking: Promise<Record<string, PluginInstallInfo>> | null = null;
  private catalogError: PluginInstallErrorInfo | null = null;
  private healthError: PluginInstallErrorInfo | null = null;
  private closed = false;
  private reserved = false;
  private operation: 'cancel' | 'apply' | 'rollback' | null = null;
  private generation = 0;
  private controller: AbortController | null = null;

  /**
   * Config и fixture seams передаются явно, без discovery настоящего state машины.
   * Сервис создаёт свои команды только после recover и owner lock.
   */
  constructor(options: PluginInstallServiceOptions) {
    this.options = options;
    this.workDir = path.join(options.pluginsDir, '.grigdesk-install');
    this.now = options.now ?? (() => new Date());
    this.store = new PluginInstallStateStore({
      statePath: options.statePath,
      hasWorkEvidence: () => this.hasWorkEvidence(),
    });

    // Единственный runner регистрирует identity до разрешения executable.
    // Finished удаляется только после подтверждённого отсутствия writers.
    const ownedRun: PluginCommandRunner = async (file, args, commandOptions) => {
      if (!this.owner) {
        throw installError('recovery_required');
      }

      this.owner.assertHeld();

      const signal = AbortSignal.any([
        this.closingSignal.signal,
        ...(commandOptions.signal ? [commandOptions.signal] : []),
      ]);
      const task = runCommand(file, args, {
        ...commandOptions,
        signal,
        ownership: {
          started: async (worker) => {
            await this.writeState((state) => {
              state.workers[worker.commandId] = worker;
            });
          },
          finished: async (commandId) => {
            await this.writeState((state) => {
              delete state.workers[commandId];
            });
          },
        },
      });

      this.commands.add(task);

      try {
        return await task;
      } finally {
        this.commands.delete(task);
      }
    };

    this.run = ownedRun;
    this.sources = options.sources ?? createDefaultPluginSources({ run: ownedRun });
    this.npm = options.runNpm ?? createNpmRunner(ownedRun);
  }

  /**
   * Startup должен подтвердить состояние до сканирования пользовательских плагинов.
   * Blocked ids позволяют сохранить работу ядра при повреждённом installer state.
   */
  async recover(): Promise<PluginRecoveryResult> {
    this.recovery ??= (async () => {
      try {
        this.owner = await acquireKernelFileLock({
          lockPath: path.join(this.workDir, 'owner.lock'),
          binary: '/usr/bin/flock',
          timeoutMs: 50,
          errorFactory: () => installError('recovery_required'),
        });
        this.state = await this.store.read();

        for (const worker of Object.values(this.state.workers)) {
          if (!await terminateOwnedWorker(worker)) {
            throw installError('recovery_required');
          }
        }

        if (Object.keys(this.state.workers).length > 0) {
          await this.writeState((state) => {
            state.workers = {};
          });
        }

        const fs = this.filesystem();

        for (const name of ['jobs', 'transactions', 'previous', 'replaced']) {
          await fs.ensureDir(path.join(this.workDir, name));
        }

        const resolved = await recoverApply(this.store, fs);

        this.state = await this.store.read();

        if (resolved.outcome === 'blocked') {
          this.healthError = resolved.error ?? errorInfo(installError('recovery_required'));
          this.reserved = true;

          return {
            blockedIds: this.healthError.code === 'state_invalid' ? '*'
              : this.state.apply ? [this.state.apply.pluginId] : '*',
            error: structuredClone(this.healthError),
          };
        }

        if (!this.state.apply && this.state.job
          && ['applying', 'recovery_required'].includes(this.state.job.status)) {
          const orphan = this.state.job;

          this.healthError = errorInfo(installError('recovery_required'));
          this.reserved = true;
          await this.updateJob(orphan.id, this.generation, (job) => {
            job.status = 'recovery_required';
            job.error = structuredClone(this.healthError);
          });

          return {
            blockedIds: orphan.pluginId ? [orphan.pluginId] : '*',
            error: structuredClone(this.healthError),
          };
        }

        const interrupted = this.state.job;

        if (!this.state.apply && interrupted && ['running', 'ready'].includes(interrupted.status)) {
          const candidate = path.join(this.workDir, 'jobs', interrupted.id, 'package');
          const identity = await fs.lstatIdentity(candidate).catch(() => null);

          await this.updateJob(interrupted.id, this.generation, (job) => {
            job.status = 'interrupted';
            job.error = errorInfo(installError('interrupted'));
            job.percent = null;
            job.finishedAt = this.now().toISOString();
            job.reviewToken = null;
          }, identity);
          await this.cleanupPreparation(interrupted.id).catch(() => {});
        }

        this.reserved = !!this.state.job
          && ['running', 'ready', 'applying', 'recovery_required'].includes(this.state.job.status);

        return { blockedIds: [], error: null };
      } catch (error) {
        this.healthError = errorInfo(error);

        return { blockedIds: '*' as const, error: this.healthError };
      }
    })();

    return this.recovery;
  }

  /**
   * Health публикует безопасный отказ отдельно от неизменного terminal outcome.
   * Вызывающий не получает mutable ссылку на внутреннюю ошибку.
   */
  health(): PluginInstallErrorInfo | null {
    return structuredClone(this.healthError ?? this.catalogError);
  }

  /**
   * Повторное обновление каталога не создаёт install transaction.
   * Runtime binding остаётся единственным владельцем scanner refresh.
   */
  async refreshCatalog(): Promise<void> {
    this.assertAvailable();

    if (!this.operation) {
      await this.readOperation(() => this.refreshRuntime());
    }
  }

  /**
   * Допущенная транзакция заканчивает refresh даже после закрытия admission.
   * Отказ каталога остаётся отдельным предупреждением после durable commit.
   */
  private async refreshRuntime(): Promise<void> {
    try {
      await this.runtime?.refresh();
      this.catalogError = null;
    } catch (error) {
      this.catalogError = errorInfo(error);
    }
  }

  /**
   * Module предоставляет runtime lease и обновление каталога после публикации.
   * Отсутствие binding не означает, что пользовательский код не загружен.
   */
  bindRuntime(runtime: PluginInstallRuntime): void {
    this.runtime = runtime;
  }

  /**
   * Публичный listing использует общий owned runner и read admission.
   * Close отменяет также команды без задания установки.
   */
  async listVersions(url: unknown): Promise<{ source: PluginSourceRef; versions: PluginVersionRef[] }> {
    this.assertAvailable();

    const selected = this.sources.forUrl(url);

    return this.readOperation(async () => ({
      source: { kind: selected.source.kind, url: selected.url },
      versions: await selected.source.listVersions(selected.url, this.closingSignal.signal),
    }));
  }

  /**
   * Локальная информация использует persisted record и не требует сети.
   * Проверка целостности и cache расширяются сервисными сценариями.
   */
  async describe(id: string): Promise<PluginInstallInfo | null> {
    this.assertAvailable();

    const record = this.state.plugins[id];

    if (!record) {
      return null;
    }

    const snapshot = structuredClone(record);
    const key = JSON.stringify(snapshot);
    const epoch = this.descriptionEpoch;
    let cached = this.descriptions.get(id);

    if (!cached || cached.key !== key || cached.expiresAt <= this.now().getTime()) {
      cached = {
        key,
        expiresAt: this.now().getTime() + 2000,
        pending: this.describeFresh(id, snapshot),
      };
      this.descriptions.set(id, cached);
    }

    const description = await cached.pending;

    if (epoch !== this.descriptionEpoch || JSON.stringify(this.state.plugins[id]) !== key) {
      return this.describe(id);
    }

    return structuredClone(description);
  }

  /**
   * Полная локальная проверка выполняется один раз для cache entry, без сети.
   * Внешние правки становятся видны после короткого TTL; preflight cache не использует.
   */
  private async describeFresh(id: string, record: PluginInstallRecord): Promise<PluginInstallInfo> {
    const localChanges = await this.copyModified(id, path.join(this.options.pluginsDir, id), record);
    let rollbackError: PluginInstallErrorInfo | null = null;

    if (record.previous) {
      if (await this.copyModified(id, path.join(this.workDir, 'previous', id), record.previous)) {
        rollbackError = errorInfo(installError('previous_modified'));
      } else if (localChanges) {
        rollbackError = errorInfo(installError('local_changes'));
      }
    }

    return {
      ...structuredClone(record),
      updateAvailable: !!record.latest && compareSemVer(record.latest.version, record.version) > 0,
      localChanges,
      restartRequired: this.restartRequired(id),
      rollbackAvailable: record.previous !== null && rollbackError === null,
      rollbackError,
    };
  }

  /**
   * Каркас проверки использует тот же read admission для persisted source.
   * Публикация результатов и CAS сверка добавляются следующим сервисным этапом.
   */
  async checkUpdates(): Promise<Record<string, PluginInstallInfo>> {
    this.assertAvailable();

    const pending = this.checking ??= this.performCheckUpdates();

    try {
      return structuredClone(await pending);
    } finally {
      if (this.checking === pending) {
        this.checking = null;
      }
    }
  }

  /**
   * Single-flight обращается к каждому captured source один раз через read admission.
   * CAS не позволяет поздней сети перезаписать установленный snapshot другой revision.
   */
  private async performCheckUpdates(): Promise<Record<string, PluginInstallInfo>> {
    this.assertAvailable();

    const captured = structuredClone(this.state.plugins);

    await Promise.all(Object.entries(captured).map(([id, record]) => this.readOperation(async () => {
      let latest: PluginVersionRef | null = null;
      let checkError: PluginInstallErrorInfo | null = null;

      try {
        const versions = await this.sources.get(record.source.kind)
          .listVersions(record.source.url, this.closingSignal.signal);

        latest = versions[0] ?? null;
      } catch (error) {
        checkError = errorInfo(error);
      }

      await this.writeState((state) => {
        const current = state.plugins[id];

        if (!current || current.revision !== record.revision || !sameSource(current.source, record.source)) {
          return;
        }

        if (!checkError) {
          current.latest = latest;
        }

        current.checkedAt = this.now().toISOString();
        current.checkError = checkError;
      });
    })));

    const result: Record<string, PluginInstallInfo> = {};

    for (const id of Object.keys(this.state.plugins)) {
      const info = await this.describe(id);

      if (info) {
        result[id] = info;
      }
    }

    return result;
  }

  /**
   * Сервис хранит restart flag только для runtime, затронутого публикацией.
   * Новый плагин ещё не имеет загруженного кода.
   */
  restartRequired(id: string): boolean {
    return this.restarts.has(id);
  }

  /**
   * Публикация выполняется с runtime lease и durable filesystem intent.
   * Повтор подтверждённого outcome не запускает файловый переход заново.
   */
  async apply(id: string, token: string): Promise<PluginInstallJob> {
    return this.mutation(() => this.performApply(id, token));
  }

  /**
   * Полная цепочка публикации принадлежит lifetime сервиса до последнего callback.
   * Mutex резервируется до внешнего await и не освобождается при начале close.
   */
  private async performApply(id: string, token: string): Promise<PluginInstallJob> {
    this.assertAvailable();

    if (!this.runtime) {
      throw installError('recovery_required');
    }

    const job = this.state.job?.id === id ? structuredClone(this.state.job)
      : Object.hasOwn(this.state.completedJobs, id) ? structuredClone(this.state.completedJobs[id]) : null;

    if (!job) {
      throw installError('job_not_found');
    }

    if (!['ready', 'done'].includes(job.status)) {
      throw installError('job_not_ready');
    }

    if (job.reviewToken !== token) {
      throw installError('preview_stale');
    }

    if (job.status === 'done') {
      return job;
    }

    if (!job.pluginId || !job.target) {
      throw installError('job_not_ready');
    }

    if (this.operation) {
      throw installError('install_busy');
    }

    this.operation = 'apply';

    const pluginId = job.pluginId;
    const wasLoaded = this.runtime.isLoaded(pluginId);
    const fs = this.filesystem();
    let lease: PluginReplacementLease | null = null;
    let effectStarted = false;

    try {
      lease = await this.runtime.prepareReplace(pluginId, this.closingSignal.signal);

      const disk = await this.store.read();
      const prepared = disk.prepared;
      const directory = path.join(this.workDir, 'jobs', id, 'package');

      if (!prepared || prepared.jobId !== id) {
        throw installError('preview_stale');
      }

      const validated = await validatePreparedPluginPackage(directory, {
        packageKind: this.options.packageKind,
        version: job.target.version,
        expectedId: pluginId,
        reservedIds: new Set(this.options.reservedIds),
        grigDeskVersion: this.options.grigDeskVersion,
      }).catch(() => {
        throw installError('preview_stale');
      });
      const candidate = await fs.lstatIdentity(directory, validated.npmDirs);
      const base = prepared.baseSnapshot;
      const current = await fs.lstatIdentity(
        path.join(this.options.pluginsDir, pluginId), base.record?.npmDirs,
      );
      const previous = base.record?.previous
        ? await fs.lstatIdentity(
          path.join(this.workDir, 'previous', pluginId), base.record.previous.npmDirs,
        ) : null;

      if (!candidate || candidate.payloadDigest !== prepared.candidateDigest
        || !isDeepStrictEqual(current, base.current)
        || !isDeepStrictEqual(previous, base.previous)
        || !isDeepStrictEqual(disk.plugins[pluginId] ?? null, base.record)) {
        throw installError('preview_stale');
      }

      const configDigest = await safeGitConfigDigest(directory);
      const targetRecord: PluginInstallRecord = {
        source: structuredClone(job.source),
        version: job.target.version,
        tag: job.target.tag,
        sha: job.target.sha,
        installedAt: this.now().toISOString(),
        payloadDigest: prepared.candidateDigest,
        gitConfigDigest: configDigest ?? createHash('sha256').update(job.source.kind).digest('hex'),
        npmDirs: validated.npmDirs,
        revision: disk.nextRevision,
        previous: base.record ? current?.payloadDigest === base.record.payloadDigest
          ? installedSnapshot(base.record) : structuredClone(base.record.previous) : null,
        latest: prepared.latest,
        checkedAt: this.now().toISOString(),
        checkError: null,
      };
      const inspection = await this.sources.get(job.source.kind).inspectInstalled(directory, targetRecord);

      if (inspection.modified || inspection.sha !== job.target.sha) {
        throw installError('preview_stale');
      }

      await this.writeState((state) => {
        targetRecord.revision = state.nextRevision++;
      });

      const cleanManaged = base.record !== null && current?.payloadDigest === base.record.payloadDigest;
      const destination = current ? cleanManaged ? 'previous' : 'replaced' : 'none';
      const transactionId = randomUUID();
      const intent: PluginApplyIntent = {
        transactionId,
        pluginId,
        jobId: id,
        kind: job.kind,
        baseRecord: base.record,
        targetRecord,
        destination,
        current,
        candidate,
        previous,
        reviewToken: token,
        phase: 'prepared',
        rollbackReceiptInput: null,
        archiveKey: destination === 'replaced'
          ? `${pluginId}-${this.now().toISOString().replace(/[-:.]/gu, '')}-${transactionId}` : null,
      };

      effectStarted = true;

      return await this.publishReplacement(intent, fs, lease, wasLoaded);
    } catch (error) {
      if (lease && !effectStarted) {
        await lease.finish('reverted');
      }

      throw error;
    } finally {
      this.operation = null;
    }
  }

  /**
   * Публикация завершает durable замену и runtime lease в едином порядке.
   * Вызывающий метод удерживает operation до finish и refresh через return await.
   */
  private async publishReplacement(
    intent: PluginApplyIntent,
    fs: ApplyFs,
    lease: PluginReplacementLease,
    wasLoaded: boolean,
  ): Promise<PluginInstallJob> {
    const outcome = await applyIntent(intent, this.store, fs);

    this.state = await this.store.read();
    this.invalidateDescriptions();

    if (outcome.outcome === 'completed'
      && (wasLoaded || packagePolicy(this.options.packageKind).restartOnly)) {
      this.restarts.add(intent.pluginId);
    }

    await lease.finish(outcome.outcome === 'completed' ? 'installed'
      : outcome.outcome === 'reverted' ? 'reverted' : 'blocked');
    this.reserved = outcome.outcome === 'blocked';

    if (outcome.outcome === 'blocked') {
      this.healthError = errorInfo(installError('recovery_required'));
    }

    if (outcome.outcome === 'completed') {
      await this.refreshRuntime();
    }

    return structuredClone(this.state.job!);
  }

  /**
   * Откат требует тот же runtime binding до любого filesystem эффекта.
   * Durable receipt и preflight реализуются следующим этапом.
   */
  async rollback(id: string, request: RollbackRequest): Promise<PluginInstallJob> {
    return this.mutation(() => this.performRollback(id, request));
  }

  /**
   * Receipt и filesystem outcome завершаются под тем же lifetime, что apply.
   * Закрытие admission не теряет уже начатую перестановку current/previous.
   */
  private async performRollback(id: string, request: RollbackRequest): Promise<PluginInstallJob> {
    this.assertAvailable();

    if (!this.runtime) {
      throw installError('recovery_required');
    }

    const input = {
      requestId: request.requestId,
      inputHash: createHash('sha256').update(JSON.stringify({
        id,
        requestId: request.requestId,
        expectedRevision: request.expectedRevision,
        expectedPreviousDigest: request.expectedPreviousDigest,
      })).digest('hex'),
      baseRevision: request.expectedRevision,
    };
    const repeated = getRollbackReceipt(this.state, id, input);

    if (repeated) {
      return repeated;
    }

    if (this.reserved || this.operation) {
      throw installError('install_busy');
    }

    const record = this.state.plugins[id];

    if (!record) {
      throw installError('not_managed');
    }

    if (!record.previous) {
      throw installError('no_previous');
    }

    if (record.revision !== request.expectedRevision
      || record.previous.payloadDigest !== request.expectedPreviousDigest) {
      throw installError('preview_stale');
    }

    this.operation = 'rollback';

    const currentDir = path.join(this.options.pluginsDir, id);
    const previousDir = path.join(this.workDir, 'previous', id);
    const fs = this.filesystem();
    const wasLoaded = this.runtime.isLoaded(id);
    let lease: PluginReplacementLease | null = null;
    let effectStarted = false;

    try {
      if (await this.copyModified(id, currentDir, record)) {
        throw installError('local_changes');
      }

      if (await this.copyModified(id, previousDir, record.previous)) {
        throw installError('previous_modified');
      }

      const current = await fs.lstatIdentity(currentDir, record.npmDirs);
      const candidate = await fs.lstatIdentity(previousDir, record.previous.npmDirs);

      if (!current || !candidate) {
        throw installError('previous_modified');
      }

      lease = await this.runtime.prepareReplace(id, this.closingSignal.signal);

      const disk = await this.store.read();

      if (!isDeepStrictEqual(disk.plugins[id], record)
        || !isDeepStrictEqual(await fs.lstatIdentity(currentDir, record.npmDirs), current)
        || !isDeepStrictEqual(await fs.lstatIdentity(previousDir, record.previous.npmDirs), candidate)
        || await this.copyModified(id, currentDir, record)
        || await this.copyModified(id, previousDir, record.previous)) {
        throw installError('preview_stale');
      }

      const targetRecord: PluginInstallRecord = {
        ...structuredClone(record.previous),
        revision: disk.nextRevision,
        previous: installedSnapshot(record),
        latest: sameSource(record.source, record.previous.source) ? record.latest : null,
        checkedAt: sameSource(record.source, record.previous.source) ? record.checkedAt : null,
        checkError: sameSource(record.source, record.previous.source) ? record.checkError : null,
      };
      const manifest = await readPluginManifest(previousDir, this.options.packageKind);
      const time = this.now().toISOString();
      const target: PluginVersionRef = {
        version: targetRecord.version,
        tag: targetRecord.tag,
        sha: targetRecord.sha,
      };
      const token = createHash('sha256').update(JSON.stringify({
        input,
        current,
        candidate,
      })).digest('hex');
      const job: PluginInstallJob = {
        id: randomUUID(),
        kind: 'rollback',
        pluginId: id,
        source: structuredClone(targetRecord.source),
        target,
        replaceModified: false,
        status: 'ready',
        stage: null,
        percent: null,
        preview: {
          source: structuredClone(targetRecord.source),
          target,
          id,
          name: String(manifest[packagePolicy(this.options.packageKind).nameField] ?? id),
          version: targetRecord.version,
          description: typeof manifest.description === 'string' ? manifest.description : '',
          hasServer: this.options.packageKind === 'db-engine',
          hasWeb: typeof manifest.web === 'string' && manifest.web !== '',
          replaces: {
            kind: 'managed',
            version: record.version,
            sourceChanged: !sameSource(record.source, targetRecord.source),
          },
          changes: null,
          warnings: [],
        },
        error: null,
        createdAt: time,
        updatedAt: time,
        finishedAt: null,
        revision: disk.nextRevision,
        reviewToken: token,
        backupRef: null,
      };

      await this.writeState((state) => {
        targetRecord.revision = state.nextRevision++;
        job.revision = state.nextRevision++;
        state.job = structuredClone(job);
        state.prepared = null;
      });

      const intent: PluginApplyIntent = {
        transactionId: randomUUID(),
        pluginId: id,
        jobId: job.id,
        kind: 'rollback',
        baseRecord: record,
        targetRecord,
        destination: 'previous',
        current,
        candidate,
        previous: candidate,
        reviewToken: token,
        phase: 'prepared',
        rollbackReceiptInput: input,
        archiveKey: null,
      };

      effectStarted = true;

      return await this.publishReplacement(intent, fs, lease, wasLoaded);
    } catch (error) {
      if (lease && !effectStarted) {
        await lease.finish('reverted');
      }

      throw error;
    } finally {
      this.operation = null;
    }
  }

  /**
   * Запрос возвращает running job, а подготовка продолжается за admission mutex.
   * Ready сохраняет candidate отдельно от каталога текущих плагинов.
   */
  async startInstall(request: InstallRequest): Promise<PluginInstallJob> {
    return this.mutation(() => this.start(request, 'install'));
  }

  /**
   * Install и update имеют общий синхронный admission до внешних await.
   * Persisted kind выбирает source напрямую, без повторного URL discovery.
   */
  private async start(
    request: InstallRequest,
    kind: 'install' | 'update',
    sourceKind?: string,
  ): Promise<PluginInstallJob> {
    this.assertOpen();

    if (request.expectedSha !== undefined && (!isInstallSha(request.expectedSha) || !request.version)) {
      throw installError('version_invalid');
    }

    const known = sourceKind ? this.sources.get(sourceKind) : null;
    const selected = known ? { source: known, url: known.normalizeUrl(request.url) }
      : this.sources.forUrl(request.url);

    if (!this.owner || this.healthError) {
      throw installError(this.healthError?.code ?? 'recovery_required');
    }

    if (this.reserved || this.operation) {
      throw installError('install_busy');
    }

    this.reserved = true;
    this.generation += 1;
    this.controller = new AbortController();

    const generation = this.generation;
    const controller = this.controller;
    const time = this.now().toISOString();
    const initial: PluginInstallJob = {
      id: randomUUID(),
      kind,
      pluginId: request.expectedId ?? null,
      source: { kind: selected.source.kind, url: selected.url },
      target: null,
      replaceModified: request.replaceModified ?? false,
      status: 'running',
      stage: 'fetching',
      percent: 0,
      preview: null,
      error: null,
      createdAt: time,
      updatedAt: time,
      finishedAt: null,
      revision: 1,
      reviewToken: null,
      backupRef: null,
    };

    await this.writeState((state) => {
      initial.revision = state.nextRevision++;
      state.job = structuredClone(initial);
      state.prepared = null;
    });
    await mkdir(path.join(this.workDir, 'jobs', initial.id), { recursive: true, mode: 0o700 });

    this.preparation = this.prepare(initial, request, generation, controller);

    return structuredClone(initial);
  }

  /**
   * Обновление использует сохранённый source, а не адрес из HTTP.
   * Общий admission защищает его вместе с установкой по URL.
   */
  async startUpdate(
    id: string,
    request: Omit<InstallRequest, 'url' | 'expectedId'> = {},
  ): Promise<PluginInstallJob> {
    return this.mutation(() => this.performStartUpdate(id, request));
  }

  /**
   * Admission update учитывается до публикации running и запуска подготовки.
   * Close ждёт эту запись, даже если preparation promise ещё не назначен.
   */
  private async performStartUpdate(
    id: string,
    request: Omit<InstallRequest, 'url' | 'expectedId'>,
  ): Promise<PluginInstallJob> {
    this.assertOpen();

    const record = this.state.plugins[id];

    if (!record) {
      throw installError('not_managed');
    }

    return this.start({
      ...request,
      url: record.source.url,
      expectedId: id,
    }, 'update', record.source.kind);
  }

  /**
   * Fixture дожидается всех шагов подготовки через явное promise, без sleeps.
   * Никакой callback прежнего job не должен писать после завершения этой цепочки.
   */
  async whenIdle(): Promise<void> {
    await this.preparation;
  }

  /**
   * Публичный job возвращается независимым DTO для polling и сверки outcome.
   * Caller не получает mutable ссылки на состояние сервиса.
   */
  async currentJob(): Promise<PluginInstallJob | null> {
    this.assertOpen();

    return structuredClone(this.state.job);
  }

  /**
   * Job by id нужен для reconciliation, даже если current job уже сменился.
   * Сохранённый terminal summary удерживается отдельно от live job.
   */
  async getJob(id: string): Promise<PluginInstallJob> {
    this.assertOpen();

    const job = this.state.job?.id === id ? this.state.job
      : Object.hasOwn(this.state.completedJobs, id) ? this.state.completedJobs[id] : null;

    if (!job) {
      throw installError('job_not_found');
    }

    return structuredClone(job);
  }

  /**
   * Явная отмена освобождает ready slot после durable outcome и разрешённой уборки.
   * Applying и recovery_required не превращаются в безусловную отмену.
   */
  async cancel(id: string): Promise<PluginInstallJob> {
    return this.mutation(() => this.performCancel(id));
  }

  /**
   * Отмена удерживает owner до завершения подготовки и записи своего outcome.
   * Её поздняя уборка не может пересечь освобождение lock при close.
   */
  private async performCancel(id: string): Promise<PluginInstallJob> {
    this.assertOpen();

    const job = this.state.job;

    if (!job || job.id !== id) {
      throw installError('job_not_found');
    }

    if (['done', 'failed', 'cancelled', 'interrupted'].includes(job.status)) {
      return structuredClone(job);
    }

    if (this.operation) {
      throw installError('install_busy');
    }

    if (!['running', 'ready'].includes(job.status)) {
      throw installError('job_not_ready');
    }

    this.operation = 'cancel';
    this.generation += 1;
    this.controller?.abort();

    try {
      await this.preparation;

      const fs = this.filesystem();
      const packageIdentity = await fs.lstatIdentity(path.join(this.workDir, 'jobs', id, 'package'));

      await this.updateJob(id, this.generation, (current) => {
        current.status = 'cancelled';
        current.error = errorInfo(installError('cancelled'));
        current.percent = null;
        current.finishedAt = this.now().toISOString();
        current.reviewToken = null;
      }, packageIdentity);
      await this.cleanupPreparation(id).catch(() => {});
      this.reserved = this.healthError !== null;

      return structuredClone(this.state.job!);
    } finally {
      this.operation = null;
    }
  }

  /**
   * Close дожидается owned commands, callbacks и durable writes до unlock.
   * Вызов идемпотентен и запрещает новые действия с самого начала.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.closingSignal.abort();
    this.controller?.abort();
    this.closing ??= (async () => {
      await this.recovery;
      await Promise.allSettled([...this.mutations]);
      await this.preparation;
      await Promise.allSettled(this.checking ? [this.checking] : []);
      await Promise.allSettled([...this.reads]);
      await Promise.allSettled([...this.commands]);

      if (this.owner) {
        await this.owner.assertPathIdentity();

        const disk = await this.store.read();

        if (this.healthError || Object.keys(disk.workers).length > 0 || disk.apply) {
          throw installError('recovery_required');
        }

        await this.owner.release();
        this.owner = null;
      }
    })();

    return this.closing;
  }

  /**
   * Source fetch и package validation готовят preview, не импортируя server.js.
   * Все публичные переходы сохраняются только для текущего job/generation.
   */
  private async prepare(
    initial: PluginInstallJob,
    request: InstallRequest,
    generation: number,
    controller: AbortController,
  ): Promise<void> {
    const source = this.sources.get(initial.source.kind);
    const root = path.join(this.workDir, 'jobs', initial.id);
    const directory = path.join(root, 'package');
    const budget: PluginWorkspaceBudget = {
      root,
      maxBytes: 1024 * 1024 * 1024,
      minFreeBytes: 256 * 1024 * 1024,
      checkIntervalMs: 100,
      ...this.options.stagingLimits,
    };

    let deadlineExpired = false;
    const deadline = setTimeout(() => {
      deadlineExpired = true;
      controller.abort();
    }, 20 * 60 * 1000);

    try {
      const versions = await source.listVersions(initial.source.url, controller.signal);
      const target = request.version
        ? versions.find((version) => version.version === request.version) : versions[0];

      if (!target) {
        throw installError(versions.length === 0 ? 'source_no_versions' : 'version_not_found');
      }

      if (request.expectedSha !== undefined && request.expectedSha !== target.sha) {
        throw installError('checkout_mismatch');
      }

      await this.updateJob(initial.id, generation, (job) => {
        job.target = target;
      });
      await mkdir(root, { recursive: true, mode: 0o700 });
      await source.fetch({
        url: initial.source.url,
        target,
        destination: directory,
        signal: controller.signal,
        workspaceBudget: budget,
        onProgress: (percent) => {
          const job = this.state.job;

          if (!this.closed && this.generation === generation
            && job?.id === initial.id && job.status === 'running') {
            job.percent = percent;
          }
        },
      });

      if (!await workspaceWithinBudget(budget)) {
        throw installError('workspace_limit');
      }

      await this.updateJob(initial.id, generation, (job) => {
        job.stage = 'validating';
        job.percent = null;
      });

      const validated = await validatePluginPackage(directory, {
        packageKind: this.options.packageKind,
        version: target.version,
        expectedId: request.expectedId ?? null,
        reservedIds: new Set(this.options.reservedIds),
        grigDeskVersion: this.options.grigDeskVersion,
      });

      const fs = this.filesystem();
      const disk = await this.store.read();
      const record = disk.plugins[validated.id] ?? null;
      const current = await fs.lstatIdentity(
        path.join(this.options.pluginsDir, validated.id), record?.npmDirs,
      );
      const previous = record?.previous
        ? await fs.lstatIdentity(
          path.join(this.workDir, 'previous', validated.id), record.previous.npmDirs,
        ) : null;

      if (record?.previous
        && await this.copyModified(
          validated.id, path.join(this.workDir, 'previous', validated.id), record.previous,
        )) {
        throw installError('previous_modified');
      }

      const localChanges = record !== null && (!current || current.payloadDigest !== record.payloadDigest
        || await this.copyModified(validated.id, path.join(this.options.pluginsDir, validated.id), record));

      if (localChanges && !initial.replaceModified) {
        throw installError('local_changes');
      }

      if (record && sameSource(record.source, initial.source)
        && record.sha === target.sha && !initial.replaceModified) {
        throw installError('version_installed');
      }

      const baseSnapshot: InstallBaseSnapshot = {
        record: structuredClone(record),
        current,
        previous,
      };

      await this.updateJob(initial.id, generation, (job) => {
        job.stage = 'dependencies';
      });

      const candidateDigest = await prepareNpmDependencies(
        directory, validated.npmDirs, validated.webDir, this.npm, controller.signal, budget,
      );
      const preview: PluginInstallPreview = {
        source: initial.source,
        target,
        id: validated.id,
        name: validated.name,
        version: validated.version,
        description: validated.description,
        hasServer: validated.hasServer,
        hasWeb: validated.webDir !== null || validated.webModuleDir !== null,
        replaces: record ? {
          kind: 'managed',
          version: record.version,
          sourceChanged: !sameSource(record.source, initial.source),
        } : current ? { kind: 'unmanaged' } : { kind: 'none' },
        changes: null,
        warnings: validated.hasServer ? [...packagePolicy(this.options.packageKind).warnings] : [],
      };

      if (validated.webModuleDir !== null) {
        preview.warnings.push('Модуль интерфейса исполняется в главном окне GrigDesk '
          + 'с вашей сессией и может обращаться к любому API GrigDesk.');
      }

      if (record) {
        const changes = await source.changes(directory, record.sha, target.sha);
        const previousModuleDir = this.options.packageKind === 'db-engine' ? null
          : await installedWebModuleDir(path.join(this.options.pluginsDir, validated.id));
        const moduleDirs = [validated.webModuleDir, previousModuleDir]
          .filter((dir): dir is string => dir !== null);

        preview.changes = changes ? {
          ...changes,
          sensitive: changes.files.filter((file) =>
            sensitivePluginFile(file.path, validated.webDir, moduleDirs))
            .map((file) => file.path),
        } : null;
      }

      if (record && !sameSource(record.source, initial.source)) {
        preview.warnings.push('Источник плагина изменится. Проверьте адрес нового источника.');
      }

      if (record && !preview.changes) {
        preview.warnings.push('Старая история недоступна; список изменений получить не удалось.');
      }

      if (record && compareSemVer(target.version, record.version) < 0) {
        preview.warnings.push('Выбрана более старая версия: это понижение версии плагина.');
      }

      if (record && !current) {
        preview.warnings.push(
          'Установленная папка отсутствует: она была удалена вручную. Версия будет восстановлена.',
        );
      } else if (localChanges) {
        preview.warnings.push('Ручные правки будут перенесены в резерв replaced.');
      }

      if (current && !record) {
        preview.warnings.push('Ручная папка плагина будет сохранена в резерве replaced.');
      }

      const token = createHash('sha256').update(JSON.stringify({
        jobId: initial.id,
        source: initial.source,
        target,
        validated,
        baseSnapshot,
        candidateDigest,
      })).digest('hex');

      await this.writeState((state) => {
        const job = state.job;

        if (this.generation !== generation || job?.id !== initial.id || controller.signal.aborted) {
          throw installError('cancelled');
        }

        job.status = 'ready';
        job.pluginId = validated.id;
        job.stage = null;
        job.percent = null;
        job.preview = preview;
        job.reviewToken = token;
        job.revision = state.nextRevision++;
        job.updatedAt = this.now().toISOString();
        state.prepared = {
          jobId: job.id,
          baseSnapshot,
          candidateDigest,
          latest: versions[0] ?? null,
        };
      });
    } catch (error) {
      const fs = this.filesystem();
      const packageIdentity = await fs.lstatIdentity(directory).catch(() => null);

      await this.updateJob(initial.id, generation, (job) => {
        const safe = errorInfo(deadlineExpired ? installError('source_timeout') : error);

        job.status = safe.code === 'cancelled' ? 'cancelled' : 'failed';
        job.error = safe;
        job.percent = null;
        job.finishedAt = this.now().toISOString();
      }, packageIdentity).catch(() => {});
      await this.cleanupPreparation(initial.id).catch(() => {});
      this.reserved = this.healthError !== null;
    } finally {
      clearTimeout(deadline);
    }
  }

  /**
   * Durable write обновляет cache лишь после устойчивой публикации.
   * Ошибка store блокирует дальнейшие операции, не разрешая silent cleanup.
   */
  private async writeState(change: (state: PluginInstallState) => void): Promise<void> {
    try {
      if (!this.owner) {
        throw installError('recovery_required');
      }

      await this.owner.assertPathIdentity();

      const previous = this.state;
      const next = await this.store.mutate(change);

      if (JSON.stringify(previous.plugins) !== JSON.stringify(next.plugins)
        || previous.job?.id !== next.job?.id || previous.job?.revision !== next.job?.revision) {
        this.invalidateDescriptions();
      }

      this.state = next;
    } catch (error) {
      this.healthError = errorInfo(installError('recovery_required'));

      throw error;
    }
  }

  /**
   * Generation и job id проверяются внутри storage serialization перед изменением.
   * Отложенный callback прежнего job не может обновить новый публичный snapshot.
   */
  private async updateJob(
    id: string,
    generation: number,
    change: (job: PluginInstallJob) => void,
    cleanupPackage?: DirectoryIdentity | null,
  ): Promise<void> {
    await this.writeState((state) => {
      if (this.generation !== generation || state.job?.id !== id) {
        return;
      }

      change(state.job);
      state.job.revision = state.nextRevision++;
      state.job.updatedAt = this.now().toISOString();

      if (['failed', 'cancelled', 'interrupted'].includes(state.job.status)) {
        state.prepared = null;
        state.completedJobs[id] = summarizeInstallJob(state.job);
        state.cleanup.push({
          kind: 'job',
          jobId: id,
          package: cleanupPackage ?? null,
        });
      }
    });
  }

  /**
   * Только terminal job и отсутствие незавершённых workers дают разрешение cleanup.
   * Ошибка удаления оставляет durable entry и не отменяет сохранённый outcome.
   */
  private async cleanupPreparation(id: string): Promise<void> {
    const state = await this.store.read();

    if (this.healthError || Object.keys(state.workers).length > 0 || state.apply) {
      throw installError('recovery_required');
    }

    const fs = this.filesystem();

    for (const entry of state.cleanup.filter((entry) => entry.kind === 'job' && entry.jobId === id)) {
      await fs.removeCleanup(entry);
      await this.writeState((next) => {
        next.cleanup = next.cleanup.filter((candidate) => candidate.kind !== 'job' || candidate.jobId !== id);
      });
    }
  }

  /**
   * Отсутствующий state не допускается при любых остатках work кроме пустых roots/owner.lock.
   * Метод только читает, все неизвестные следы сохраняются для recovery.
   */
  private async hasWorkEvidence(): Promise<boolean> {
    const entries = await readdir(this.workDir, { withFileTypes: true })
      .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return [];
      }

      throw error;
    });

    for (const entry of entries) {
      if (entry.name === 'owner.lock') {
        continue;
      }

      if (!['jobs', 'transactions', 'previous', 'replaced'].includes(entry.name) || !entry.isDirectory()
        || (await readdir(path.join(this.workDir, entry.name))).length > 0) {
        return true;
      }
    }

    return false;
  }

  /**
   * Собственные изменения не ждут истечения TTL и не принимают поздний старый cache.
   * Registry-only writes не вызывают invalidation и не превращают GET в повторный Git обход.
   */
  private invalidateDescriptions(): void {
    this.descriptionEpoch += 1;
    this.descriptions.clear();
  }

  /**
   * Все service preflight и transaction effects используют одну native filesystem границу.
   * Fixture может удержать или отказать конкретный эффект без подмены resolver.
   */
  private filesystem(): ApplyFs {
    return createApplyFs({ pluginsDir: this.options.pluginsDir, workDir: this.workDir });
  }

  /**
   * Целостность установленной копии включает manifest, metadata и generated dependencies.
   * Ошибка локального чтения считается правкой и не разрешает потерю старой копии.
   */
  private async copyModified(
    id: string,
    directory: string,
    expected: PluginInstalledVersion,
  ): Promise<boolean> {
    try {
      return await this.readOperation(async () => {
        const digest = await computePayloadDigest(directory, expected.npmDirs);
        const manifest = await readPluginManifest(directory, this.options.packageKind);

        if (digest !== expected.payloadDigest
          || manifest.id !== id || (this.options.packageKind === 'db-engine'
            ? manifest.version !== undefined && manifest.version !== expected.version
            : manifest.version !== expected.version)) {
          return true;
        }

        const inspected = await this.sources.get(expected.source.kind).inspectInstalled(directory, expected);

        return inspected.modified || inspected.sha !== expected.sha;
      });
    } catch {
      return true;
    }
  }

  /**
   * До двух source reads выполняются одновременно, ожидание также принадлежит сервису.
   * Закрытие admission отменяет очередь до запуска следующего subprocess.
   */
  private async readOperation<T>(read: () => Promise<T>): Promise<T> {
    const task = (async () => {
      if (this.readSlots >= 2) {
        await new Promise<void>((resolve) => this.readWaiters.push(resolve));
      } else {
        this.readSlots += 1;
      }

      try {
        this.assertOpen();

        return await read();
      } finally {
        const next = this.readWaiters.shift();

        if (next) {
          next();
        } else {
          this.readSlots -= 1;
        }
      }
    })();

    this.reads.add(task);

    try {
      return await task;
    } finally {
      this.reads.delete(task);
    }
  }

  /**
   * Factory начинает синхронный admission прежде добавления promise в lifetime.
   * Все допущенные мутации завершаются до owner unlock, включая ошибочные исходы.
   */
  private async mutation<T>(work: () => Promise<T>): Promise<T> {
    const task = work();

    this.mutations.add(task);

    try {
      return await task;
    } finally {
      this.mutations.delete(task);
    }
  }

  /**
   * Read и mutation допускаются только при взятом owner lock и здоровом state.
   * Потеря durable состояния не становится новым пустым installer.
   */
  private assertAvailable(): void {
    this.assertOpen();

    if (!this.owner || this.healthError) {
      throw installError(this.healthError?.code ?? 'recovery_required');
    }
  }

  /**
   * Admission закрывается синхронно в начале close, до любого внешнего await.
   * Уже допущенные команды завершаются через существующие ownership callbacks.
   */
  private assertOpen(): void {
    if (this.closed) {
      throw installError('service_closed');
    }
  }
}
