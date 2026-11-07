import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/**
 * Проверяет R его настоящей служебной командой без boot и окружения вызывающего Node.
 * SEA не получает -p/--eval; вложенный Node сверяется как файл состава manifest.
 */
export async function verifySeaRuntime(root: string,
  options: { mode?: 'startup' | 'full' } = {}): Promise<void> {
  const argument = options.mode === 'startup' ? '--check-startup' : '--check-runtime';
  const result = await execute(path.join(root, 'server/grigdesk-server'), [argument], {
    cwd: '/',
    env: { PATH: '/usr/bin:/bin' },
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });

  if (JSON.parse(result.stdout).ok !== true) {
    throw new Error('Проверка состава серверного пакета GrigDesk не пройдена');
  }
}
