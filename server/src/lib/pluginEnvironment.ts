import type { PluginEnvironment } from '../../../packages/plugin-types/src/coreRuntime.ts';
import type { GrigDeskConfig } from '../config.ts';
import { nodeExecutable } from './runtimePaths.ts';

type EnvironmentConfig = Pick<GrigDeskConfig,
  'rootDir' | 'studio3dDir' | 'dataStateDir' | 'mobileDir' | 'stateDir' | 'chatsDir'
  | 'telegramDir' | 'githubDir' | 'profilesDir' | 'userPluginsDir'
  | 'factoryControlDir' | 'factoryConfigRoot'>;

/**
 * Сборка приложения и изолированные проверки используют один публичный environment.
 * Служебные деревья защищены целиком, Node выбирается настоящим resolver ядра.
 */
export function createPluginEnvironment(config: EnvironmentConfig): PluginEnvironment {
  return Object.freeze({
    runtimeRoot: config.rootDir,
    defaultLibraryDir: config.studio3dDir,
    protectedDirs: Object.freeze([
      config.dataStateDir,
      config.mobileDir,
      config.stateDir,
      config.chatsDir,
      config.telegramDir,
      config.githubDir,
      config.profilesDir,
      config.userPluginsDir,
      config.factoryControlDir,
      config.factoryConfigRoot,
    ]),
    nodeExecutable: nodeExecutable(),
  });
}
