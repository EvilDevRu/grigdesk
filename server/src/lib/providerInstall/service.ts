import { randomBytes, randomUUID } from 'node:crypto';
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
import { readInstallState, writeInstallState, type ProviderInstallState } from './stateStore.ts';
import { setupBashTerminal } from './terminalSetup.ts';
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

  private readonly ports: ServicePorts;

  constructor(ports: ServicePorts) {
    this.ports = ports;
  }

  /**
   * DTO собирается явно, чтобы ownership никогда не попадал в SSE или HTTP.
   * Копия защищает сохранённый результат от изменения потребителем.
   */
  snapshot(): ProviderInstallSnapshot {
    const { revision, active, recent, blockedReason } = this.state;

    return structuredClone({
      revision,
      active,
      recent,
      blockedReason,
    });
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

        if (saved.active || saved.worker) {
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

          await this.publish();
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
    const writing = this.writes.then(async () => {
      if (this.ports.statePath) {
        await writeInstallState(this.ports.statePath, saved);
      }

      this.ports.broadcast(publicSnapshot);
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
   * Оба потока объединяются в ограниченный текст без терминальных escape-команд.
   * Публикация пачками ограничивает нагрузку SSE и диска при многословном installer.
   */
  private append(job: ProviderInstallJob, text: string): void {
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
