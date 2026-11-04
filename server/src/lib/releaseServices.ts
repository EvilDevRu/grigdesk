import { GrigDeskReleaseService } from './grigDeskRelease.ts';
import { GrigDeskUpdateManager } from './grigDeskUpdate.ts';
import { createPackagedServices } from './packagedRelease.ts';
import type { PackagedReleaseService, PackagedUpdateManager } from './packagedRelease.ts';
import type { ReleaseChannelService } from './releaseChannel.ts';
import { runtimeKind } from './runtimePaths.ts';
import type { RuntimeKind } from './runtimePaths.ts';

export interface ReleaseServicesOptions {
  rootDir: string;
  statePath: string;
  kind?: RuntimeKind;
  releases?: GrigDeskReleaseService | PackagedReleaseService;
  updates?: GrigDeskUpdateManager | PackagedUpdateManager;
  packagedChannel?: ReleaseChannelService;
  broadcast?: (name: string, payload?: unknown) => void;
  desktop?: () => boolean;
  origin?: string;
  cliTokenPath?: string;
}

/**
 * Выбирает композицию до конструирования source-сервисов и captureRunning git.
 * В SEA этот модуль заменён прямым export фабрики пакета, исходный updater исключён.
 */
export function createReleaseServices(options: ReleaseServicesOptions) {
  if ((options.kind ?? runtimeKind()) === 'packaged') {
    return createPackagedServices(options);
  }

  const releases = options.releases ?? new GrigDeskReleaseService(options);
  const updates = options.updates ?? new GrigDeskUpdateManager({
    ...options,
    releases,
  });

  return { releases, updates };
}
