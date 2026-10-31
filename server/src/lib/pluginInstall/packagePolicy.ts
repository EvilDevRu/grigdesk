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
