import { promises as fs } from 'node:fs';
import path from 'node:path';

import { InstallEnvironmentError } from './npmEnvironment.ts';

interface ProcEntryStat {
  uid: number;
}

/**
 * Разбор таблицы процессов вынесен в узкий интерфейс: тест проверяет политику
 * недоступных прав и гонок, не завися от чужих живых процессов машины.
 */
export interface ProcIo {
  readdir(directory: string): Promise<string[]>;
  stat(directory: string): Promise<ProcEntryStat>;
  readFile(file: string): Promise<string>;
  readlink(file: string): Promise<string>;
}

const defaultProcIo: ProcIo = {
  readdir: (directory) => fs.readdir(directory),
  stat: (directory) => fs.stat(directory),
  readFile: (file) => fs.readFile(file, 'utf8'),
  readlink: (file) => fs.readlink(file),
};

/**
 * Терминальные процессы не обязаны знать о leases: дополнительно ищем выбранную копию в proc.
 * Проверка включает exe и argv Node launcher; недоступный exe не доказывает занятость,
 * а нечитаемая командная строка — честный отказ вместо пропуска неизвестного процесса.
 */
export async function assertNoExternalCliProcess(root: string, aliases: string[],
  io: ProcIo = defaultProcIo): Promise<void> {
  const uid = process.getuid?.();
  const inside = (file: string): boolean => file === root || file.startsWith(root + path.sep)
    || aliases.includes(file);

  for (const name of (await io.readdir('/proc')).filter((entry) => /^\d+$/u.test(entry))) {
    if (Number(name) === process.pid) {
      continue;
    }

    try {
      const directory = `/proc/${name}`;
      const stat = await io.stat(directory);

      if (uid !== undefined && stat.uid !== uid) {
        continue;
      }

      const args = (await io.readFile(path.join(directory, 'cmdline'))).split('\0');
      let exe = '';

      try {
        exe = await io.readlink(path.join(directory, 'exe'));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;

        if (code === 'ENOENT') {
          exe = '';
        } else if (code !== 'EACCES' && code !== 'EPERM') {
          throw error;
        }
      }

      if (inside(exe.replace(/ \(deleted\)$/u, '')) || args.some(inside)) {
        throw new InstallEnvironmentError('provider_in_use',
          'Выбранная копия используется процессом вне установщика');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT'
        || (error as NodeJS.ErrnoException).code === 'ESRCH') {
        continue;
      }
      if (error instanceof InstallEnvironmentError) {
        throw error;
      }

      throw new InstallEnvironmentError('process_state_unknown',
        'Не удалось проверить занятость выбранной копии');
    }
  }
}
