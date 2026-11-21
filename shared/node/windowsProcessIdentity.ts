import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
let factory: string | undefined;

/** Сервер передаёт путь уже выбранной фабрики.
 * Общий код блокировок не ищет программу по PATH.
 */
export function configureWindowsProcessIdentity(file: string): void {
  if (!path.isAbsolute(file)) {
    throw new Error('windows_process_helper_invalid');
  }

  factory = file;
}

/** Различает отсутствие процесса и невозможность проверить владельца.
 * При недоступном helper блокировка сохраняет статус «неизвестно».
 */
export async function readWindowsProcessStart(pid: number): Promise<{
  starttime?: string;
  dead: boolean;
}> {
  if (!factory || !Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff) {
    return { dead: false };
  }

  try {
    const { stdout } = await run(factory, ['_windows-starttime', String(pid)], {
      timeout: 5000,
      maxBuffer: 1024,
      windowsHide: true,
    });
    const starttime = stdout.trim();

    return /^\d+$/u.test(starttime) ? { starttime, dead: false } : { dead: false };
  } catch (error) {
    return { dead: (error as { code?: number }).code === 3 };
  }
}
