import type { PluginServerModule } from '../../../packages/plugin-types/src/server.ts';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { runtimeKind, runtimeRoot } from './runtimePaths.ts';
import type { RuntimeKind } from './runtimePaths.ts';

/**
 * Загрузка внешних ESM-модулей (пользовательских плагинов).
 *
 * В исходниках работает обычный import(file URL). В SEA бандл исполняется как CJS,
 * поэтому файловый loader берётся из внешнего `server/runtime/esmBridge.cjs` через
 * createRequire от `server/package.json` комплекта: bridge делает обычный import(url)
 * и не получает новых прав или обходов admission/lifecycle.
 */

export interface RuntimeImportOptions {
  kind?: RuntimeKind;
  root?: string;
}

export interface RuntimeImportBridge {
  importUrl(url: string): Promise<unknown>;
}

export type { PluginServerModule } from '../../../packages/plugin-types/src/server.ts';

const bridges = new Map<string, RuntimeImportBridge>();

/**
 * Загружает внешний bridge из комплекта через createRequire.
 * Отсутствие файла или неверная форма — отказ с путём, без перехода на исходники.
 */
function loadBridge(root: string): RuntimeImportBridge {
  const file = path.join(root, 'server/runtime/esmBridge.cjs');
  const cached = bridges.get(file);

  if (cached) {
    return cached;
  }

  try {
    const fileRequire = createRequire(path.join(root, 'server/package.json'));
    const loaded = fileRequire(file) as Partial<RuntimeImportBridge>;

    if (!loaded || typeof loaded.importUrl !== 'function') {
      throw new Error('bridge не экспортирует importUrl');
    }

    bridges.set(file, loaded as RuntimeImportBridge);

    return loaded as RuntimeImportBridge;
  } catch (error) {
    throw new Error(`Не удалось загрузить внешний ESM bridge ${file}: `
      + `${(error as Error).message}`);
  }
}

/**
 * Импортирует файл плагина своим для режима способом.
 * Путь с пробелами превращается в file URL; повторный импорт отдаёт кэш ESM.
 */
export async function importRuntimeModule<Module = PluginServerModule>(
  filePath: string,
  options: RuntimeImportOptions = {},
): Promise<Module> {
  const kind = options.kind ?? runtimeKind();
  const root = options.root ?? runtimeRoot();
  const url = pathToFileURL(path.resolve(filePath)).href;

  if (kind === 'source') {
    return await import(url) as Module;
  }

  return await loadBridge(root).importUrl(url) as Module;
}
