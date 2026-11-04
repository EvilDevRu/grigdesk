import { execFile } from 'node:child_process';
import { randomUUID, createPublicKey, verify as verifyBytes } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { ReleaseStatus, UpdateJob } from '../../../shared/runtime/grigDeskUpdateContracts.ts';
import type { ReleaseServicesOptions } from './releaseServices.ts';
import type { ReleaseManifest } from './releaseManifest.ts';
import type { RuntimeBuildContext } from './runtimeBuildContext.ts';
import { runtimeBuildContext } from './runtimeBuildContext.ts';
import { runtimeInstallationRoot } from './runtimePaths.ts';

import { sha256File } from '../../../shared/node/hash.ts';
import {
  RELEASE_SIGNING_PUBLIC_KEY, isStableReleaseVersion,
} from '../../../shared/runtime/releaseChannelContracts.ts';

import { compareSemVer } from './releaseCommon.ts';
import type { ChannelEntry }
  from '../../../shared/runtime/releaseChannelContracts.ts';

const execute = promisify(execFile);

export interface PackagedServiceOptions {
  channel?: { latest(force?: boolean): Promise<ChannelEntry | null> };
  installVersionReader?(): Promise<string | null>;
  checkIntervalMs?: number;
}

export interface PackagedIdentity {
  version: string;
  contentId: string;
  packageId: string | null;
}

/**
 * Identity берётся только из настроенного payload context, без host env и git.
 * Физический корень имеет canonical basename packageId и известный путь CJS.
 */
export function runtimePackageId(context = runtimeBuildContext()): string | null {
  if (context.mode !== 'payload') {
    return null;
  }

  const root = path.dirname(path.dirname(context.bundleFile));
  const packageId = path.basename(root);

  if (!/^[a-f0-9]{64}$/u.test(packageId) || realpathSync(root) !== root
    || context.bundleFile !== path.join(root, 'server/payload.cjs')
    || realpathSync(context.bundleFile) !== context.bundleFile) {
    throw new Error('Некорректный корень packageId в контексте payload');
  }

  return packageId;
}

/**
 * Legacy сохраняет schema1 release.json, payload читает защищённый VERSION.
 * Полный индекс не дублируется в R и не создаёт self-hash cycle manifest.
 */
export async function readPackagedIdentity(root: string,
  context = runtimeBuildContext()): Promise<PackagedIdentity> {
  const packageId = runtimePackageId(context);

  if (packageId) {
    if (context.mode !== 'payload' || path.dirname(path.dirname(context.bundleFile)) !== root) {
      throw new Error('Корень статуса не совпал с контекстом payload');
    }

    const handle = await open(path.join(root, 'VERSION'), constants.O_RDONLY | constants.O_NOFOLLOW);

    try {
      const info = await handle.stat();

      if (!info.isFile() || (info.mode & 0o777) !== 0o444 || info.size > 128) {
        throw new Error('Повреждён защищённый VERSION серверного payload');
      }

      const version = (await handle.readFile('utf8')).trim();

      if (!isStableReleaseVersion(version)) {
        throw new Error('Неподдерживаемая версия серверного payload');
      }

      return {
        version,
        contentId: packageId,
        packageId,
      };
    } finally {
      await handle.close();
    }
  }

  const manifest = JSON.parse(await readFile(path.join(root, 'release.json'), 'utf8')) as ReleaseManifest;

  if (manifest.schema !== 1 || manifest.packagingVersion !== 1 || !manifest.version
    || !/^[a-f0-9]{64}$/.test(manifest.contentId)) {
    throw new Error('Повреждён manifest серверного пакета GrigDesk');
  }

  return {
    version: manifest.version,
    contentId: manifest.contentId,
    packageId: null,
  };
}

export const PACKAGE_UPDATE_MESSAGE = 'Установите новый пакет GrigDesk';
export const PACKAGE_UPDATE_ERROR = 'packaged_update_requires_package';

/**
 * Отказ source-мутации не импортирует worker и не касается журналов обновления.
 * Код и HTTP-статус совпадают у менеджера и у ранних серверных ворот.
 */
export function packagedUpdateError(): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(PACKAGE_UPDATE_MESSAGE), {
    code: PACKAGE_UPDATE_ERROR,
    statusCode: 409,
  });
}

