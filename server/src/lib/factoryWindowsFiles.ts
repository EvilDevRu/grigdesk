import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';

import { factoryRuntimePaths } from './factoryRuntime.ts';
import { runtimeKind, runtimeRoot } from './runtimePaths.ts';

const exec = promisify(execFile);

function factoryBin(): string {
  return factoryRuntimePaths({
    kind: runtimeKind(),
    root: runtimeRoot(),
    env: process.env,
  }).bin;
}

/**
 * Делегирует чтение защищённого файла штатной фабрике Win32.
 * Проверка DACL и чтение используют один handle, результат ограничён по размеру.
 */
export async function readFactoryWindowsFile(
  file: string, kind: 'directory' | 'file' | 'immutable' | 'owner', limit = 16 * 1024 * 1024,
): Promise<Buffer> {
  const result = await exec(factoryBin(), ['_windows-read-protected', kind, file], {
    encoding: 'buffer',
    timeout: 10000,
    windowsHide: true,
    maxBuffer: limit,
  });

  return result.stdout;
}

/** Содержимое передаётся только через stdin.
 * Фабрика закрепляет права Win32 до публикации имени.
 */
export async function writeFactoryWindowsFile(file: string, text: string | Buffer): Promise<void> {
  const child = spawn(factoryBin(), ['_windows-write-protected', file], {
    stdio: ['pipe', 'ignore', 'ignore'],
    timeout: 15000,
    windowsHide: true,
  });

  try {
    const [[code]] = await Promise.all([
      once(child, 'close'),
      new Promise<void>((resolve, reject) => {
        child.stdin.once('error', reject);
        child.stdin.end(text, resolve);
      }),
    ]);

    if (code === 0) {
      return;
    }
  } catch {
    child.kill();
  }

  throw new Error('windows_private_write_failed');
}
