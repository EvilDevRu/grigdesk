import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

import { compareSemVer, parseSemVer } from '../releaseCommon.ts';
import { PluginInstallError } from '../packageInstall/errors.ts';

export interface EngineManifest {
  id: string;
  label: string;
  kind: 'db-engine';
  api: 1;
  minimum: string;
  entry: string;
  version?: string;
}

/**
 * Отказ драйвера содержит только доверенный текст и машинный код.
 * Исходные ошибки JSON, импорта и файловые пути не выходят к человеку.
 */
export function engineManifestError(code = 'manifest_invalid'): PluginInstallError {
  return new PluginInstallError(code, 'Драйвер БД отклонён: проверьте engine.json, entry и версию API.', 422);
}

/**
 * Манифест проверяется без исполнения привилегированного кода драйвера.
 * Версию пакета задаёт тег; необязательная версия манифеста должна ему соответствовать.
 */
export function decodeEngineManifest(
  raw: Record<string, unknown>,
  grigDeskVersion: string,
  version?: string,
): EngineManifest {
  const { id, label, kind, api, minimum, entry } = raw;

  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,40}$/u.test(id)
    || ['constructor', 'prototype', '__proto__'].includes(id)) {
    throw engineManifestError('id_invalid');
  }

  if (typeof label !== 'string' || !label.trim() || label.length > 128
    || kind !== 'db-engine' || api !== 1) {
    throw engineManifestError();
  }

  if (typeof minimum !== 'string' || minimum.trim() !== minimum || !parseSemVer(minimum)
    || compareSemVer(minimum, grigDeskVersion) > 0) {
    throw engineManifestError('grigdesk_too_old');
  }

  if (typeof entry !== 'string' || !entry.endsWith('.mjs') || entry.includes('\\')
    || entry.startsWith('/') || entry.includes(':') || entry.split('/').some((part) =>
      !part || part.startsWith('.') || part === 'node_modules')) {
    throw engineManifestError();
  }

  if (Object.hasOwn(raw, 'version') && (typeof raw.version !== 'string'
    || !parseSemVer(raw.version) || (version !== undefined && raw.version !== version))) {
    throw engineManifestError('version_mismatch');
  }

  return {
    id,
    label,
    kind,
    api,
    minimum,
    entry,
    ...(typeof raw.version === 'string' ? { version: raw.version } : {}),
  };
}

/**
 * Проверка каждого предка entry исключает переход по ссылке в подпапке.
 * Установщик и startup используют один файловый контракт внешнего пакета.
 */
export async function assertEngineEntry(directory: string, entry: string): Promise<void> {
  const parts = entry.split('/');
  let current = directory;

  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);

    const info = await lstat(current).catch(() => null);

    if (!info || info.isSymbolicLink()
      || (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())) {
      throw engineManifestError();
    }
  }
}

/**
 * Startup читает ограниченный обычный файл, не обходя ссылки.
 * Любой дефект манифеста превращается в безопасную диагностику драйвера.
 */
export async function readEngineManifest(directory: string): Promise<Record<string, unknown>> {
  try {
    const file = path.join(directory, 'engine.json');
    const info = await lstat(file);

    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) {
      throw engineManifestError();
    }

    const raw: unknown = JSON.parse(await readFile(file, 'utf8'));

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw engineManifestError();
    }

    return raw as Record<string, unknown>;
  } catch {
    throw engineManifestError();
  }
}