/**
 * Версия физической установки читается из описи bin/bundle.json: замена bin при
 * обновлении меняет и её, не трогая защищённый identity payload. Отсутствие описи
 * не ошибка: источник возвращается к identity.
 */
export async function readInstallVersion(installRoot: string): Promise<string | null> {
  try {
    const bundle = JSON.parse(await readFile(
      path.join(installRoot, 'bin', 'bundle.json'), 'utf8',
    )) as {
      format?: unknown;
      kind?: unknown;
      version?: unknown
    };

    if (bundle.format !== 1 || bundle.kind !== 'portable'
      || !isStableReleaseVersion(bundle.version)) {
      return null;
    }

    return bundle.version;
  } catch {
    return null;
  }
}

/**
 * Статус пакета соединяет identity своего R, версию установки и снимок канала.
 * Локальный GET не ходит в сеть; таймер канала включается только с явной опцией.
 */
export class PackagedReleaseService {
  readonly instanceId = randomUUID();

  private readonly startedAt = new Date().toISOString();

  private readonly rootDir: string;

  private readonly identityReader: (root: string) => Promise<PackagedIdentity>;

  private channelSnapshot: {
    entry: ChannelEntry;
    checkedAt: string
  } | null = null;

  private timer: ReturnType<typeof setInterval> | null = null;

  private channelCheckedAt: string | null = null;

  private channelError: ReleaseStatus['checkError'] = null;

  private readonly options: PackagedServiceOptions;

  constructor(rootDir: string, identityReader = readPackagedIdentity,
    options: PackagedServiceOptions = {}) {
    this.options = options;
    this.rootDir = rootDir;
    this.identityReader = identityReader;
  }

  /**
   * Формирует прежний DTO для совместимости клиента и объявляет package capability.
   * Checkout-поля пусты: UI выбирает представление пакета по capability.
   */
  async getStatus(_options?: { fresh?: boolean }): Promise<ReleaseStatus> {
    const manifest = await this.identityReader(this.rootDir);
    const installed = await (this.options.installVersionReader
      ?? (async () => {
        return readInstallVersion(this.rootDir);
      }))();
    const current = installed ?? manifest.version;

    const version = {
      version: current,
      stableVersion: current,
      exactTag: null,
      productVersion: current,
      versionTagMismatch: false,
    };

    const status: ReleaseStatus = {
      updateCapability: { kind: 'package', message: PACKAGE_UPDATE_MESSAGE },
      running: {
        ...version,
        sha: manifest.contentId,
        ...(manifest.packageId ? { packageId: manifest.packageId } : {}),
        instanceId: this.instanceId,
        startedAt: this.startedAt,
      },
      checkout: {
        ...version,
        sha: '',
        branch: null,
        detached: false,
        dirty: false,
      },
      latest: null,
      checkoutChanged: false,
      checkoutRelation: 'unknown',
      targetDescendsFromCheckout: null,
      updateAvailable: false,
      canApplyCheckout: false,
      canInstallRelease: false,
      applyBlockReasons: [PACKAGE_UPDATE_ERROR],
      installBlockReasons: [PACKAGE_UPDATE_ERROR],
      blockReasons: [PACKAGE_UPDATE_ERROR],
      checkedAt: null,
      checkError: null,
      job: null,
    };

    return this.#withSnapshot(status);
  }

  /**
   * Remote-проверка пакета — чтение канала сайта: снимок сохраняется и вклеивается
   * в локальный getStatus без сети. Недоступный канал не портит локальный статус.
   */
  async checkRemote(): Promise<ReleaseStatus> {
    if (!this.options.channel) {
      return this.getStatus();
    }

    try {
      const entry = await this.options.channel.latest();

      this.channelCheckedAt = new Date().toISOString();
      this.channelError = null;
      this.channelSnapshot = entry ? {
        entry,
        checkedAt: this.channelCheckedAt
      } : null;
    } catch (error) {
      this.channelSnapshot = null;
      this.channelCheckedAt = new Date().toISOString();
      this.channelError = {
        code: 'release_channel_unavailable',
        message: (error as Error).message,
      };
    }

    return this.getStatus();
  }

