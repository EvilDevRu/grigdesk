import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { ExecutorAdapter, ProviderInstallCommand, ProviderInstallation } from '../executors/index.ts';
import { isOutdated, parseVersion } from '../executors/_npmLatest.ts';
import { runCommand, type PluginCommandRunner } from '../pluginInstall/runCommand.ts';
import { terminateOwnedWorker } from '../pluginInstall/workerIdentity.ts';
import { withRetry } from '../retry.ts';
import { applyEnvChanges, updateEnvFile } from '../envFile.ts';
import { runtimeInstallationRoot, runtimeRoot } from '../runtimePaths.ts';
import { findProviderNpm, resolveProviderInstallation } from './commands.ts';
import {
  buildInstallContext,
  contextWarnings,
  type ActiveBinding,
  type InstallContext,
  type RuntimeIdentity,
} from './installContext.ts';
import {
  backupLegacyLink,
  completeMigration,
  createMigrationJournal,
  inspectReplacement,
  restoreLegacyLink,
  type BinIdentity,
  type MigrationJournal,
} from './legacyBinMigration.ts';
import { externalVersion, readGlobalPrefix, type InstallRoots } from './npmEnvironment.ts';
import { isTransientInstallFailure } from './networkFailure.ts';
import {
  readInstallState, writeInstallState, type LifecycleMigrationRecovery, type LifecycleNativeRecovery,
  type ProviderInstallState,
} from './stateStore.ts';
import { setupBashTerminal } from './terminalSetup.ts';
import {
  projectLifecycleV1, type ProviderLifecycleJob, type ProviderLifecycleOperation,
  type ProviderLifecycleSnapshot, type ProviderMigrationEntry,
} from '../../../../shared/chat/providerLifecycleContracts.ts';
import {
  prepareLifecycleContext, lifecycleEnvironmentHash, type LifecycleRecord,
} from './lifecycleContext.ts';
import {
  executeNpmStrategy, revalidateNpmStrategy, restoreNpmStrategy,
} from './npmStrategy.ts';
import {
  executeNativeStrategy, revalidateNativeStrategy, restoreNativeStrategy, probeNativeVersion,
} from './nativeStrategy.ts';
import { treeSnapshot } from './treeSnapshot.ts';
import {
  prepareMigrationPlan, revalidateMigration, executeMigration, rollbackMigrationActivation,
  type MigrationPlan,
} from './migration.ts';
import { resolveUserCliNpm, resolveUserCliEnvironment } from './userCliEnvironment.ts';
import { clearRemovedCliBinding } from './lifecycleBinding.ts';
import { acquireCliLease, type CliLease } from './leases.ts';
import { assertNoExternalCliProcess } from './externalProcesses.ts';
import { InstallEnvironmentError } from './npmEnvironment.ts';
import type {
  ProviderInstallJob,
  ProviderInstallMigration,
  ProviderInstallNotice,
  ProviderInstallOperation,
  ProviderInstallPreparation,
  ProviderInstallSnapshot,
  ProviderInstallStatus,
  ProviderInstallTerminal,
} from '../../../../shared/chat/providerInstallContracts.ts';

export interface ProviderInstallOptions {
  runCommand?: PluginCommandRunner;
  runtimePaths?: { kind: string; node: string };
  retrySleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  roots?: InstallRoots;
  artifactsDir?: string;
  bashTimeoutMs?: number;
  preparationTtlMs?: number;
}

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const RETRY_DELAYS_MS = [2000, 5000];
const PREPARATION_TTL_MS = 5 * 60 * 1000;
const MAX_PREPARATIONS = 8;
const EXTERNAL_LAUNCH_TIMEOUT_MS = 30_000;

interface ServicePorts extends ProviderInstallOptions {
  statePath?: string;
  config: unknown;
  env: NodeJS.ProcessEnv;
  adaptersOf(): Promise<Map<string, ExecutorAdapter>>;
  latestOf(id: string): string | undefined;
  refreshModels(): Promise<unknown>;
  invalidate(): Promise<void>;
  broadcast(snapshot: ProviderInstallSnapshot): void;
  broadcastLifecycle?(snapshot: ProviderLifecycleSnapshot): void;
  invalidateRuntime?(id: string, options: { removed: boolean }): Promise<void>;
}

/**
 * Подготовка связывает показанный человеку результат с единственным стартом.
 * Полный контекст, снимки и окружение остаются на сервере; наружу идёт только DTO.
 */
interface PreparationRecord {
  token: string;
  providerId: string;
  operation: ProviderInstallOperation;
  scope: string;
  expiresAt: number;
  context: InstallContext;
  consumed: boolean;
  files: ShellFileState[];
  target: BinTargetState | null;
}

interface ShellFileState {
  file: string;
  exists: boolean;
  bytes: Buffer;
  mode: number;
  dev: number;
  ino: number;
}

interface BinTargetState {
  target: string;
  exists: boolean;
  link: string | null;
  realpath: string | null;
  identity: BinIdentity | null;
}

interface InstallResult {
  ok: boolean;
  before: string;
  after: string;
  changed: boolean;
  output: string;
}

export class ProviderInstallError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * Общая установка принадлежит серверу: HTTP и видимость окна не управляют процессом.
 * Admission резервируется до await и освобождается лишь после устойчивого финала.
 */
export class ProviderInstallService {
  private state: ProviderInstallState = {
    revision: 0,
    active: null,
    recent: {},
    blockedReason: null,
    worker: null,
    migration: null,
  };
  private initialization: Promise<void> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private admitted = false;
  private closing = false;
  private controller: AbortController | null = null;
  private task: Promise<InstallResult> | null = null;
  private outputTimer: ReturnType<typeof setTimeout> | null = null;
  private preparations = new Map<string, PreparationRecord>();
  private lifecyclePreparations = new Map<string, LifecycleRecord>();
  private migrationPreparations = new Map<string, MigrationPlan>();

  private readonly ports: ServicePorts;

  constructor(ports: ServicePorts) {
    this.ports = ports;
  }

  /**
   * DTO собирается явно, чтобы ownership никогда не попадал в SSE или HTTP.
   * Копия защищает сохранённый результат от изменения потребителем.
   */
  snapshot(): ProviderInstallSnapshot {
    const legacy = this.state;
    const projected = projectLifecycleV1(this.lifecycleSnapshot());

    return structuredClone({
      revision: legacy.revision,
      active: legacy.active ?? projected.active,
      recent: { ...legacy.recent, ...projected.recent },
      blockedReason: projected.blockedReason ?? legacy.blockedReason,
    });
  }

  /**
   * V2 добавляет aggregate targets, сохраняя общую revision и admission старого сервиса.
   * Состояние managed install/update остаётся доступно обоим поколениям клиента.
   */
  private lifecycleSnapshot(): ProviderLifecycleSnapshot {
    const convert = (job: ProviderInstallJob): ProviderLifecycleJob => ({
      ...job,
      affectedProviderIds: [job.providerId],
      targets: [{
        providerId: job.providerId,
        installationId: null,
        phase: job.stage,
        outcome: job.outcome,
        error: job.error,
      }],
    });

    return structuredClone({
      schemaVersion: 2,
      revision: this.state.revision,
      active: this.state.lifecycle?.active ?? (this.state.active ? convert(this.state.active) : null),
      recent: {
        ...Object.fromEntries(Object.entries(this.state.recent).map(([id, job]) => [id, convert(job)])),
        ...(this.state.lifecycle?.recent ?? {}),
      },
      blockedReason: this.state.blockedReason,
    });
  }

  /**
   * Восстановление всегда предшествует публичному чтению нового протокола.
   * Приватные backup paths и ownership не покидают stateStore.
   */
  async currentLifecycle(): Promise<ProviderLifecycleSnapshot> {
    await this.initialize();
    await this.writes;

    return this.lifecycleSnapshot();
  }

  private get home(): string {
    const home = this.ports.env.HOME;

    return typeof home === 'string' && path.isAbsolute(home) ? home : os.homedir();
  }

  /**
   * D — папка данных, I — каталог установки, R — корень дерева или комплекта.
   * В тестах корни задаются явно; в поставке их дают существующие config/runtime API.
   */
  private get roots(): InstallRoots {
    if (this.ports.roots) {
      return this.ports.roots;
    }

    const config = this.ports.config as { dataHome?: unknown } | null;

    return {
      dataHome: typeof config?.dataHome === 'string' ? config.dataHome
        : path.join(this.home, '.grigdesk'),
      installationRoot: runtimeInstallationRoot(),
      runtimeRoot: runtimeRoot(),
    };
  }

  /**
   * Файлы probe живут в артефактах, а не в приватном `.state/`.
   * Каталог общий для подготовок и операций, отдельные имена исключают столкновение.
   */
  private get probeScratch(): string {
    const config = this.ports.config as { artifactsDir?: unknown } | null;
    const artifacts = this.ports.artifactsDir
      ?? (typeof config?.artifactsDir === 'string' ? config.artifactsDir : null)
      ?? path.join(this.roots.dataHome, 'artifacts');

    return path.join(artifacts, 'provider-install-probes');
  }

