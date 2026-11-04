import { assertPluginResource, pluginResourcePath } from './pluginAssets.ts';
import { installError } from './packageInstall/errors.ts';

export interface PluginServerEntry {
  serverEntry: string | null;
  serverError: string | null;
  hasServer: boolean;
}

/**
 * Исполняется только явно объявленный собственный файл пакета.
 * Соседние server.js и server.ts не участвуют в выборе и не импортируются.
 */
export function selectPluginServerEntry(root: string, declared: unknown): PluginServerEntry {
  if (declared === undefined) {
    return {
      serverEntry: null,
      serverError: null,
      hasServer: false,
    };
  }

  const relative = pluginResourcePath(declared);

  if (!/\.(?:js|mjs|ts)$/u.test(relative)) {
    throw installError('manifest_invalid', 'entrypoints.server: нужен файл js, mjs или ts');
  }

  assertPluginResource(root, relative);

  return {
    serverEntry: relative,
    serverError: null,
    hasServer: true,
  };
}
