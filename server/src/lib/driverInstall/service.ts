import { PluginInstallService } from '../pluginInstall/service.ts';
import type { PluginInstallServiceOptions } from '../pluginInstall/service.ts';
import { driverPackagePolicy } from '../trackers/driverPackage.ts';

/**
 * Независимый экземпляр сохраняет журнал и блокировки внутри каталога драйверов.
 * Подготовка, digest, замена, откат и recovery остаются в общем установщике.
 */
export function createDriverInstallService(
  options: Omit<PluginInstallServiceOptions, 'pluginsDir' | 'packagePolicy' | 'reservedIds'> & {
    driversDir: string;
  },
): PluginInstallService {
  const { driversDir, ...common } = options;

  return new PluginInstallService({
    ...common,
    pluginsDir: driversDir,
    packagePolicy: driverPackagePolicy,
    reservedIds: ['own', 'b24-stock'],
  });
}