  /**
   * Снимок канала добавляет latest/updateAvailable/packageUpdate к локальному статусу.
   * Сравнение идёт с текущей версией установки (опись, затем identity).
   */
  #withSnapshot(status: ReleaseStatus): ReleaseStatus {
    if (!this.channelSnapshot) {
      return {
        ...status,
        checkedAt: this.channelCheckedAt,
        checkError: this.channelError
      };
    }

    const { entry, checkedAt } = this.channelSnapshot;
    const newer = compareSemVer(entry.version, status.running.version) > 0;

    return {
      ...status,
      latest: {
        version: entry.version,
        tag: `v${entry.version}`,
        sha: entry.commit,
        url: null,
      },
      updateAvailable: newer,
      packageUpdate: newer ? {
        version: entry.version,
        archiveSha256: entry.archiveSha256,
      } : null,
      checkedAt,
      checkError: null,
    };
  }

  /**
   * Фоновый опрос канала раз в 6 часов. Без канала таймер не создаётся, чтобы
   * фабрика в тестах не держала процесс; unref не мешает штатному выходу.
   */
  start(): void {
    if (!this.options.channel || this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      this.checkRemote().catch(() => {});
    }, this.options.checkIntervalMs ?? 6 * 60 * 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }

    this.timer = null;
  }

  invalidate(): void {}
}

export type PackageUpdateStage = 'queued' | 'verifying' | 'downloading' | 'unpacking'
  | 'probing' | 'applying' | 'restarting' | 'completed' | 'failed';

const ACTIVE_PACKAGE_STAGES = new Set<string>(['queued', 'verifying', 'downloading',
  'unpacking', 'probing', 'applying', 'restarting']);

export interface PackageUpdateJob extends UpdateJob {
  id: string;
  kind: 'package-update';
  status: PackageUpdateStage;
  stage: PackageUpdateStage;
  targetVersion: string;
  expectedArchiveSha256: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  progress: {
    downloadedBytes: number;
    totalBytes: number
  } | null;
  backups: {
    bin: string | null;
    window: string | null;
    readme: string | null
  } | null;
  error: {
    code: string;
    message: string
  } | null;
}

export interface PackagedUpdateOptions {
  installRoot: string;
  statePath: string;
  workRoot?: string;
  channel?: { latest(force?: boolean): Promise<ChannelEntry | null> };
  publicKeyPem?: string;
  fetcher?: typeof globalThis.fetch;
  prober?(binary: string): Promise<string>;
  onRestart?(): void | Promise<void>;
}

/**
 * Атомарная замена файла состояния: запись во временный файл и rename, режим 0600.
 * Импорт source-помощников запрещён SEA-графом, поэтому локальная копия паттерна.
 */
async function writeJobState(statePath: string, job: PackageUpdateJob): Promise<void> {
  const temporary = `${statePath}.tmp`;

  await writeFile(temporary, `${JSON.stringify({
    schemaVersion: 1,
    job
  }, null, 2)}\n`,
    { mode: 0o600 });
  await rename(temporary, statePath);
}

/**
 * Чтение задания не обращается к source-журналу обновлений.
 * Отсутствующий файл означает, что пакет ещё не обновлялся.
 */
async function readJobState(statePath: string): Promise<PackageUpdateJob | null> {
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8')) as { job?: unknown };

    return (state.job as PackageUpdateJob) ?? null;
  } catch {
    return null;
  }
}

/**
 * Менеджер обновления пакетной установки. Задание выполняется в процессе сервера:
 * ключ и подпись канала проверяются до скачивания, замена — rename с резервами,
 * рестарт — через внедрённый onRestart. Любой отказ до applying оставляет установку
 * нетронутой; отказ в applying откатывается резервами.
 */
export class PackagedUpdateManager {
  private readonly options: PackagedUpdateOptions;

  constructor(options: PackagedUpdateOptions) {
    this.options = options;
  }

  async getJob(): Promise<PackageUpdateJob | null> {
    return readJobState(this.options.statePath);
  }

  /**
   * Подтверждение рестарта относится только к указанному сохранённому заданию.
   * Проверка не выполняет recover и не подтверждает версию старым процессом.
   */
  async isRestarting(jobId: string): Promise<boolean> {
    const job = await this.getJob();

    return job?.id === jobId && job.status === 'restarting';
  }

