import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';

const execute = promisify(execFile);

type FileKind = 'directory' | 'file' | 'immutable' | 'owner';

/**
 * Проверку DACL и чтение выполняет фабрика через открытый handle.
 * Вызывающий выбирает доверенный исполняемый файл для своей установки.
 */
export async function readWindowsProtectedFile(
  factory: string, file: string, kind: FileKind, limit: number,
): Promise<Buffer> {
  const result = await execute(factory, ['_windows-read-protected', kind, file], {
    encoding: 'buffer',
    timeout: 10000,
    windowsHide: true,
    maxBuffer: limit,
  });

  return result.stdout;
}

/**
 * Каталог создаётся с приватными правами ядра или проверяется с сохранением DACL.
 * Фабрика отвергает псевдонимы и подмену через reparse point.
 */
export async function ensureWindowsProtectedDirectory(factory: string, directory: string): Promise<void> {
  await execute(factory, ['_windows-mkdir-protected', directory], {
    timeout: 10000,
    windowsHide: true,
  });
}

/**
 * Фабрика закрепляет права Win32 до атомарной смены файла.
 * Содержимое передаётся только через stdin.
 */
export async function writeWindowsProtectedFile(
  factory: string, file: string, text: string | Buffer,
): Promise<void> {
  const child = spawn(factory, ['_windows-write-protected', file], {
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