  /**
   * Recovery выполняется один раз до чтения и нового admission.
   * Несовпавший PID не завершается, но запрещает новый writer поверх неизвестного.
   */
  private initialize(): Promise<void> {
    this.initialization ??= (async () => {
      try {
        const saved = this.ports.statePath ? await readInstallState(this.ports.statePath) : null;

        if (!saved) {
          return;
        }

        this.state = { ...saved, migration: saved.migration ?? null };

        if (saved.active || saved.worker || saved.lifecycle?.active) {
          const stopped = !saved.worker || await terminateOwnedWorker(saved.worker);

          if (!stopped) {
            this.state.blockedReason = {
              code: 'worker_unconfirmed',
              message: 'Не удалось подтвердить остановку прежней установки',
            };
          } else {
            this.state.worker = null;
          }

          if (saved.active) {
            saved.active.status = 'interrupted';
            saved.active.finishedAt = Date.now();
            saved.active.updatedAt = Date.now();
            saved.active.error = { code: 'interrupted', message: 'Прервано перезапуском сервера' };
            this.state.recent[saved.active.providerId] = saved.active;
            this.state.active = null;
          }

          if (saved.lifecycle?.active) {
            const job = saved.lifecycle.active;
            const dirty = Boolean(saved.lifecycleRecovery);

            job.status = dirty ? 'needs_attention' : 'interrupted';
            job.finishedAt = Date.now();
            job.updatedAt = job.finishedAt;
            job.error = {
              code: dirty ? 'lifecycle_recovery_required' : 'interrupted',
              message: dirty ? 'Обслуживание прервано; требуется проверка сохранённой копии'
                : 'Обслуживание прервано перезапуском',
            };

            for (const id of job.affectedProviderIds) {
              saved.lifecycle.recent[id] = job;
            }

            saved.lifecycle.active = null;

            if (dirty) {
              this.state.blockedReason = job.error;
            }
          }

          await this.publish();
        }

        if (this.state.lifecycleRecovery?.kind === 'migration') {
          await this.recoverMigrationLifecycle(this.state.lifecycleRecovery);
        } else if (this.state.lifecycleRecovery?.kind === 'native') {
          await this.recoverNativeLifecycle(this.state.lifecycleRecovery);
        } else if (this.state.lifecycleRecovery) {
          await this.recoverNpmLifecycle(this.state.lifecycleRecovery);
        }

        if (this.state.migration) {
          await this.recoverMigration(this.state.migration);
        }
      } catch (error) {
        this.state.active = null;
        this.state.blockedReason = {
          code: 'state_unavailable',
          message: `Состояние установки недоступно: ${errorMessage(error)}`,
        };
      }
    })();

    return this.initialization;
  }

  /**
   * Npm recovery после рестарта не повторяет destructive-фазу.
   * Новый рабочий tree остаётся, повреждённый восстанавливается из собственного backup.
   */
  private async recoverNpmLifecycle(recovery: {
    backup: string;
    packageRoot: string;
    alias: string;
    operation: string;
    targetVersion?: string | null;
    selectedVersion?: string | null;
  }): Promise<void> {
    const manifestVersion = async (root: string): Promise<string | null> =>
      fs.readFile(path.join(root, 'package.json'), 'utf8')
        .then((text) => JSON.parse(text) as { version?: unknown }, () => null)
        .then((value) => typeof value?.version === 'string' ? value.version : null);
    const backup = await fs.lstat(recovery.backup).catch(() => null);
    const current = await manifestVersion(recovery.packageRoot);

    if (recovery.operation === 'uninstall') {
      const rootExists = await fs.lstat(recovery.packageRoot).then(() => true, () => false);
      const aliasExists = await fs.lstat(recovery.alias).then(() => true, () => false);

      this.state.blockedReason = {
        code: 'lifecycle_recovery_required',
        message: rootExists || aliasExists
          ? 'Удаление прервано; выбранная копия ещё существует'
          : 'Удаление прервано; подтвердите фактическое состояние вручную',
      };
      await this.publish();

      return;
    }

    if (!backup?.isDirectory()) {
      if (current && recovery.targetVersion && current === recovery.targetVersion) {
        this.state.lifecycleRecovery = null;
        this.clearLifecycleBlock();
      } else {
        this.state.blockedReason = {
          code: 'lifecycle_recovery_required',
          message: 'Установка прервана; проверьте выбранную копию',
        };
      }

      await this.publish();

      return;
    }

    const old = await manifestVersion(recovery.backup);

    if (current === recovery.selectedVersion && old === recovery.selectedVersion) {
      this.state.lifecycleRecovery = null;
      this.clearLifecycleBlock();
      await this.publish();

      return;
    }
    if (current && recovery.targetVersion && current === recovery.targetVersion) {
      this.state.lifecycleRecovery = null;
      this.clearLifecycleBlock();
      await this.publish();

      return;
    }

    try {
      const link = await fs.readlink(recovery.alias).catch(() => null);
      const manifest = await fs.readFile(path.join(recovery.backup, 'package.json'), 'utf8')
        .then((text) => JSON.parse(text) as { bin?: unknown }, () => null);
      const entry = typeof manifest?.bin === 'string' ? manifest.bin
        : manifest && typeof manifest.bin === 'object' && manifest.bin
          ? Object.values(manifest.bin as Record<string, unknown>)[0] : null;

      await fs.rm(recovery.packageRoot, { recursive: true, force: true });
      await fs.cp(recovery.backup, recovery.packageRoot, {
        recursive: true,
        verbatimSymlinks: true,
        errorOnExist: true,
      });
      await fs.rm(recovery.alias, { force: true });

      const relative = path.relative(path.dirname(recovery.alias), recovery.packageRoot);
      const target = link ?? `${relative}/${entry}`;

      if (typeof link === 'string' || typeof entry === 'string') {
        await fs.symlink(target, recovery.alias);
      }

      await fs.rm(recovery.backup, { recursive: true, force: true });
      this.state.lifecycleRecovery = null;
      this.clearLifecycleBlock();
    } catch {
      this.state.blockedReason = {
        code: 'lifecycle_recovery_required',
        message: 'Не удалось восстановить прежнюю копию из backup',
      };
    }

    await this.publish();
  }

  /** Снимает только собственную блокировку восстановления, не трогая чужие причины. */
  private clearLifecycleBlock(): void {
    if (this.state.blockedReason && typeof this.state.blockedReason === 'object'
      && this.state.blockedReason.code === 'lifecycle_recovery_required') {
      this.state.blockedReason = null;
    }
  }

  /**
   * После рестарта официальный installer и удаление автоматически не повторяются.
   * Снимок остаётся заблокированным до ручного подтверждения фактического результата.
   */
  private async recoverNativeLifecycle(_recovery: LifecycleNativeRecovery): Promise<void> {
    this.state.blockedReason = {
      code: 'lifecycle_recovery_required',
      message: 'Обслуживание программы прервано; подтвердите фактическое состояние вручную',
    };
    await this.publish();
  }

  /**
   * Ручное подтверждение фактического состояния после прерванной destructive-фазы.
   * Автоматически не повторяет uninstall; разрешает новые старты только при доказанном исходе.
   */
  async resolveLifecycleRecovery(): Promise<ProviderLifecycleSnapshot> {
    await this.initialize();

    const recovery = this.state.lifecycleRecovery;

    if (!recovery) {
      this.clearLifecycleBlock();
      await this.publish();

      return this.lifecycleSnapshot();
    }

    if (recovery.kind === 'migration') {
      await this.recoverMigrationLifecycle(recovery);

      return this.lifecycleSnapshot();
    }
    if (recovery.operation === 'uninstall') {
      const root = await fs.lstat(recovery.packageRoot).then(() => true, () => false);
      const alias = await fs.lstat(recovery.alias).then(() => true, () => false);

      if (root || alias) {
        throw new ProviderInstallError(409, 'recovery_not_resolved',
          'Прежняя копия ещё существует; удаление не подтверждено');
      }

      await clearRemovedCliBinding(recovery.removedBinding, this.ports.config, this.ports.env);
      await this.ports.invalidate();
    } else if (recovery.kind === 'native') {
      const shell = await resolveUserCliEnvironment({
        env: this.ports.env,
        cliName: path.basename(recovery.alias),
        scratch: this.probeScratch,
      });
      const version = await probeNativeVersion({
        alias: recovery.alias,
        home: this.home,
        env: shell.env,
        run: this.ports.runCommand,
      });

      if (version !== recovery.targetVersion && version !== recovery.selectedVersion) {
        throw new ProviderInstallError(409, 'recovery_not_resolved', 'Версия программы не подтверждена');
      }
    } else {
      await this.recoverNpmLifecycle(recovery);

      if (this.state.lifecycleRecovery) {
        throw new ProviderInstallError(409, 'recovery_not_resolved',
          'Прежняя копия не восстановлена; нужна ручная проверка');
      }

      return this.lifecycleSnapshot();
    }

    if (recovery.kind === 'native') {
      await fs.rm(recovery.backup, { recursive: true, force: true });
    }

    this.state.lifecycleRecovery = null;
    this.clearLifecycleBlock();
    await this.publish();

    return this.lifecycleSnapshot();
  }

  /**
   * Активация до binding commit откатывается по CAS: файл должен совпасть с нашим after.
   * Чужое изменение оставляет обслуживание заблокированным, а не перетирается.
   */
  private async recoverMigrationLifecycle(recovery: LifecycleMigrationRecovery): Promise<void> {
    const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
    const read = (file: string): Promise<Buffer | null> =>
      fs.readFile(file).catch(() => null);

    try {
      if (recovery.phase === 'activation' || recovery.phase === 'terminal') {
        for (const change of recovery.shell) {
          const current = await read(change.file);
          const backup = await read(change.backup);

          if (!backup) {
            throw new Error('backup_missing');
          }
          if (current && hash(current) === hash(backup)) {
            continue;
          }
          if (!current || hash(current) !== change.afterHash) {
            throw new Error('shell_changed');
          }

          await fs.writeFile(change.file, backup, { mode: change.mode & 0o7777 });
        }
        for (const shim of recovery.shims) {
          const atTarget = await fs.lstat(shim.to).catch(() => null);
          const atSource = await fs.lstat(shim.from).catch(() => null);

          if (atTarget && !atSource) {
            await fs.rename(shim.to, shim.from);
          } else if (atTarget && atSource) {
            throw new Error('shim_conflict');
          }
        }
      } else if (recovery.phase === 'binding' || recovery.phase === 'cleanup') {
        // Binding уже записан: новая копия активна, автоматически повторяется только уборка.
        for (const root of recovery.removeRoots) {
          await fs.rm(root, { recursive: true, force: true });
        }
        for (const alias of recovery.removeAliases) {
          await fs.rm(alias, { force: true });
        }
        for (const shim of recovery.shims) {
          await fs.rm(shim.backup, { force: true });
        }

        await fs.rm(recovery.directory, { recursive: true, force: true });
      }

      this.state.lifecycleRecovery = null;

      if (this.state.blockedReason && typeof this.state.blockedReason === 'object'
        && (this.state.blockedReason.code === 'lifecycle_recovery_required'
          || this.state.blockedReason.code === 'lifecycle_cleanup_pending')) {
        this.state.blockedReason = null;
      }

      await this.publish();
    } catch {
      this.state.blockedReason = {
        code: 'lifecycle_recovery_required',
        message: 'Файлы оболочки или миграции изменились; требуется ручная проверка',
      };
      await this.publish();
    }
  }

