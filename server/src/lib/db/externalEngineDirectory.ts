import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import { importRuntimeModule } from '../runtimeImport.ts';
import type { RuntimeImportOptions } from '../runtimeImport.ts';
import { assertEngineEntry, decodeEngineManifest, readEngineManifest } from './engineManifest.ts';
import type { DbEngineAdapter } from './engineRegistry.ts';

export interface EngineDiagnostic {
  id: string;
  code: string;
  message: string;
}

export interface ExternalEngineOptions {
  externalDir?: string | null;
  blockedIds?: readonly string[] | '*';
  grigDeskVersion?: string;
  runtime?: RuntimeImportOptions;
  log?: { warn: (...args: never[]) => unknown };
}

/**
 * Внешние пакеты дополняют уже проверенный builtin-снимок, не заменяя его.
 * Ошибка одного пакета публикуется безопасно и не мешает загрузке соседних.
 */
export async function loadExternalEngines(
  engines: Map<string, DbEngineAdapter>,
  options: ExternalEngineOptions,
  validate: (engine: DbEngineAdapter | undefined) => void,
): Promise<EngineDiagnostic[]> {
  const errors: EngineDiagnostic[] = [];
  const reject = (id: string, code: string) => {
    const diagnostic = {
      id,
      code,
      message: 'Драйвер БД отклонён. Проверьте пакет и перезапустите сервер.',
    };

    errors.push(diagnostic);
    options.log?.warn(diagnostic as never, 'Ошибка внешнего драйвера БД' as never);
  };

  if (!options.externalDir || options.blockedIds === '*') {
    return errors;
  }

  let names: string[];

  try {
    const root = await lstat(options.externalDir);

    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new Error('root');
    }

    names = (await readdir(options.externalDir)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      reject('*', 'directory_invalid');
    }

    return errors;
  }

  for (const id of names) {
    if (id.startsWith('.') || options.blockedIds?.includes(id)) {
      continue;
    }

    try {
      const directory = path.join(options.externalDir, id);
      const info = await lstat(directory);

      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error('directory');
      }

      if (engines.has(id)) {
        reject(id, 'id_reserved');
        continue;
      }

      const manifest = decodeEngineManifest(
        await readEngineManifest(directory), options.grigDeskVersion ?? '0.0.0',
      );

      if (manifest.id !== id || engines.has(manifest.id)) {
        throw new Error('identity');
      }

      await assertEngineEntry(directory, manifest.entry);

      const module = await importRuntimeModule<{ default?: DbEngineAdapter }>(
        path.join(directory, manifest.entry), options.runtime,
      );
      const engine = module.default;

      validate(engine);

      if (!engine || engine.id !== id || typeof engine.capabilities !== 'object'
        || Array.isArray(engine.capabilities)) {
        throw new Error('adapter');
      }

      // structuredClone отвергает функции, JSON — BigInt; обход выявляет циклы.
      // Проверка идёт до публикации, чтобы list всегда оставался сериализуемым.
      const capabilities = structuredClone(engine.capabilities);

      JSON.stringify(capabilities);
      engines.set(id, Object.assign(engine, { label: manifest.label, capabilities }));
    } catch {
      reject(id, 'engine_invalid');
    }
  }

  return errors;
}
