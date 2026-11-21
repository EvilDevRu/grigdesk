import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { factoryRuntimePaths } from './factoryRuntime.ts';
import { runtimeKind, runtimeRoot } from './runtimePaths.ts';

const exec = promisify(execFile);

/**
 * Делегирует чтение защищённого файла штатной фабрике Win32.
 * Проверка DACL и чтение используют один handle, результат ограничён по размеру.
 */
export async function readFactoryWindowsFile(
  file: string, kind: 'directory' | 'file' | 'immutable' | 'owner', limit = 16 * 1024 * 1024,
): Promise<Buffer> {
  const runtime = factoryRuntimePaths({
    kind: runtimeKind(),
    root: runtimeRoot(),
    env: process.env,
  });
  const result = await exec(runtime.bin, ['_windows-read-protected', kind, file], {
    encoding: 'buffer',
    timeout: 10000,
    windowsHide: true,
    maxBuffer: limit,
  });

  return result.stdout;
}