  /**
   * `.env` определяет фактическую привязку после перезапуска. Новая копия уже
   * записана — старая ссылка не возвращается; старая привязка и свободное имя
   * дают восстановление; неоднозначность блокирует новые установки.
   */
  private async recoverMigration(journal: MigrationJournal): Promise<void> {
    const config = this.ports.config as Record<string, unknown>;
    const configured = config[journal.configKey];

    if (typeof configured === 'string' && journal.oldBin && configured !== journal.oldBin) {
      await completeMigration(journal);
      this.state.migration = null;
      await this.publish();

      return;
    }

    const inspected = await inspectReplacement(journal);
    const restored = await restoreLegacyLink(inspected);

    if (restored === 'restored') {
      this.state.migration = null;
      await this.publish();

      return;
    }

    this.state.blockedReason = {
      code: 'migration_recovery_required',
      message: 'Прежняя bin-ссылка требует ручного восстановления; новые установки запрещены',
    };
    await this.publish();
  }

  /**
   * Ленивое чтение не обращается к адаптерам и моделям до общей авторизации маршрута.
   * Даже повреждённый state возвращается как явная блокировка вместо новой установки.
   */
  async current(): Promise<ProviderInstallSnapshot> {
    await this.initialize();
    await this.writes;

    return this.snapshot();
  }

  /**
   * Все записи получают независимый снимок и идут последовательно.
   * Ошибка durable final блокирует admission; её нельзя скрыть успешным HTTP ACK.
   */
  private publish(): Promise<void> {
    this.state.revision += 1;

    const saved = structuredClone(this.state);
    const publicSnapshot = this.snapshot();
    const lifecycleSnapshot = this.lifecycleSnapshot();
    const writing = this.writes.then(async () => {
      if (this.ports.statePath) {
        await writeInstallState(this.ports.statePath, saved);
      }

      this.ports.broadcast(publicSnapshot);
      this.ports.broadcastLifecycle?.(lifecycleSnapshot);
    });

    this.writes = writing.catch((error) => {
      this.state.blockedReason = {
        code: 'state_write_failed',
        message: `Не удалось сохранить установку: ${errorMessage(error)}`,
      };
    });

    return writing;
  }

  /**
   * Новый preview принадлежит тому же сервису и auth scope, что прежняя установка.
   * От клиента приходят только действие и identity найденной копии, никогда argv или paths.
   */
  async prepareLifecycle(id: string, operation: Exclude<ProviderLifecycleOperation, 'migrate'>,
    scope: string, installationId?: string) {
    await this.initialize();
    this.assertNotBlocked();

    if (this.admitted || this.closing) {
      throw new ProviderInstallError(409, 'busy', 'Уже идёт обслуживание исполнителя');
    }

    const adapter = (await this.ports.adaptersOf()).get(id);

    if (!adapter) {
      throw new ProviderInstallError(404, 'unknown_provider', 'Исполнитель не найден');
    }

    try {
      const record = await prepareLifecycleContext({
        adapter,
        config: this.ports.config,
        env: this.ports.env,
        home: this.home,
        roots: this.roots,
        scratch: this.probeScratch,
        operation,
        scope,
        installationId,
        latest: this.ports.latestOf(id),
        ttl: this.ports.preparationTtlMs ?? PREPARATION_TTL_MS,
        run: this.ports.runCommand,
      });

      for (const [token, previous] of this.lifecyclePreparations) {
        if (previous.preview.expiresAt < Date.now() || previous.consumed) {
          this.lifecyclePreparations.delete(token);
          await fs.rm(previous.prepared.directory, { recursive: true, force: true }).catch(() => {});
        }
      }

      if (this.lifecyclePreparations.size >= MAX_PREPARATIONS) {
        await fs.rm(record.prepared.directory, { recursive: true, force: true });

        throw new ProviderInstallError(429, 'too_many_preparations', 'Слишком много подготовленных операций');
      }

      this.lifecyclePreparations.set(record.preview.token, record);

      return structuredClone(record.preview);
    } catch (error) {
      throw this.lifecycleFailure(error);
    }
  }

  /**
   * Общий admission резервируется до await; token одноразовый и привязан к scope.
   * Exclusive и CAS предшествуют устойчивому intent и любой пользовательской мутации.
   */
  async startLifecycle(id: string, operation: Exclude<ProviderLifecycleOperation, 'migrate'>,
    token: string, scope: string) {
    if (this.admitted || this.closing) {
      throw new ProviderInstallError(409, 'busy', 'Уже идёт обслуживание исполнителя');
    }

    this.admitted = true;

    let lease: CliLease | null = null;

    try {
      await this.initialize();
      this.assertNotBlocked();

      const record = this.lifecyclePreparations.get(token);

      if (!record || record.consumed || record.scope !== scope || record.preview.providerId !== id
        || record.preview.operation !== operation || record.preview.expiresAt <= Date.now()) {
        throw new ProviderInstallError(409, 'preparation_invalid', 'Подтверждение операции устарело');
      }

      record.consumed = true;

      const prepared = record.prepared;
      const shellInput = {
        env: this.ports.env,
        cliName: prepared.input.definition.binName,
        packageId: prepared.input.definition.packageId,
        scratch: this.probeScratch,
        roots: this.roots,
      };
      const resolved = prepared.method === 'npm' ? await resolveUserCliNpm(shellInput) : null;
      const shell = resolved?.shell ?? await resolveUserCliEnvironment(shellInput);

      if (lifecycleEnvironmentHash(shell) !== record.environmentHash
        || prepared.method === 'npm' && (resolved!.prefix !== prepared.input.prefix
          || resolved!.runtime.node !== prepared.input.runtime.node
          || resolved!.runtime.npm !== prepared.input.runtime.npm)) {
        throw new ProviderInstallError(409, 'preparation_changed', 'Окружение изменилось после подготовки');
      }

      await this.assertNativeLifecycleBinding(record);

      lease = await acquireCliLease({
        directory: path.join(this.roots.dataHome, 'provider-cli-leases'),
        providerId: id,
        resourceKey: prepared.resourceKey,
        mode: 'exclusive',
      });

      if (prepared.method === 'native') {
        await revalidateNativeStrategy(prepared);
      } else {
        await revalidateNpmStrategy(prepared);
      }

      await assertNoExternalCliProcess(prepared.packageRoot, [prepared.alias]);

      const now = Date.now();
      const job: ProviderLifecycleJob = {
        id: randomUUID(),
        providerId: id,
        operation,
        status: 'running',
        stage: 'preparing',
        before: record.preview.fromVersion ?? '',
        after: '',
        outcome: null,
        error: null,
        warnings: [],
        outputTail: '',
        command: record.preview.command,
        fallbackCommand: prepared.method === 'native' && operation !== 'uninstall'
          ? prepared.input.installer.fallbackCommand : '',
        loginCommand: '',
        startedAt: now,
        updatedAt: now,
        finishedAt: null,
        affectedProviderIds: [id],
        targets: [{
          providerId: id,
          installationId: record.preview.installationId,
          phase: 'preparing',
          outcome: null,
          error: null,
        }],
      };

      this.state.lifecycle ??= {
        schemaVersion: 2,
        revision: 0,
        active: null,
        recent: {},
        blockedReason: null,
      };
      this.state.lifecycle.active = job;
      this.controller = new AbortController();
      prepared.input.signal = this.controller.signal;
      await this.publish();

      const snapshot = this.lifecycleSnapshot();
      const completion = this.executeLifecycle(record, job, lease);

      this.task = completion;

      return { snapshot, completion };
    } catch (error) {
      await lease?.release();
      this.admitted = false;

      throw this.lifecycleFailure(error);
    }
  }

  /**
   * Привязка и декларация адаптера сверяются до admission и ещё раз перед удалением.
   * Чужой ручной выбор в config или файле окружения не разрешает менять прежнюю копию.
   */
  private async assertNativeLifecycleBinding(record: LifecycleRecord): Promise<void> {
    const prepared = record.prepared;

    if (prepared.method !== 'native') {
      return;
    }

    const adapter = (await this.ports.adaptersOf()).get(record.preview.providerId);
    const config = this.ports.config as { envPath?: string };

    if (!adapter || String(adapter.bin(config)) !== record.configuredBin
      || (config.envPath ?? null) !== record.bindingPath
      || JSON.stringify(adapter.externalCli?.(config, this.home))
        !== JSON.stringify(prepared.input.definition)
      || JSON.stringify(adapter.installation?.(config)?.install)
        !== JSON.stringify(prepared.input.installer)
      || this.ports.env[prepared.input.definition.envKey]
        && this.ports.env[prepared.input.definition.envKey] !== record.configuredBin
      || record.bindingSnapshot && (!config.envPath
        || await treeSnapshot(config.envPath) !== record.bindingSnapshot)) {
      throw new ProviderInstallError(409, 'preparation_changed', 'Привязка программы изменилась');
    }
  }

