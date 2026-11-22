import { readWindowsProtectedFile, writeWindowsProtectedFile } from '../../../shared/node/windowsProtectedFiles.ts';

import { factoryRuntimePaths } from './factoryRuntime.ts';
import { runtimeKind, runtimeRoot } from './runtimePaths.ts';

function factoryBin(): string {
  return factoryRuntimePaths({
    kind: runtimeKind(),
    root: runtimeRoot(),
    env: process.env,
  }).bin;
}

/**
 * Читает ограниченный файл через штатную Go-фабрику установленного сервера.
 * Разрешённые формы определяет проверка прав Win32.
 */
export function readFactoryWindowsFile(
  file: string, kind: 'directory' | 'file' | 'immutable' | 'owner', limit = 16 * 1024 * 1024,
): Promise<Buffer> {
  return readWindowsProtectedFile(factoryBin(), file, kind, limit);
}

/**
 * Передаёт содержимое Go-фабрике для атомарной записи.
 * Путь к фабрике берётся из того же описания runtime, что при работе с маршрутами.
 */
export function writeFactoryWindowsFile(file: string, text: string | Buffer): Promise<void> {
  return writeWindowsProtectedFile(factoryBin(), file, text);
}
