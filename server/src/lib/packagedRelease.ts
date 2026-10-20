import { randomUUID } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ReleaseStatus, UpdateJob } from '../../../shared/runtime/grigDeskUpdateContracts.ts';
import type { ReleaseServicesOptions } from './releaseServices.ts';
import type { ReleaseManifest } from './releaseManifest.ts';
import type { RuntimeBuildContext } from './runtimeBuildContext.ts';
import { runtimeBuildContext } from './runtimeBuildContext.ts';

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

      if (version !== '0.1.0') {
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
 * Статус SEA берётся только из manifest своего R и не зависит от git или D.
 * Методы start/stop сохраняют интерфейс source-сервиса без фоновых проверок.
 */
export class PackagedReleaseService {
  readonly instanceId = randomUUID();

  private readonly startedAt = new Date().toISOString();

  private readonly rootDir: string;

  private readonly identityReader: (root: string) => Promise<PackagedIdentity>;

  constructor(rootDir: string, identityReader = readPackagedIdentity) {
    this.rootDir = rootDir;
    this.identityReader = identityReader;
  }

  /**
   * Формирует прежний DTO для совместимости клиента и объявляет package capability.
   * Checkout-поля пусты: UI выбирает представление пакета по capability.
   */
  async getStatus(_options?: { fresh?: boolean }): Promise<ReleaseStatus> {
    const manifest = await this.identityReader(this.rootDir);

    const version = {
      version: manifest.version,
      stableVersion: manifest.version,
      exactTag: null,
      productVersion: manifest.version,
      versionTagMismatch: false,
    };

    return {
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
  }

  /** Проверка версии пакета локальна; remote-канал бинарного updater пока не определён. */
  checkRemote(): Promise<ReleaseStatus> {
    return this.getStatus();
  }

  start(): void {}

  stop(): void {}

  invalidate(): void {}
}

/**
 * Packaged-менеджер не восстанавливает source job и не создаёт новый.
 * Штатный restart использует assertIdle и остаётся доступен независимо от обновления.
 */
export class PackagedUpdateManager {
  async getJob(): Promise<UpdateJob | null> {
    return null;
  }

  async isRestarting(_jobId: string): Promise<boolean> {
    return false;
  }

  async recover(): Promise<void> {}

  async assertIdle(): Promise<void> {}

  async startApply(_request: unknown): Promise<UpdateJob> {
    throw packagedUpdateError();
  }

  async startUpdate(_request: unknown): Promise<UpdateJob> {
    throw packagedUpdateError();
  }
}

/**
 * Фабрика SEA подставляется сборкой вместо source-композиции.
 * Типы source-классов стираются: их код и worker не входят в runtime-граф.
 */
export function createPackagedServices(options: ReleaseServicesOptions) {
  return {
    releases: options.releases ?? new PackagedReleaseService(options.rootDir),
    updates: options.updates ?? new PackagedUpdateManager(),
  };
}