  /**
   * Migration — пятая внутренняя операция того же admission и того же job lock.
   * Клиент передаёт только identity из inventory; rc-файлы, пути и версии выбирает сервер.
   */
  async prepareMigration(entries: ProviderMigrationEntry[], cleanupOwnedShell: boolean,
    scope: string) {
    await this.initialize();
    this.assertNotBlocked();

    if (this.admitted || this.closing) {
      throw new ProviderInstallError(409, 'busy', 'Уже идёт обслуживание исполнителя');
    }

    try {
      const config = this.ports.config as Record<string, unknown>;
      const envPath = typeof config.envPath === 'string' && path.isAbsolute(config.envPath)
        ? config.envPath : null;
      const plan = await prepareMigrationPlan({
        entries,
        cleanupOwnedShell,
        adapters: await this.ports.adaptersOf(),
        config: this.ports.config,
        env: this.ports.env,
        envPath,
        home: this.home,
        roots: this.roots,
        scratch: this.probeScratch,
        scope,
        ttl: this.ports.preparationTtlMs ?? PREPARATION_TTL_MS,
        run: this.ports.runCommand,
      });

      for (const [token, previous] of this.migrationPreparations) {
        if (previous.preview.expiresAt < Date.now() || previous.consumed) {
          this.migrationPreparations.delete(token);
          await fs.rm(previous.directory, { recursive: true, force: true }).catch(() => {});
        }
      }

      if (this.migrationPreparations.size >= MAX_PREPARATIONS) {
        await fs.rm(plan.directory, { recursive: true, force: true });

        throw new ProviderInstallError(429, 'too_many_preparations', 'Слишком много подготовленных операций');
      }

      this.migrationPreparations.set(plan.preview.token, plan);

      return structuredClone(plan.preview);
    } catch (error) {
      throw this.lifecycleFailure(error);
    }
  }

  /**
   * Старт захватывает leases всех затронутых установок в стабильном порядке.
   * Shell-правка выполняется только после установки и повторной сверки старых копий.
   */
  async startMigration(token: string, scope: string) {
    if (this.admitted || this.closing) {
      throw new ProviderInstallError(409, 'busy', 'Уже идёт обслуживание исполнителя');
    }

    this.admitted = true;

    const leases: CliLease[] = [];

    try {
      await this.initialize();
      this.assertNotBlocked();

      const plan = this.migrationPreparations.get(token);

      if (!plan || plan.consumed || plan.scope !== scope || plan.preview.expiresAt <= Date.now()) {
        throw new ProviderInstallError(409, 'preparation_invalid', 'Подтверждение миграции устарело');
      }

      plan.consumed = true;
      await revalidateMigration(plan);

      const resources = new Map<string, { providerId: string; resourceKey: string }>();

      for (const target of plan.targets) {
        resources.set(`${target.providerId}:${target.prepared.resourceKey}`,
          { providerId: target.providerId, resourceKey: target.prepared.resourceKey });

        for (const source of target.sources) {
          resources.set(`${target.providerId}:${source.resourceKey}`,
            { providerId: target.providerId, resourceKey: source.resourceKey });
        }
      }

      for (const resource of [...resources.values()].sort((left, right) =>
        `${left.providerId}:${left.resourceKey}`.localeCompare(`${right.providerId}:${right.resourceKey}`))) {
        leases.push(await acquireCliLease({
          directory: path.join(this.roots.dataHome, 'provider-cli-leases'),
          providerId: resource.providerId,
          resourceKey: resource.resourceKey,
          mode: 'exclusive',
        }));
      }

      for (const target of plan.targets) {
        await assertNoExternalCliProcess(target.prepared.packageRoot, [target.prepared.alias]);
      }

      const now = Date.now();
      const job: ProviderLifecycleJob = {
        id: randomUUID(),
        providerId: plan.targets[0]!.providerId,
        operation: 'migrate',
        status: 'running',
        stage: 'preparing',
        before: plan.targets.map((target) => target.target.fromVersion).filter(Boolean).join(', '),
        after: '',
        outcome: null,
        error: null,
        warnings: [],
        outputTail: '',
        command: plan.targets.map((target) => target.target.command).join('; '),
        fallbackCommand: '',
        loginCommand: '',
        startedAt: now,
        updatedAt: now,
        finishedAt: null,
        affectedProviderIds: plan.targets.map((target) => target.providerId),
        targets: plan.targets.map((target) => ({
          providerId: target.providerId,
          installationId: target.sourceIds[0] ?? null,
          phase: 'preparing',
          outcome: null,
          error: null,
        })),
        migrationPhase: 'prepared',
      };

      this.state.lifecycle ??= {
        schemaVersion: 2,
        revision: 0,
        active: null,
        recent: {},
        blockedReason: null,
      };
      this.state.lifecycle.active = job;
      this.state.lifecycleRecovery = this.migrationRecoveryOf(plan, 'installing');
      this.controller = new AbortController();
      await this.publish();

      const snapshot = this.lifecycleSnapshot();
      const completion = this.executeMigrationJob(plan, job, leases);

      this.task = completion;

      return { snapshot, completion };
    } catch (error) {
      for (const lease of leases.reverse()) {
        await lease.release().catch(() => {});
      }

      this.admitted = false;

      throw this.lifecycleFailure(error);
    }
  }

  /**
   * Фазы миграции сохраняются до эффекта: restart не повторяет npm и уборку.
   * Новая копия может остаться без активации — это честный partial result.
   */
  private async executeMigrationJob(plan: MigrationPlan, job: ProviderLifecycleJob,
    leases: CliLease[]): Promise<InstallResult> {
    let result: Awaited<ReturnType<typeof executeMigration>> | null = null;
    let failure: unknown = null;

    try {
      result = await executeMigration(plan, {
        ownership: {
          started: async (worker) => {
            this.state.worker = worker;
            await this.publish();
          },
          finished: async () => {
            this.state.worker = null;
            await this.publish();
          },
        },
        phase: async (phase) => {
          job.migrationPhase = phase;
          job.stage = phase;
          job.updatedAt = Date.now();

          if (phase === 'download-install') {
            this.state.lifecycleRecovery = this.migrationRecoveryOf(plan, 'installing');
          } else if (phase === 'activation') {
            this.state.lifecycleRecovery = this.migrationRecoveryOf(plan, 'activation');
          } else if (phase === 'terminal') {
            this.state.lifecycleRecovery = this.migrationRecoveryOf(plan, 'terminal');
          } else if (phase === 'cleanup') {
            this.state.lifecycleRecovery = this.migrationRecoveryOf(plan, 'cleanup');
          }

          for (const target of job.targets) {
            target.phase = phase;
          }

          await this.publish();
        },
      });
    } catch (error) {
      failure = error;
    }

    const verified = result !== null;

    if (verified && result) {
      job.outcome = result.outcome;
      job.warnings.push(...result.warnings);
      job.status = 'succeeded';
      job.after = plan.targets.map((target) => target.target.targetVersion).join(', ');
      this.state.lifecycleRecovery = null;

      const config = this.ports.config as Record<string, unknown>;

      for (const target of plan.targets) {
        config[target.configKey] = target.prepared.alias;
        config[target.envKey] = target.prepared.alias;
        applyEnvChanges({ [target.envKey]: target.prepared.alias }, this.ports.env);
      }
    } else {
      const rolledBack = await rollbackMigrationActivation(plan).catch(() => false);

      job.status = rolledBack ? 'failed' : 'needs_attention';
      job.error = {
        code: failure instanceof InstallEnvironmentError ? failure.code : 'migration_failed',
        message: failure instanceof InstallEnvironmentError ? failure.message
          : 'Миграция не завершена; требуется проверка сохранённой копии',
      };

      if (rolledBack) {
        this.state.lifecycleRecovery = null;
      } else {
        this.state.blockedReason = {
          code: 'lifecycle_recovery_required',
          message: 'Требуется проверка оболочки и сохранённой копии после сбоя миграции',
        };
      }
    }

    for (const lease of leases.reverse()) {
      await lease.release().catch(() => {
        this.state.blockedReason = {
          code: 'lease_release_failed', message: 'Не снята блокировка обслуживания',
        };
      });
    }

    for (const target of plan.targets) {
      await this.ports.invalidateRuntime?.(target.providerId, { removed: false }).catch(() => {});
    }

    if (verified) {
      await this.ports.refreshModels().catch(() => {
        job.warnings.push({ code: 'models_refresh_failed', message: 'Каталог моделей не обновлён' });
      });
    }

    job.finishedAt = Date.now();
    job.updatedAt = job.finishedAt;

    for (const target of job.targets) {
      target.outcome = verified ? job.outcome : null;
      target.error = job.error;
    }
    for (const id of job.affectedProviderIds) {
      this.state.lifecycle!.recent[id] = job;
    }

    this.state.lifecycle!.active = null;
    await this.publish().catch(() => {});
    this.admitted = false;
    this.controller = null;

    return {
      ok: job.status === 'succeeded',
      before: job.before,
      after: job.after,
      changed: verified,
      output: '',
    };
  }

  /** Снимок восстановления содержит только пути, mode и хеши; готовые bytes не дублируются. */
  private migrationRecoveryOf(plan: MigrationPlan,
    phase: LifecycleMigrationRecovery['phase']): LifecycleMigrationRecovery {
    return {
      kind: 'migration',
      phase,
      directory: plan.directory,
      envPath: plan.envPath,
      configChanges: plan.configChanges,
      shell: plan.shell.map((change) => ({
        file: change.file,
        backup: change.backup,
        mode: change.mode,
        afterHash: createHash('sha256').update(change.after).digest('hex'),
      })),
      shims: plan.shims.map((shim) => ({
        from: shim.from,
        to: shim.to,
        backup: shim.backup,
      })),
      removeRoots: plan.targets.flatMap((target) => target.removeRoots),
      removeAliases: plan.targets.flatMap((target) => target.removeAliases),
      newBins: plan.targets.map((target) => target.prepared.alias),
      providers: plan.targets.map((target) => target.providerId),
    };
  }

  /**
   * Код собственной причины не маскируется под общий отказ HTTP.
   * Неизвестная ошибка остаётся installation_failed без текста чужих данных.
   */
  private lifecycleFailure(error: unknown): ProviderInstallError {
    if (error instanceof ProviderInstallError) {
      return error;
    }
    if (error instanceof InstallEnvironmentError) {
      return new ProviderInstallError(409, error.code, error.message);
    }
    if (error instanceof Error && typeof (error as Error & { code?: unknown }).code === 'string'
      && /^[a-z][a-z0-9_]{1,63}$/u.test((error as Error & { code: string }).code)) {
      return new ProviderInstallError(409, (error as Error & { code: string }).code,
        'Подготовка операции не удалась');
    }

    return new ProviderInstallError(500, 'installation_failed', 'Операция не завершена');
  }

