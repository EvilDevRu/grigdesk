import { randomUUID } from 'node:crypto';
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { ExecutorAdapter, ProviderInstallCommand } from '../executors/index.ts';
import { isOutdated, parseVersion } from '../executors/_npmLatest.ts';
import { runCommand, type PluginCommandRunner } from '../pluginInstall/runCommand.ts';
import { terminateOwnedWorker } from '../pluginInstall/workerIdentity.ts';
import { withRetry } from '../retry.ts';
import { applyEnvChanges, updateEnvFile } from '../envFile.ts';
import { findProviderNpm, installedNpmBinary, resolveProviderInstallation } from './commands.ts';
import { isTransientInstallFailure } from './networkFailure.ts';
import { readInstallState, writeInstallState, type ProviderInstallState } from './stateStore.ts';
import type {
  ProviderInstallJob,
  ProviderInstallOperation,
  ProviderInstallSnapshot,
  ProviderInstallStatus,
} from '../../../../shared/chat/providerInstallContracts.ts';

export interface ProviderInstallOptions {
  runCommand?: PluginCommandRunner;
  runtimePaths?: { kind: string; node: string };
  retrySleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const RETRY_DELAYS_MS = [2000, 5000];

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
  };
  private initialization: Promise<void> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private admitted = false;
  private closing = false;
  private controller: AbortController | null = null;
  private task: Promise<LegacyResult> | null = null;
  private outputTimer: ReturnType<typeof setTimeout> | null = null;

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

        this.state = saved;

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
   * Действие выбирает только серверную декларацию и заново проверяет installed.
   * Legacy-клиент без новой capability получает тот же глобальный lock.
   */
  async start(id: string, operation: ProviderInstallOperation, legacy = false) {
    if (this.admitted || this.closing) {
      throw new ProviderInstallError(409, 'busy', 'Уже идёт установка исполнителя');
    }

    this.admitted = true;

    try {
      await this.initialize();

      if (this.state.blockedReason) {
        const reason = this.state.blockedReason;

        throw new ProviderInstallError(409, typeof reason === 'string' ? 'state_unavailable' : reason.code,
          typeof reason === 'string' ? reason : reason.message);
      }
      if (this.state.active) {
        throw new ProviderInstallError(409, 'busy', 'Уже идёт установка исполнителя');
      }

      const adapter = (await this.ports.adaptersOf()).get(id);

      if (!adapter) {
        throw new ProviderInstallError(404, 'unknown_provider', 'Исполнитель не найден');
      }
      if (adapter.distribution?.(this.ports.config)?.managed === true) {
        throw new ProviderInstallError(400, 'no_update', 'Обновите управляемую поставку отдельно');
      }

      const declared = await resolveProviderInstallation(adapter, this.ports.config,
        this.ports.env, this.ports.runtimePaths);
      let command = declared?.[operation];

      if (!declared && legacy && operation === 'update' && adapter.updateCmd) {
        const executable = String(adapter.bin(this.ports.config));
        const text = [executable, ...adapter.updateCmd].join(' ');

        command = {
          executable,
          args: [...adapter.updateCmd],
          command: text,
          fallbackCommand: text,
        };
      }
      if (!command) {
        throw new ProviderInstallError(400, 'unsupported_action', 'Исполнитель не поддерживает это действие');
      }

      const probe = await adapter.probe(this.ports.config);

      if ((operation === 'install') === !!probe.ok) {
        throw new ProviderInstallError(409, probe.ok ? 'already_installed' : 'not_installed',
          probe.ok ? 'Исполнитель уже установлен' : 'Исполнитель ещё не установлен');
      }

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
        warnings: [],
        outputTail: '',
        command: command.command,
        fallbackCommand: command.fallbackCommand,
        loginCommand: declared?.loginCommand || adapter.login || '',
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
      const completion = this.execute(adapter, command, job, cwd, declared?.nativeBinDirs || []);

      this.task = completion;

      return { snapshot, completion };
    } catch (error) {
      this.admitted = false;

      throw error;
    }
  }

  /**
   * Сначала проверяется код команды, затем версия установленного CLI.
   * Проверенная npm-копия сохраняется в настройке bin до обновления каталога моделей.
   * Сбой каталога моделей даёт предупреждение после уже доказанного успеха установки.
   */
  private async execute(adapter: ExecutorAdapter, command: ProviderInstallCommand,
    job: ProviderInstallJob, cwd: string | undefined, nativeDirs: string[]): Promise<LegacyResult> {
    let output = '';
    let finalStatus: ProviderInstallStatus = 'failed';

    try {
      const executable = command.executable === 'npm'
        ? await findProviderNpm(this.ports.env, this.ports.runtimePaths) : command.executable;

      if (!executable) {
        throw new ProviderInstallError(500, 'npm_missing', 'npm не найден в пользовательском PATH сервера');
      }

      const result = await this.runInstallation(executable, command, job, cwd);

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

        throw new ProviderInstallError(500, 'command_exit_failed', 'Команда установки завершилась с ошибкой');
      }

      await this.connectNativeDirectories(adapter, nativeDirs);
      job.stage = 'version';
      await this.publish();

      const binding = await this.prepareNpmBinding(command, executable);
      const probe = await adapter.probe(binding?.config || this.ports.config);

      job.after = String(probe.version || '');

      if (!probe.ok || !parseVersion(job.after)) {
        throw new ProviderInstallError(500, 'version_unverified',
          'Не удалось проверить версию настроенной копии исполнителя');
      }
      if (job.operation === 'update' && isOutdated(job.after, this.ports.latestOf(job.providerId))) {
        throw new ProviderInstallError(500, 'version_stale',
          'Действующая копия исполнителя не обновилась до доступной версии');
      }

      if (binding) {
        await this.activateNpmBinding(command, binding.binary);
      }

      job.outcome = job.operation === 'install' ? 'installed'
        : String(parseVersion(job.before)) === String(parseVersion(job.after)) ? 'current' : 'updated';
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
      job.outcome = null;
      job.error = {
        code: finalStatus === 'interrupted' ? 'interrupted'
          : error instanceof ProviderInstallError ? error.code : 'installation_failed',
        message: errorMessage(error),
      };
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
   * Новая копия проверяется через временную конфигурацию адаптера.
   * До успешного probe действующий bin и окружение сервера не меняются.
   */
  private async prepareNpmBinding(command: ProviderInstallCommand, executable: string) {
    if (!command.npmBinding) {
      return null;
    }

    try {
      const binary = await installedNpmBinary(executable, command.npmBinding.binName,
        this.ports.env, this.controller!.signal);

      return {
        binary,
        config: { ...this.ports.config as object, [command.npmBinding.configKey]: binary },
      };
    } catch {
      throw new ProviderInstallError(500, 'npm_binary_missing',
        'Не удалось найти установленную npm-копию исполнителя');
    }
  }

  /**
   * Общий писатель сохраняет bin для перезапуска, затем меняется текущий config.
   * При отказе записи прежний исполнитель остаётся выбранным и успех не объявляется.
   */
  private async activateNpmBinding(command: ProviderInstallCommand, binary: string): Promise<void> {
    const { configKey, envKey } = command.npmBinding!;
    const config = this.ports.config as Record<string, unknown>;
    const changes = { [envKey]: binary };

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

    config[configKey] = binary;
    applyEnvChanges(changes, this.ports.env);
  }

  /**
   * Повторяется только установка того же CLI, без повторного запуска проверок и моделей.
   * Общий срок и admission сохраняются; новый worker допустим лишь после остановки прежнего.
   */
  private async runInstallation(executable: string, command: ProviderInstallCommand,
    job: ProviderInstallJob, cwd: string | undefined) {
    const signal = this.controller!.signal;
    const deadline = Date.now() + INSTALL_TIMEOUT_MS;
    let attempt = 0;

    return withRetry(async (index) => {
      attempt = index;
      signal.throwIfAborted();

      if (Date.now() >= deadline) {
        throw new ProviderInstallError(500, 'timeout', 'Истёк срок ожидания команды (timeout)');
      }

      return (this.ports.runCommand || runCommand)(executable, command.args, {
        cwd,
        env: this.ports.env,
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

interface LegacyResult {
  ok: boolean;
  before: string;
  after: string;
  changed: boolean;
  output: string;
}

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
