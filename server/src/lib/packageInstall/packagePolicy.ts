import {
  readPluginManifest,
  validatePluginPackage,
  validatePreparedPluginPackage,
} from './validatePackage.ts';
import { installedWebModuleDir, sensitivePluginFile } from './serviceSnapshots.ts';

export interface InstallPackagePolicy {
  validate: typeof validatePluginPackage;
  validatePrepared: typeof validatePreparedPluginPackage;
  readManifest: typeof readPluginManifest;
  installedModuleDir: typeof installedWebModuleDir;
  sensitiveFile: typeof sensitivePluginFile;
  serverWarnings: string[];
}

export const pluginPackagePolicy: InstallPackagePolicy = {
  validate: validatePluginPackage,
  validatePrepared: validatePreparedPluginPackage,
  readManifest: readPluginManifest,
  installedModuleDir: installedWebModuleDir,
  sensitiveFile: sensitivePluginFile,
  serverWarnings: ['Код плагина выполняется с правами GrigDesk.'],
};

export type PackageKind = 'plugin' | 'db-engine';

/**
 * Род пакета выбирает только сервер при создании сервиса.
 * Он не связан с kind источника Git или видом задания установки.
 */
export function packagePolicy(kind: PackageKind = 'plugin') {
  return kind === 'db-engine' ? {
    manifest: 'engine.json',
    nameField: 'label',
    restartOnly: true,
    warnings: [
      'Неизвестный источник драйвера: проверьте репозиторий перед применением.',
      'Драйвер получает пароли профилей, SSH-каналы и доступ к сети с правами GrigDesk.',
    ],
  } : {
    manifest: 'plugin.json',
    nameField: 'name',
    restartOnly: false,
    warnings: ['Код плагина выполняется с правами GrigDesk.'],
  };
}