  /**
   * Durable intent записывается раньше backup/удаления; restart не повторяет destructive command.
   * Runtime invalidation и модели выполняются после release, поэтому probe не ждёт свой writer.
   */
  private async executeLifecycle(record: LifecycleRecord, job: ProviderLifecycleJob,
    lease: CliLease): Promise<InstallResult> {
    const prepared = record.prepared;
    let mutated = false;
    let verified = false;

    try {
      const options = {
        ownership: {
          started: async (worker: import('../pluginInstall/runCommand.ts').CommandWorker) => {
            this.state.worker = worker;
            await this.publish();
          },
          finished: async () => {
            this.state.worker = null;
            await this.publish();
          },
        },
        phase: async (phase: 'backup' | 'download-install' | 'version' | 'cleanup') => {
          job.stage = phase;
          job.targets[0]!.phase = phase;
          job.updatedAt = Date.now();

          if (phase === 'backup') {
            this.state.lifecycleRecovery = {
              ...(prepared.method === 'native'
                ? { kind: 'native' as const, providerId: job.providerId } : { kind: 'npm' as const }),
              backup: prepared.backup,
              packageRoot: prepared.packageRoot,
              alias: prepared.alias,
              operation: job.operation,
              targetVersion: prepared.version,
              selectedVersion: prepared.selectedVersion,
              removedBinding: record.removedBinding,
            };
          }
          if (phase === 'download-install') {
            await this.assertNativeLifecycleBinding(record);
            mutated = true;
          }

          await this.publish();
        },
        output: (text: string) => this.append(job, text),
      };

      if (prepared.method === 'native') {
        await executeNativeStrategy(prepared, options);
      } else {
        await executeNpmStrategy(prepared, options);
      }

      if (job.operation !== 'uninstall') {
        job.stage = 'terminal';
        await this.publish();

        const shell = await resolveUserCliEnvironment({
          env: this.ports.env,
          cliName: prepared.input.definition.binName,
          scratch: this.probeScratch,
        });
        const terminal = shell.cli.path ? await fs.realpath(shell.cli.path).catch(() => null) : null;
        const expected = await fs.realpath(prepared.alias).catch(() => null);

        if (!terminal || terminal !== expected) {
          throw new InstallEnvironmentError('terminal_conflict', 'Новый терминал выбирает другую копию');
        }

        if (prepared.method === 'native') {
          const adapter = (await this.ports.adaptersOf()).get(job.providerId);
          const configured = adapter ? String(adapter.bin(this.ports.config)) : '';
          const active = path.isAbsolute(configured) ? await fs.realpath(configured).catch(() => null)
            : terminal;

          if (active !== expected) {
            throw new InstallEnvironmentError('cli_selection_conflict',
              'Настроенный путь выбирает другую версию программы');
          }
        }

        job.after = prepared.version ?? '';
        job.terminal = {
          status: 'ready',
          reason: null,
          binDirectory: path.dirname(prepared.alias),
          shell: 'bash',
        };
      }

      verified = true;
      job.outcome = job.operation === 'uninstall' ? 'uninstalled'
        : job.operation === 'reinstall' ? 'reinstalled'
          : job.operation === 'install' ? 'installed' : job.before === job.after ? 'current' : 'updated';
      job.stage = 'cleanup';
      await this.publish();
      await clearRemovedCliBinding(record.removedBinding, this.ports.config, this.ports.env);
      await fs.rm(prepared.backup, { recursive: true, force: true });
      this.state.lifecycleRecovery = null;
      job.status = 'succeeded';
    } catch (error) {
      job.status = mutated ? 'needs_attention' : this.closing ? 'interrupted' : 'failed';

      const code = error instanceof InstallEnvironmentError ? error.code
        : error instanceof Error && typeof (error as Error & { code?: unknown }).code === 'string'
          && /^[a-z][a-z0-9_]{1,63}$/u.test((error as Error & { code: string }).code)
          ? (error as Error & { code: string }).code : 'installation_failed';

      job.error = {
        code,
        message: error instanceof InstallEnvironmentError ? error.message : 'Обслуживание не завершено',
      };

      if (prepared.method === 'native' && !mutated) {
        this.state.lifecycleRecovery = null;
      }

      if (mutated && (!verified || job.operation === 'uninstall' || record.removedBinding)) {
        this.state.blockedReason = {
          code: 'lifecycle_recovery_required', message: 'Требуется проверка сохранённой копии после сбоя',
        };

        // Повреждённая замена возвращает доказанную старую копию сразу.
        // Если restore не подтверждён, остаётся честный needs_attention с backup.
        if (job.operation !== 'uninstall' && prepared.selectedVersion
          && await (prepared.method === 'native'
            ? restoreNativeStrategy(prepared) : restoreNpmStrategy(prepared))
            .catch(() => 'unavailable') === 'restored') {
          job.status = 'failed';
          this.state.blockedReason = null;
          this.state.lifecycleRecovery = null;
        }
      }
    } finally {
      if (this.state.worker) {
        const stopped = await terminateOwnedWorker(this.state.worker).catch(() => false);

        if (stopped) {
          this.state.worker = null;
        } else {
          this.state.blockedReason = { code: 'worker_unconfirmed', message: 'Процесс npm ещё не завершён' };
        }
      }

      await lease.release().catch(() => {
        this.state.blockedReason = {
          code: 'lease_release_failed',
          message: 'Не снята блокировка обслуживания',
        };
      });

      if (mutated) {
        const adapter = (await this.ports.adaptersOf().catch(() => new Map())).get(job.providerId);
        const remaining = job.operation === 'uninstall' && verified && adapter?.probe
          ? await Promise.resolve().then(() => adapter.probe(this.ports.config)).catch(() => null) : null;

        await this.ports.invalidateRuntime?.(job.providerId,
          { removed: job.operation === 'uninstall' && verified && !remaining?.ok }).catch(() => {});
        await this.ports.invalidate().catch(() => {});
      }

      if (verified) {
        await this.ports.refreshModels().catch(() => {
          job.warnings.push({ code: 'models_refresh_failed', message: 'Каталог моделей не обновлён' });
        });
      }

      job.finishedAt = Date.now();
      job.updatedAt = job.finishedAt;
      job.targets[0]!.outcome = job.outcome;
      job.targets[0]!.error = job.error;
      this.state.lifecycle!.recent[job.providerId] = job;
      this.state.lifecycle!.active = null;
      await this.publish().catch(() => {});
      this.admitted = false;
      this.controller = null;
    }

    return {
      ok: job.status === 'succeeded',
      before: job.before,
      after: job.after,
      changed: mutated && verified,
      output: '',
    };
  }

  /**
   * Оба потока объединяются в ограниченный текст без терминальных escape-команд.
   * Публикация пачками ограничивает нагрузку SSE и диска при многословном installer.
   */
  private append(job: ProviderInstallJob | ProviderLifecycleJob, text: string): void {
    job.outputTail = boundedOutput(job.outputTail + text);
    job.updatedAt = Date.now();

    if (!this.outputTimer) {
      this.outputTimer = setTimeout(() => {
        this.outputTimer = null;
        void this.publish().catch(() => {});
      }, 100);
    }
  }

  /**
   * Подготовка не запускает npm и не пишет shell: она выбирает внешний runtime,
   * prefix и точный текст изменений. Ответ привязан к провайдеру, операции и
   * авторизованной identity; prefix, файлы и argv от клиента не принимаются.
   */
  async prepare(id: string, operation: ProviderInstallOperation,
    scope: string): Promise<ProviderInstallPreparation> {
    await this.initialize();
    this.assertNotBlocked();

    const external = (await this.ports.adaptersOf()).get(id)?.externalCli?.(this.ports.config, this.home);

    if (external) {
      const preview = await this.prepareLifecycle(id, operation, scope);

      return {
        token: preview.token,
        expiresAt: preview.expiresAt,
        providerId: id,
        operation,
        command: preview.command,
        prefix: preview.prefix,
        shellChanges: [],
        terminalSetup: 'none',
        warnings: preview.warnings,
      };
    }

    const { adapter, declared, command } = await this.resolveOperation(id, operation);
    const context = await this.buildContext(adapter, declared, command, id, operation, true);
    const token = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + (this.ports.preparationTtlMs ?? PREPARATION_TTL_MS);
    const preparation: ProviderInstallPreparation = {
      token,
      expiresAt,
      providerId: id,
      operation,
      command: context.npm?.displayCommand ?? command.command,
      prefix: context.prefix,
      shellChanges: context.shell?.changes ?? [],
      terminalSetup: context.shell?.terminalSetup ?? 'none',
      warnings: contextWarnings(context),
    };
    const record: PreparationRecord = {
      token,
      providerId: id,
      operation,
      scope,
      expiresAt,
      context,
      consumed: false,
      files: await this.shellFiles(context),
      target: await this.binTarget(context),
    };

    this.prunePreparations(scope);
    this.preparations.set(token, record);

    return structuredClone(preparation);
  }

  /**
   * Старт по token заново проверяет admission, установленность, идентичности
   * runtime, effective prefix и снимки целей до первой записи. Изменение даёт
   * 409 и новый preview; истёкший, чужой или употреблённый token не запускает job.
   */
  async start(id: string, operation: ProviderInstallOperation, options: {
    legacy?: boolean;
    token?: string;
    scope?: string;
  } = {}) {
    const external = (await this.ports.adaptersOf()).get(id)?.externalCli?.(this.ports.config, this.home);

    if (external) {
      const scope = options.scope ?? '';
      const token = options.token ?? (await this.prepareLifecycle(id, operation, scope)).token;
      const started = await this.startLifecycle(id, operation, token, scope);

      return { snapshot: this.snapshot(), completion: started.completion };
    }

    if (this.admitted || this.closing) {
      throw new ProviderInstallError(409, 'busy', 'Уже идёт установка исполнителя');
    }

    this.admitted = true;

    try {
      await this.initialize();
      this.assertNotBlocked();

      if (this.state.active) {
        throw new ProviderInstallError(409, 'busy', 'Уже идёт установка исполнителя');
      }

      const { adapter, declared, command } = await this.resolveOperation(id, operation,
        options.legacy === true);
      let context: InstallContext;

      if (options.token) {
        const record = this.takePreparation(options.token, id, operation, options.scope ?? '');

        await this.revalidatePreparation(record);
        context = record.context;
      } else {
        context = await this.buildContext(adapter, declared, command, id, operation, false);
      }

      return await this.launch(adapter, context, id, operation, this.ports.latestOf(id));
    } catch (error) {
      this.admitted = false;

      throw error;
    }
  }