  /**
   * Старт нового процесса подтверждает заменённую версию либо возвращает резервы.
   * Прерванное скачивание завершается отказом без изменения действующей установки.
   */
  async recover(): Promise<void> {
    const job = await this.getJob();

    if (!job || !ACTIVE_PACKAGE_STAGES.has(job.status)) {
      await rm(`${this.options.statePath}.job-lock`, {
        recursive: true,
        force: true
      });

      return;
    }
    if (job.status === 'restarting') {
      const installed = await readInstallVersion(this.options.installRoot);

      if (installed === job.targetVersion) {
        await this.#complete(job);
      } else {
        await this.#fail(job, 'restart_not_confirmed',
          'Сервер перезапущен, но версия установки не совпала с целью.');
      }

      return;
    }
    if (job.status === 'applying') {
      if (!job.backups) {
        await this.#fail(job, 'manual_recovery_required',
          `Замена прервана без резервов: установка ${this.options.installRoot}`
          + ' требует ручного осмотра bin и GrigDesk.');

        return;
      }

      const restored = await this.#rollback(job);

      if (restored) {
        await this.#fail(job, 'package_apply_interrupted',
          'Обновление прервано в середине замены; резервы возвращены.');
      } else {
        await this.#failPreserving(job, 'package_apply_interrupted');
      }

      return;
    }

    await rm(this.#workDir(job), {
      recursive: true,
      force: true
    }).catch(() => {});
    await this.#fail(job, 'package_update_interrupted',
      'Обновление прервано до замены файлов; установка не тронута.');
  }

  /**
   * Активное задание запрещает вторую установку и отдельную команду перезапуска.
   * Проверка читает сохранённый статус, поэтому переживает закрытие клиентского окна.
   */
  async assertIdle(): Promise<void> {
    const job = await this.getJob();

    if (job && ACTIVE_PACKAGE_STAGES.has(job.status)) {
      throw Object.assign(new Error('Обновление пакета уже выполняется.'), {
        code: 'package_update_in_progress',
        statusCode: 409,
      });
    }
  }

  async startApply(_request: unknown): Promise<PackageUpdateJob> {
    throw packagedUpdateError();
  }

  async startUpdate(_request: unknown): Promise<PackageUpdateJob> {
    throw packagedUpdateError();
  }

  /**
   * Подтверждённая запись канала сверяется под исключающим каталогом задания.
   * До создания задания проверяется portable-раскладка и неизменность выбранной цели.
   */
  async startPackageUpdate(request: {
    expectedVersion: string;
    expectedArchiveSha256: string;
  }): Promise<PackageUpdateJob> {
    // Lock-каталог по образцу source-менеджера: один исполнитель задания на установку.
    const lockPath = `${this.options.statePath}.job-lock`;

    await mkdir(path.dirname(this.options.statePath), {
      recursive: true,
      mode: 0o700
    });

    try {
      await mkdir(lockPath, { mode: 0o700 });
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'EEXIST') {
        throw Object.assign(new Error('Обновление пакета уже выполняется.'), {
          code: 'package_update_in_progress',
          statusCode: 409,
        });
      }

      throw error;
    }

    try {
      await this.assertIdle();

      if (!this.options.channel) {
        throw Object.assign(new Error('Канал обновлений не настроен.'), {
          code: 'package_channel_unavailable',
          statusCode: 409,
        });
      }

      const installed = await readInstallVersion(this.options.installRoot);

      if (!installed) {
        throw Object.assign(new Error(
          'Обновление доступно только переносимой установке с bin/bundle.json.',
        ), {
          code: 'package_update_unsupported_layout',
          statusCode: 409
        });
      }

      const entry = await this.options.channel.latest(true);

      if (!entry || entry.version !== request.expectedVersion
        || entry.archiveSha256 !== request.expectedArchiveSha256) {
        throw Object.assign(new Error('Канал изменился после подтверждения.'), {
          code: 'package_target_changed',
          statusCode: 409,
        });
      }
      if (!entry.archiveUrl) {
        throw Object.assign(new Error('Канал не содержит адрес архива.'), {
          code: 'package_archive_url_missing',
          statusCode: 409,
        });
      }

      const now = new Date().toISOString();
      const job: PackageUpdateJob = {
        id: randomUUID(),
        kind: 'package-update',
        status: 'queued',
        stage: 'queued',
        targetVersion: entry.version,
        expectedArchiveSha256: entry.archiveSha256,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        progress: null,
        backups: null,
        error: null,
      };

      await writeJobState(this.options.statePath, job);
      void this.#run(job, entry).catch(() => {});

      return job;
    } catch (error) {
      await rm(lockPath, {
        recursive: true,
        force: true
      }).catch(() => {});

      throw error;
    }
  }

  /**
   * Staging живёт внутри установки: распаковка и замены остаются в одной файловой
   * системе (rename через границу дисков дал бы EXDEV).
   */
  #workDir(job: PackageUpdateJob): string {
    return path.join(this.options.workRoot ?? path.join(this.options.installRoot,
      '.grigdesk-update'), `package-update-${job.id}`);
  }

  /**
   * Переход стадии публикует один атомарный снимок для API и восстановления.
   * Память задания сохраняет ту же стадию для последующих проверок и отказов.
   */
  async #setStage(job: PackageUpdateJob, stage: PackageUpdateStage,
    patch: Partial<PackageUpdateJob> = {}): Promise<void> {
    job.status = stage;
    job.stage = stage;
    job.updatedAt = new Date().toISOString();
    await writeJobState(this.options.statePath, {
      ...job,
      ...patch
    });
  }

  /**
   * Терминальный отказ сохраняется перед освобождением staging и замка.
   * Рабочие файлы установки и оставшиеся резервы здесь не удаляются.
   */
  async #fail(job: PackageUpdateJob, code: string, message: string): Promise<void> {
    job.status = 'failed';
    job.stage = 'failed';
    job.completedAt = new Date().toISOString();
    job.updatedAt = job.completedAt;
    job.error = {
      code,
      message
    };
    await writeJobState(this.options.statePath, job);
    await rm(this.#workDir(job), {
      recursive: true,
      force: true
    }).catch(() => {});
    await rm(`${this.options.statePath}.job-lock`, {
      recursive: true,
      force: true
    })
      .catch(() => {});
  }

  /**
   * Ошибка отката содержит пути для ручного восстановления и имеет приоритет.
   * Общий терминальный отказ не заменяет её менее точным кодом установки.
   */
  async #failPreserving(job: PackageUpdateJob, code: string): Promise<void> {
    const preserved = job.error;

    await this.#fail(job, code, preserved?.message ?? 'Замена прервана.');
    job.error = preserved ?? job.error;
    await writeJobState(this.options.statePath, job);
  }

  /**
   * Подтверждённый новый запуск завершает задание и удаляет его резервы.
   * Остатки staging и замок освобождаются после записи результата.
   */
  async #complete(job: PackageUpdateJob): Promise<void> {
    job.status = 'completed';
    job.stage = 'completed';
    job.completedAt = new Date().toISOString();
    job.updatedAt = job.completedAt;
    await writeJobState(this.options.statePath, job);

    for (const backup of [job.backups?.bin, job.backups?.window, job.backups?.readme]) {
      if (backup) {
        await rm(backup, {
          recursive: true,
          force: true
        }).catch(() => {});
      }
    }
    await rm(this.#workDir(job), {
      recursive: true,
      force: true
    }).catch(() => {});
    await rm(`${this.options.statePath}.job-lock`, {
      recursive: true,
      force: true
    })
      .catch(() => {});
  }

  /**
   * Откат незавершённой замены: резервы возвращаются на свои места. Возвращает true
   * при полном успехе; при неудаче выставляет job.error с путями для ручного
   * восстановления, и вызывающий обязан его сохранить.
   */
  async #rollback(job: PackageUpdateJob): Promise<boolean> {
    let ok = true;
    const pairs: Array<[string | null | undefined, string]> = [
      [job.backups?.bin, 'bin'],
      [job.backups?.window, 'GrigDesk'],
      [job.backups?.readme, 'README.md'],
    ];

    for (const [backup, name] of pairs) {
      if (!backup) {
        continue;
      }

      const target = path.join(this.options.installRoot, name);

      try {
        const exists = await stat(backup).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') {
            return null;
          }

          throw error;
        });

        if (!exists) {
          // Rename мог ещё не начаться или резерв уже возвращён предыдущим recover.
          // До удаления текущего имени требуется наличие самого резерва.
          await stat(target);

          continue;
        }

        await rm(target, {
          recursive: true,
          force: true
        });
        await rename(backup, target);
      } catch (error) {
        ok = false;
        job.error = {
          code: 'manual_recovery_required',
          message: `Резерв ${backup} не возвращён: ${(error as Error).message}`,
        };
      }
    }

    return ok;
  }

  /**
   * Последовательность проверяет доверие и пробу до замены файлов установки.
   * Резервы и стадия сохраняются так, чтобы следующий запуск восстановил обрыв.
   */
  async #run(job: PackageUpdateJob, entry: ChannelEntry): Promise<void> {
    const work = this.#workDir(job);
    const root = this.options.installRoot;

    try {
      await rm(work, {
        recursive: true,
        force: true
      });
      await mkdir(work, {
        recursive: true,
        mode: 0o700
      });

      // Ключ и подпись проверяются до скачивания: подписанный текст реконструируется
      // из полей канала, архив для этого не нужен.
      await this.#setStage(job, 'verifying');

      const publicKeyPem = this.options.publicKeyPem ?? RELEASE_SIGNING_PUBLIC_KEY;

      if (!publicKeyPem.trim()) {
        throw Object.assign(new Error('Публичный ключ подписи не задан.'), {
          safeCode: 'release_signing_key_missing',
        });
      }

      const signedContent = `${entry.archiveSha256}  release.tar.gz\n`
        + `${entry.bundleSha256}  release/bin/bundle.json\n`;

      if (!verifyBytes(null, Buffer.from(signedContent, 'utf8'),
        createPublicKey(publicKeyPem), Buffer.from(entry.signature, 'base64'))) {
        throw Object.assign(new Error('Подпись канала не прошла проверку.'), {
          safeCode: 'release_signature_invalid',
        });
      }

      await this.#setStage(job, 'downloading');

      const fetcher = this.options.fetcher ?? globalThis.fetch.bind(globalThis);
      const response = await fetcher(entry.archiveUrl!, {
        redirect: 'error',
        signal: AbortSignal.timeout(30 * 60_000),
      });

      if (!response.ok || !response.body) {
        throw Object.assign(new Error(`Архив ответил ${response.status}`), {
          safeCode: 'package_download_failed',
        });
      }

      const archivePath = path.join(work, 'release.tar.gz');
      const handle = await open(archivePath, 'w', 0o600);
      let downloaded = 0;
      let lastWrite = 0;

      try {
        for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
          await handle.writeFile(chunk);
          downloaded += chunk.byteLength;
          job.progress = {
            downloadedBytes: downloaded,
            totalBytes: entry.archiveSize
          };

          const now = Date.now();

          if (now - lastWrite > 1000) {
            lastWrite = now;
            await writeJobState(this.options.statePath, {
              ...job,
              status: 'downloading',
              stage: 'downloading',
              updatedAt: new Date().toISOString()
            });
          }
        }
      } finally {
        await handle.close();
      }

      await this.#setStage(job, 'unpacking');

      const archiveHash = await sha256File(archivePath);

      if (archiveHash !== entry.archiveSha256 || downloaded !== entry.archiveSize) {
        throw Object.assign(new Error('SHA256 архива не совпал с каналом.'), {
          safeCode: 'package_archive_mismatch',
        });
      }

      const unpack = path.join(work, 'unpack');

      await mkdir(unpack, { recursive: true });
      await execute('tar', ['-xzf', archivePath, '-C', unpack]);

      const unpackedBundle = path.join(unpack, 'release', 'bin', 'bundle.json');
      const bundleHash = await sha256File(unpackedBundle);

      if (bundleHash !== entry.bundleSha256) {
        throw Object.assign(new Error('Опись bundle.json не совпала с каналом.'), {
          safeCode: 'package_bundle_mismatch',
        });
      }

      await this.#setStage(job, 'probing');

      const probeBinary = path.join(unpack, 'release', 'bin', 'grigdesk-server');
      let probeVersion: { version?: unknown } | null;

      try {
        const probeJson = this.options.prober
          ? await this.options.prober(probeBinary)
          : await this.#probe(probeBinary, work);

        probeVersion = JSON.parse(probeJson);
      } catch (error) {
        throw Object.assign(new Error('Проба нового сервера не прошла.'), {
          safeCode: 'package_probe_failed',
          cause: error,
        });
      }

      if (!probeVersion || probeVersion.version !== job.targetVersion) {
        throw Object.assign(new Error('Проба нового сервера не подтвердила версию.'), {
          safeCode: 'package_probe_failed',
        });
      }

      for (const name of ['bin', 'GrigDesk', 'README.md']) {
        await stat(path.join(unpack, 'release', name));
      }

      await this.#setStage(job, 'applying');

      const backups: PackageUpdateJob['backups'] = {
        bin: null,
        window: null,
        readme: null
      };
      const swaps: Array<[string, 'bin' | 'window' | 'readme']> = [
        ['bin', 'bin'], ['GrigDesk', 'window'], ['README.md', 'readme'],
      ];

      try {
        for (const [name, key] of swaps) {
          const target = path.join(root, name);
          const source = path.join(unpack, 'release', name);
          const exists = await stat(source).then(() => {
            return true;
          }, (error) =>
            {
            return error.code === 'ENOENT' ? false : Promise.reject(error);
          });

          if (!exists) {
            continue;
          }

          const backup = `${target}.grigdesk-backup-${job.id}`;

          // Путь резерва сохраняется до первого rename: recover видит даже обрыв
          // между переносом старого имени и установкой нового.
          backups[key] = backup;
          job.backups = backups;
          await writeJobState(this.options.statePath, job);
          await rename(target, backup);
          await rename(source, target);
        }
      } catch (error) {
        job.backups = backups;

        const restored = await this.#rollback(job);

        if (!restored) {
          // Ошибка отката с путями резервов не перезаписывается общим отказом.
          throw Object.assign(new Error('Замена файлов не удалась; требуется ручное'
            + ' восстановление.'), {
              safeCode: 'package_apply_rolled_back',
              cause: error
            });
        }

        throw Object.assign(new Error('Замена файлов не удалась; резервы возвращены.'), {
          safeCode: 'package_apply_rolled_back',
          cause: error,
        });
      }

      job.backups = backups;
      await this.#setStage(job, 'restarting');

      await this.options.onRestart?.();
    } catch (error) {
      const code = (error as { safeCode?: string }).safeCode ?? 'package_update_failed';

      // Откат мог уже выставить manual_recovery_required с путями: его не затираем.
      if (job.error?.code === 'manual_recovery_required') {
        await this.#failPreserving(job, code);
      } else {
        await this.#fail(job, code, (error as Error).message);
      }
    }
  }

  /**
   * Проба нового сервера: одноразовое окружение с существующим HOME без ключей,
   * таймаут 30 секунд. Возвращается stdout с JSON --version.
   */
  async #probe(binary: string, work: string): Promise<string> {
    const home = path.join(work, 'probe-home');

    await mkdir(home, {
      recursive: true,
      mode: 0o700
    });

    const result = await execute(binary, ['--version', '--json'], {
      cwd: '/',
      timeout: 30_000,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: home,
        LANG: 'C.UTF-8'
      },
      maxBuffer: 65536,
    });

    if (result.stderr !== '') {
      throw new Error('Проба нового сервера записала ошибку в stderr');
    }

    return result.stdout;
  }
}

/**
 * Фабрика SEA подставляется сборкой вместо source-композиции.
 * Типы source-классов стираются: их код и worker не входят в runtime-граф.
 * Канал создаёт только system-модуль (options.packagedChannel): фабрика без явной
 * опции не ходит в сеть — тесты фабрики остаются герметичными.
 */
export function createPackagedServices(options: ReleaseServicesOptions) {
  const channel = options.packagedChannel;
  const installRoot = runtimeInstallationRoot();

  return {
    releases: options.releases ?? new PackagedReleaseService(options.rootDir, undefined,
      {
        ...(channel ? { channel } : {}),
        installVersionReader: () => {
          return readInstallVersion(installRoot);
        },
      }),
    updates: options.updates ?? new PackagedUpdateManager({
      installRoot,
      statePath: path.join(path.dirname(options.statePath), 'grigdesk-package-update.json'),
      ...(channel ? { channel } : {}),
    }),
  };
}