  /**
   * Явная блокировка состояния запрещает и подготовку, и старт.
   * HTTP получает код причины, чтобы окно показало перевод, а не общий отказ.
   */
  private assertNotBlocked(): void {
    const reason = this.state.blockedReason;

    if (reason) {
      throw new ProviderInstallError(409, typeof reason === 'string' ? 'state_unavailable' : reason.code,
        typeof reason === 'string' ? reason : reason.message);
    }
  }

  /**
   * Общие gates действия: адаптер, managed-поставка, команда операции и проверка
   * установленности. Prepare и start получают один результат до любых эффектов.
   */
  private async resolveOperation(id: string, operation: ProviderInstallOperation,
    legacy = false) {
    const adapter = (await this.ports.adaptersOf()).get(id);

    if (!adapter) {
      throw new ProviderInstallError(404, 'unknown_provider', 'Исполнитель не найден');
    }
    if (adapter.distribution?.(this.ports.config)?.managed === true) {
      throw new ProviderInstallError(400, 'no_update', 'Обновите управляемую поставку отдельно');
    }

    const declared = await resolveProviderInstallation(adapter, this.ports.config,
      this.ports.env, this.ports.runtimePaths);

    const fallback = declared ? null : legacyUpdateCommand(adapter, this.ports.config, operation);
    const installation = declared ?? (fallback ? {
      install: fallback,
      update: fallback,
      loginCommand: adapter.login ?? '',
    } : null);

    if (!installation) {
      throw new ProviderInstallError(400, 'unsupported_action',
        'Исполнитель не поддерживает это действие');
    }

    const command = installation[operation];

    if (!command) {
      throw new ProviderInstallError(400, 'unsupported_action',
        'Исполнитель не поддерживает это действие');
    }

    const probe = await adapter.probe(this.ports.config);

    if ((operation === 'install') === !!probe.ok) {
      throw new ProviderInstallError(409, probe.ok ? 'already_installed' : 'not_installed',
        probe.ok ? 'Исполнитель уже установлен' : 'Исполнитель ещё не установлен');
    }

    return {
      adapter,
      declared: installation,
      command,
      installed: !!probe.ok,
    };
  }

  /**
   * Контекст собирается одинаково для preview и старта; legacy-маршрут вызывает
   * его без права менять shell. Отказы окружения переводятся в структурные 4xx.
   */
  private async buildContext(adapter: ExecutorAdapter, declared: ProviderInstallation,
    command: ProviderInstallCommand, id: string, operation: ProviderInstallOperation,
    withShell: boolean): Promise<InstallContext> {
    void adapter;
    void operation;

    await fs.mkdir(this.probeScratch, { recursive: true, mode: 0o700 }).catch(() => {});

    try {
      return await buildInstallContext({
        config: this.ports.config as Record<string, unknown>,
        env: this.ports.env,
        roots: this.roots,
        home: this.home,
        scratch: this.probeScratch,
        cliName: command.npmBinding?.binName ?? String(adapter.bin(this.ports.config)),
        command,
        declared,
        operation,
        withShell,
        activeBindings: await this.activeBindings(),
        timeoutMs: this.ports.bashTimeoutMs,
      });
    } catch (error) {
      this.translateEnvironmentError(error);
    }
  }

  /**
   * Отказы окружения становятся структурированными 4xx с кодом причины.
   * Paths в сообщение не интерполируются: динамические пути — отдельные данные DTO.
   */
  private translateEnvironmentError(error: unknown): never {
    const code = (error as { code?: unknown }).code;

    if (typeof code === 'string' && ['npm_missing', 'npm_runtime_missing', 'npm_prefix_invalid',
      'npm_prefix_unwritable', 'npm_bin_conflict'].includes(code)) {
      throw new ProviderInstallError(code === 'npm_prefix_invalid' ? 400 : 409, code,
        error instanceof Error ? error.message : String(error));
    }

    throw error;
  }

  /**
   * Актуальные управляемые каталоги выводятся из текущих npm-bindings адаптеров:
   * настроенный bin внутри `<prefix>/bin` с пакетом под тем же prefix. Прежний
   * каталог без активного binding в управляемый блок не возвращается.
   */
  private async activeBindings(): Promise<ActiveBinding[]> {
    const adapters = await this.ports.adaptersOf();
    const config = this.ports.config as Record<string, unknown>;
    const result: ActiveBinding[] = [];

    for (const adapter of adapters.values()) {
      const declared = adapter.installation?.(this.ports.config, { npm: 'npm' });
      const binding = declared?.install.npmBinding ?? declared?.update?.npmBinding;

      if (!binding) {
        continue;
      }

      const binPath = config[binding.configKey];

      if (typeof binPath !== 'string' || !path.isAbsolute(binPath)) {
        continue;
      }

      const prefix = path.dirname(path.dirname(binPath));
      const packageRoot = path.join(prefix, 'lib', 'node_modules', ...binding.packageId.split('/'));
      const realpath = await fs.realpath(binPath).catch(() => null);

      if (!realpath || !await fs.stat(packageRoot).then((stat) => stat.isDirectory(), () => false)) {
        continue;
      }
      if (path.resolve(binPath) !== path.join(prefix, 'bin', binding.binName)) {
        continue;
      }

      result.push({
        name: binding.binName,
        directory: path.join(prefix, 'bin'),
        binPath,
        packageId: binding.packageId,
      });
    }

    return result;
  }

  /**
   * Снимки shell-файлов берутся только из уже собранного плана изменений.
   * По ним старт понимает, что человек изменил rc между preview и подтверждением.
   */
  private async shellFiles(context: InstallContext): Promise<ShellFileState[]> {
    const files = context.shell?.plan?.changes ?? [];
    const result: ShellFileState[] = [];

    for (const change of files) {
      const stat = await fs.lstat(change.file).catch(() => null);
      const bytes = stat?.isFile() ? await fs.readFile(change.file) : Buffer.alloc(0);

      result.push({
        file: change.file,
        exists: Boolean(stat),
        bytes,
        mode: stat ? stat.mode & 0o777 : 0,
        dev: stat?.dev ?? 0,
        ino: stat?.ino ?? 0,
      });
    }

    return result;
  }

  /**
   * Снимок цели установки фиксирует bytes/link/identity. Появление, замена или
   * удаление объекта требуют нового preview, а не установки поверх другого состояния.
   */
  private async binTarget(context: InstallContext): Promise<BinTargetState | null> {
    const target = context.npm?.target;

    if (!target) {
      return null;
    }

    const stat = await fs.lstat(target.target).catch(() => null);

    return {
      target: target.target,
      exists: Boolean(stat),
      link: stat ? await fs.readlink(target.target).catch(() => null) : null,
      realpath: stat ? await fs.realpath(target.target).catch(() => null) : null,
      identity: stat ? { dev: stat.dev, ino: stat.ino } : null,
    };
  }

  /**
   * Снимки сверяются непосредственно перед стартом: человек мог изменить rc,
   * prefix или ссылку между показом preview и подтверждением. Тогда нужен новый
   * preview, а не установка поверх другого состояния.
   */
  private async revalidatePreparation(record: PreparationRecord): Promise<void> {
    const context = record.context;

    for (const identity of context.npm?.identities ?? []) {
      const current = await this.runtimeIdentity(identity);

      if (!current || current.realpath !== identity.realpath || current.dev !== identity.dev
        || current.ino !== identity.ino) {
        throw new ProviderInstallError(409, 'preparation_changed',
          'Внешний Node или npm изменились после подготовки');
      }
    }

    if (context.npm) {
      const effective = await this.currentEffectivePrefix(context);

      if (path.resolve(String(effective)) !== path.resolve(context.npm.effectivePrefix)) {
        throw new ProviderInstallError(409, 'preparation_changed',
          'Каталог глобальной установки npm изменился после подготовки');
      }
    }

    const files = await this.shellFiles(context);

    if (files.length !== record.files.length
      || files.some((file, index) => !sameShellFile(file, record.files[index]!))) {
      throw new ProviderInstallError(409, 'preparation_changed',
        'Файл настройки оболочки изменился после подготовки');
    }

    const target = await this.binTarget(context);

    if (!sameBinTarget(target, record.target)) {
      throw new ProviderInstallError(409, 'preparation_changed',
        'Объект в каталоге установки изменился после подготовки');
    }
  }

  /**
   * Идентичность закреплённой пары Node/npm сверяется перед стартом по realpath
   * и dev/ino: подмена файла по тому же пути не должна пройти незамеченной.
   */
  private async runtimeIdentity(identity: RuntimeIdentity): Promise<RuntimeIdentity | null> {
    const realpath = await fs.realpath(identity.file).catch(() => null);

    if (!realpath) {
      return null;
    }

    const stat = await fs.stat(realpath).catch(() => null);

    if (!stat) {
      return null;
    }

    return {
      file: identity.file,
      realpath,
      dev: stat.dev,
      ino: stat.ino,
    };
  }

  /**
   * Повторная сверка prefix идёт тем же npm и окружением, без записи rc.
   * Смена global prefix означает, что preview показывал другой каталог.
   */
  private async currentEffectivePrefix(context: InstallContext): Promise<string> {
    if (!context.npm) {
      return '';
    }

    try {
      await fs.mkdir(this.probeScratch, { recursive: true, mode: 0o700 }).catch(() => {});

      return await readGlobalPrefix(context.npm.runtime, {
        cwd: this.probeScratch,
        timeoutMs: 10_000,
      });
    } catch {
      throw new ProviderInstallError(409, 'preparation_changed',
        'Не удалось повторно прочитать каталог глобальной установки npm');
    }
  }

  /**
   * Token принимается ровно один раз и только для своей операции, учётной записи
   * и исполнителя. Записи остаются в памяти, поэтому перезапуск делает их недействительными.
   */
  private takePreparation(token: string, id: string, operation: ProviderInstallOperation,
    scope: string): PreparationRecord {
    const record = this.preparations.get(token);

    if (!record) {
      throw new ProviderInstallError(409, 'preparation_invalid',
        'Подготовка операции не найдена: начните подтверждение заново');
    }
    if (record.providerId !== id || record.operation !== operation || record.scope !== scope) {
      throw new ProviderInstallError(409, 'preparation_invalid',
        'Подготовка относится к другому действию или учётной записи');
    }
    if (Date.now() >= record.expiresAt) {
      this.preparations.delete(token);

      throw new ProviderInstallError(409, 'preparation_expired',
        'Подготовка устарела: покажите изменения заново');
    }
    if (record.consumed) {
      throw new ProviderInstallError(409, 'preparation_consumed',
        'Эта подготовка уже использована');
    }

    record.consumed = true;

    return record;
  }

  /**
   * Старые подготовки не накапливаются: истёкшие удаляются, на область остаётся
   * не больше восьми. Ограничение относится только к памяти процесса.
   */
  private prunePreparations(scope: string): void {
    const now = Date.now();

    for (const [token, record] of this.preparations) {
      if (record.expiresAt <= now) {
        this.preparations.delete(token);
      }
    }

    const scoped = [...this.preparations.values()].filter((record) => record.scope === scope);

    while (scoped.length >= MAX_PREPARATIONS) {
      const oldest = scoped.shift();

      if (!oldest) {
        break;
      }

      this.preparations.delete(oldest.token);
    }
  }

  /**
   * Job и его приватный контекст создаются после всех проверок. Токен уже
   * употреблён, поэтому ошибка здесь не оставляет второго старта с ним.
   */
  private async launch(adapter: ExecutorAdapter, context: InstallContext, id: string,
    operation: ProviderInstallOperation, latest: string | undefined) {
    const command = context.command;
    const probe = await adapter.probe(this.ports.config);
    const now = Date.now();
    const job: ProviderInstallJob = {
      id: randomUUID(),
      providerId: id,
      operation,
      status: 'running',
      stage: 'download-install',
      before: String(probe.version || ''),
      after: '',
      outcome: null,
      error: null,
      warnings: [...(context.npm?.warnings ?? []), ...context.warnings],
      outputTail: '',
      command: context.npm?.displayCommand ?? command.command,
      fallbackCommand: command.fallbackCommand,
      loginCommand: context.loginCommand,
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    const cwd = this.ports.statePath
      ? path.join(path.dirname(this.ports.statePath), 'jobs', job.id) : undefined;

    if (cwd) {
      await fs.mkdir(cwd, { recursive: true, mode: 0o700 });
    }

    this.state.active = job;
    this.controller = new AbortController();
    await this.publish();

    const snapshot = this.snapshot();
    const completion = this.execute(adapter, context, job, cwd, latest);

    this.task = completion;

    return { snapshot, completion };
  }

  /**
   * Сначала проверяется код команды, затем версия установленного CLI.
   * Проверенная npm-копия сохраняется в настройке bin; настройка Bash идёт
   * отдельной стадией после commit и не откатывает успешную установку.
   */
  private async execute(adapter: ExecutorAdapter, context: InstallContext,
    job: ProviderInstallJob, cwd: string | undefined, latest: string | undefined):
    Promise<InstallResult> {
    let output = '';
    let finalStatus: ProviderInstallStatus = 'failed';
    let journal: MigrationJournal | null = null;
    let committed = false;

    try {
      const executable = await this.installerExecutable(context);

      if (context.npm?.migrate) {
        const intent = this.state.migration ?? createMigrationJournal({
          jobId: job.id,
          target: context.npm.target.target,
          inspection: context.npm.target,
          packageId: context.npm.packageId,
          binName: context.npm.binName,
          configKey: context.npm.configKey,
          oldBin: context.npm.oldBin ?? '',
        });

        if (!intent) {
          throw new ProviderInstallError(500, 'migration_recovery_required',
            'Прежняя bin-ссылка изменилась до начала миграции');
        }

        this.state.migration = intent;
        await this.publish();
        journal = await backupLegacyLink(intent);
        this.state.migration = journal;
        await this.publish();
      }

      const result = await this.runInstallation(executable, context, job, cwd);

      output = boundedOutput(result.stdout + result.stderr).trim().slice(-2000);

      if (result.timedOut) {
        throw new ProviderInstallError(500, 'timeout', 'Истёк срок ожидания команды (timeout)');
      }
      if (result.aborted || this.closing) {
        throw new ProviderInstallError(500, 'interrupted', 'Установка прервана остановкой сервера');
      }
      if (result.code !== 0) {
        if (output) {
          throw new Error(output);
        }

        throw new ProviderInstallError(500, 'command_exit_failed',
          'Команда установки завершилась с ошибкой');
      }

      if (!context.npm) {
        await this.connectNativeDirectories(adapter, context.nativeBinDirs);
      }

      job.stage = 'version';
      await this.publish();

      const binding = await this.prepareNpmBinding(context);
      const probe = await adapter.probe(binding?.config || this.ports.config);

      job.after = String(probe.version || '');

      if (!probe.ok || !parseVersion(job.after)) {
        throw new ProviderInstallError(500, 'version_unverified',
          'Не удалось проверить версию настроенной копии исполнителя');
      }
      if (job.operation === 'update' && isOutdated(job.after, latest)) {
        throw new ProviderInstallError(500, 'version_stale',
          'Действующая копия исполнителя не обновилась до доступной версии');
      }

      if (context.npm && journal) {
        journal = await inspectReplacement(journal);
        this.state.migration = journal;
        await this.publish();
      }

      if (binding) {
        await this.activateNpmBinding(context, binding.binary);
        committed = true;
      } else if (context.npm) {
        throw new ProviderInstallError(500, 'npm_binary_missing',
          'Не удалось найти установленную npm-копию исполнителя');
      }

      job.outcome = job.operation === 'install' ? 'installed'
        : String(parseVersion(job.before)) === String(parseVersion(job.after)) ? 'current' : 'updated';

      if (context.npm && binding) {
        job.migration = migrationNotice(context, binding.binary) ?? undefined;
      }

      if (context.npm) {
        job.stage = 'terminal';
        await this.publish();

        try {
          job.terminal = await this.runTerminalStage(context, job, binding);
        } catch {
          const failedBin = binding?.binary
            ?? path.join(context.npm.prefix, 'bin', context.npm.binName);

          job.terminal = {
            status: 'needs_setup',
            reason: 'terminal_setup_required',
            binDirectory: path.dirname(failedBin),
            shell: context.shell?.report.shell ?? 'other',
          };

          if (!job.warnings.some((entry) => typeof entry !== 'string'
            && entry.code === 'terminal_setup_required')) {
            job.warnings.push({
              code: 'terminal_setup_required',
              message: 'Настройка терминала не завершена; команда доступна после ручной настройки PATH',
            });
          }
        }
      }

      if (journal) {
        await completeMigration(journal);
        this.state.migration = null;
      }

      job.stage = 'models';
      await this.publish();

      try {
        await this.ports.refreshModels();
      } catch {
        job.warnings.push({ code: 'models_refresh_failed', message: 'Список моделей не обновлён' });
      }

      finalStatus = this.closing ? 'interrupted' : 'succeeded';
    } catch (error) {
      finalStatus = this.closing ? 'interrupted' : 'failed';

      if (journal && !committed) {
        const recovered = await this.recoverFailedMigration(journal);
        const code = finalStatus === 'interrupted' || !recovered ? 'migration_recovery_required'
          : error instanceof ProviderInstallError ? error.code : 'installation_failed';

        if (!recovered) {
          job.error = {
            code: 'migration_recovery_required',
            message: 'Прежняя bin-ссылка требует восстановления; новые установки запрещены',
          };
        } else {
          job.error = {
            code,
            message: finalStatus === 'interrupted' ? 'Установка прервана остановкой сервера'
              : errorMessage(error),
          };
        }
      } else {
        job.error = {
          code: finalStatus === 'interrupted' ? 'interrupted'
            : error instanceof ProviderInstallError ? error.code : 'installation_failed',
          message: errorMessage(error),
        };
      }

      job.outcome = null;
    } finally {
      if (this.outputTimer) {
        clearTimeout(this.outputTimer);
        this.outputTimer = null;
      }

      if (this.state.worker) {
        const stopped = await terminateOwnedWorker(this.state.worker).catch(() => false);

        if (stopped) {
          this.state.worker = null;
        } else {
          this.state.blockedReason = {
            code: 'worker_unconfirmed',
            message: 'Не удалось подтвердить остановку процесса установки',
          };
          finalStatus = 'interrupted';
          job.outcome = null;
          job.error = this.state.blockedReason;
        }
      }

      job.finishedAt = Date.now();
      job.updatedAt = job.finishedAt;

      try {
        await this.ports.invalidate();
      } catch (error) {
        job.warnings.push({
          code: 'updates_check_failed',
          message: `Не удалось проверить новые версии: ${errorMessage(error)}`,
        });
      }

      job.status = finalStatus;
      this.state.recent[job.providerId] = job;
      this.state.active = null;

      try {
        await this.publish();
      } catch (error) {
        this.state.blockedReason = {
          code: 'state_unavailable',
          message: `Состояние установки недоступно: ${errorMessage(error)}`,
        };
      }

      this.admitted = false;
      this.controller = null;

      if (cwd) {
        await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
      }
    }

    return {
      ok: job.status === 'succeeded',
      before: job.before,
      after: job.after,
      changed: job.status === 'succeeded' && job.outcome === 'updated',
      output,
    };
  }

  /**
   * Отказ до commit возвращает старую ссылку, если имя свободно или занято
   * доказанной заменой. Неизвестный объект остаётся вместе с журналом и
   * блокирует новые установки без повторного npm.
   */
  private async recoverFailedMigration(journal: MigrationJournal): Promise<boolean> {
    const restored = await restoreLegacyLink(journal);

    if (restored === 'restored') {
      this.state.migration = null;

      return true;
    }

    this.state.blockedReason = {
      code: 'migration_recovery_required',
      message: 'Прежняя bin-ссылка требует ручного восстановления; новые установки запрещены',
    };

    return false;
  }

  /**
   * Установщиком служит закреплённый внешний npm, а для native-команды —
   * её собственный исполняемый файл. npm из окружения сервера выбирается
   * только для прежней legacy-команды без нового контекста.
   */
  private async installerExecutable(context: InstallContext): Promise<string> {
    if (context.npm) {
      return context.npm.runtime.npm;
    }

    return context.command.executable === 'npm'
      ? await findProviderNpm(this.ports.env, this.ports.runtimePaths)
        .then((npm) => npm ?? '')
      : context.command.executable;
  }

  /**
   * Новая копия проверяется через временную конфигурацию адаптера и отдельный
   * внешний запуск с учётом формата bin. До успеха этих проверок bin не меняется.
   */
  private async prepareNpmBinding(context: InstallContext) {
    const npm = context.npm;

    if (!npm) {
      return null;
    }

    const binary = path.join(npm.prefix, 'bin', npm.binName);
    const stat = await fs.stat(binary).catch(() => null);

    if (!stat?.isFile()) {
      throw new ProviderInstallError(500, 'npm_binary_missing',
        'В выбранном npm-prefix отсутствует исполняемый файл CLI');
    }

    await fs.access(binary, constants.X_OK).catch(() => {
      throw new ProviderInstallError(500, 'npm_binary_missing',
        'Установленный файл CLI не исполняется');
    });

    await this.verifyExternalLaunch(context, binary);

    return {
      binary,
      config: { ...this.ports.config as object, [npm.configKey]: binary },
    };
  }

  /**
   * До commit JavaScript запускается выбранным Node, а Linux ELF — напрямую.
   * Обе формы используют внешнее окружение, подготовленное для установки.
   */
  private async verifyExternalLaunch(context: InstallContext, binary: string): Promise<void> {
    const npm = context.npm;

    if (!npm) {
      return;
    }

    const version = await externalVersion(npm.runtime, binary);

    if (version === null) {
      throw new ProviderInstallError(500, 'version_unverified',
        'Не удалось проверить версию установленной копии во внешнем окружении');
    }
  }

  /**
   * Общий писатель сохраняет bin для перезапуска, затем меняется текущий config.
   * При отказе записи прежний исполнитель остаётся выбранным и успех не объявляется.
   */
  private async activateNpmBinding(context: InstallContext, binary: string): Promise<void> {
    const npm = context.npm!;
    const config = this.ports.config as Record<string, unknown>;
    const changes = { [npm.envKey]: binary };

    this.controller!.signal.throwIfAborted();

    try {
      if (typeof config.envPath !== 'string' || !config.envPath) {
        throw new Error('Не задан файл настроек исполнителя');
      }

      await updateEnvFile(config.envPath, changes);
    } catch {
      throw new ProviderInstallError(500, 'npm_binding_failed',
        'Не удалось сохранить путь установленной npm-копии исполнителя');
    }

    config[npm.configKey] = binary;
    applyEnvChanges(changes, this.ports.env);
  }

  /**
   * Настройка терминала — отдельная стадия после commit. Неудача даёт
   * needs_setup/conflict с предупреждением и не откатывает рабочую привязку.
   */
  private async runTerminalStage(context: InstallContext, job: ProviderInstallJob,
    binding: { binary: string } | null): Promise<ProviderInstallTerminal> {
    const npm = context.npm!;
    const fallbackBin = binding?.binary ?? path.join(npm.prefix, 'bin', npm.binName);
    const binDirectory = path.dirname(fallbackBin);
    const shell = context.shell;

    if (!shell) {
      return {
        status: 'needs_setup',
        reason: 'terminal_setup_required',
        binDirectory,
        shell: 'other',
      };
    }
    if (shell.terminalSetup !== 'bash' || !shell.plan || !binding) {
      const reason = shell.reason ?? 'terminal_setup_required';

      return {
        status: reason === 'terminal_command_conflict' ? 'conflict' : 'needs_setup',
        reason,
        binDirectory,
        shell: shell.report.shell,
      };
    }

    job.loginCommand = context.loginCommand;

    const outcome = await setupBashTerminal({
      plan: shell.plan,
      env: this.ports.env,
      roots: this.roots,
      home: this.home,
      scratch: this.probeScratch,
      bash: shell.report.bash ?? '/bin/bash',
      cliName: npm.binName,
      expectedBin: binding.binary,
      expectedVersion: job.after,
      nonce: randomBytes(12).toString('base64url'),
      timeoutMs: this.ports.bashTimeoutMs,
      signal: this.controller!.signal,
    });

    for (const warning of outcome.warnings) {
      if (!job.warnings.some((entry) => typeof entry !== 'string' && entry.code === warning.code)) {
        job.warnings.push(warning);
      }
    }

    return outcome.terminal;
  }

  /**
   * Повторяется только установка того же CLI, с тем же закреплённым контекстом.
   * Общий срок и admission сохраняются; новый worker допустим лишь после остановки прежнего.
   */
  private async runInstallation(executable: string, context: InstallContext,
    job: ProviderInstallJob, cwd: string | undefined) {
    const signal = this.controller!.signal;
    const deadline = Date.now() + INSTALL_TIMEOUT_MS;
    const npm = context.npm;
    let attempt = 0;

    if (!executable) {
      throw new ProviderInstallError(500, 'npm_missing',
        'npm не найден в пользовательском PATH сервера');
    }

    return withRetry(async (index) => {
      attempt = index;
      signal.throwIfAborted();

      if (Date.now() >= deadline) {
        throw new ProviderInstallError(500, 'timeout', 'Истёк срок ожидания команды (timeout)');
      }

      return (this.ports.runCommand || runCommand)(executable,
        npm ? npm.args : context.command.args, {
          cwd,
          env: npm ? npm.runtime.env : this.ports.env,
          timeoutMs: Math.max(1, deadline - Date.now()),
          signal,
          onStdout: (chunk) => this.append(job, chunk),
          onStderr: (chunk) => this.append(job, chunk),
          ownership: {
            started: async (worker) => {
              this.state.worker = worker;
              await this.publish();
            },
            finished: async () => {
              this.state.worker = null;
              await this.publish();
            },
          },
        });
    }, {
      attempts: RETRY_DELAYS_MS.length + 1,
      delaysMs: RETRY_DELAYS_MS,
      retryOnError: () => false,
      retryWhen: (result) => !this.closing && !signal.aborted && !this.state.worker
        && !this.state.blockedReason && Date.now() + (RETRY_DELAYS_MS[attempt] ?? 0) < deadline
        && isTransientInstallFailure(result),
      sleep: async (ms) => {
        job.retry = {
          attempt: attempt + 2,
          attempts: RETRY_DELAYS_MS.length + 1,
        };
        job.updatedAt = Date.now();
        await this.publish();

        if (this.ports.retrySleep) {
          await this.ports.retrySleep(ms, signal);
        } else {
          await sleep(ms, undefined, { signal });
        }
      },
    });
  }

  /**
   * Новый native каталог добавляется только после появления исполняемого файла.
   * Явный абсолютный bin и прежний порядок PATH сохраняются для configured probe.
   */
  private async connectNativeDirectories(adapter: ExecutorAdapter, directories: string[]): Promise<void> {
    const entries = (this.ports.env.PATH || '').split(path.delimiter);
    const basename = path.basename(String(adapter.bin(this.ports.config)));

    for (const directory of directories) {
      if (path.isAbsolute(directory) && !entries.includes(directory)
        && await fs.access(path.join(directory, basename), constants.X_OK).then(() => true, () => false)) {
        entries.push(directory);
      }
    }

    this.ports.env.PATH = entries.join(path.delimiter);
  }

  /**
   * Завершение сервера прекращает admission и дожидается только своего worker.
   * Закрытие окна не вызывает этот lifecycle и не посылает abort.
   */
  async dispose(): Promise<void> {
    this.closing = true;
    this.controller?.abort();
    await this.task;
    await this.writes;

    if (this.outputTimer) {
      clearTimeout(this.outputTimer);
      this.outputTimer = null;
    }
  }
}

/**
 * Прежний маршрут обновления без декларации сохраняет поведение старого клиента:
 * команда берётся из updateCmd, но прав на rc и legacy-ссылку не получает.
 */
function legacyUpdateCommand(adapter: ExecutorAdapter, config: unknown,
  operation: ProviderInstallOperation): ProviderInstallCommand | null {
  if (operation !== 'update' || !adapter.updateCmd?.length) {
    return null;
  }

  const executable = String(adapter.bin(config));
  const text = [executable, ...adapter.updateCmd].join(' ');

  return {
    executable,
    args: [...adapter.updateCmd],
    command: text,
    fallbackCommand: text,
  };
}

function migrationNotice(context: InstallContext, binary: string): ProviderInstallMigration | null {
  const from = context.npm?.oldBin;

  return from && path.resolve(from) !== path.resolve(binary) ? { from, to: binary } : null;
}

const sameShellFile = (left: ShellFileState, right: ShellFileState): boolean => left.file === right.file
  && left.exists === right.exists && left.mode === right.mode && left.dev === right.dev
  && left.ino === right.ino && left.bytes.equals(right.bytes);

const sameBinTarget = (left: BinTargetState | null, right: BinTargetState | null): boolean => {
  if (!left || !right) {
    return left === right;
  }

  const identity = (value: BinIdentity | null): string => value ? `${value.dev}:${value.ino}` : '-';

  return left.target === right.target && left.exists === right.exists && left.link === right.link
    && left.realpath === right.realpath && identity(left.identity) === identity(right.identity);
};

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Хвост ограничен строками и байтами независимо от разбиения stdout на чанки.
 * Отрезанный UTF-8 префикс удаляется до декодирования, escape-последовательности не рисуются.
 */
function boundedOutput(text: string): string {
  const cleaned = text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, '');
  const lines = cleaned.split('\n').slice(-200).join('\n');
  const bytes = Buffer.from(lines);
  let start = Math.max(0, bytes.length - 32 * 1024);

  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) {
    start += 1;
  }

  return bytes.subarray(start).toString('utf8');
}
