import fs from 'node:fs/promises';

export interface ProcessUsageRecord {
  pid: number;
  name: string;
  cwd: string;
  args: string[];
  paths: string[];
  unchecked: boolean;
  starttime: string | null;
  session: number | null;
  cgroup: string;
}

/**
 * Исчезнувший fd/process штатен во время чтения proc, отказ доступа остаётся неизвестностью.
 * Читается текст ссылки /proc, а не содержимое пользовательского файла.
 */
async function procLink(file: string): Promise<string> {
  try {
    return (await fs.readlink(file)).replace(/ \(deleted\)$/, '');
  } catch (error) {
    if (['ENOENT', 'ESRCH', 'EINVAL'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      return '';
    }

    throw error;
  }
}

/**
 * Обход ограничен процессами текущего uid и не посылает им сигналов.
 * Закрытая часть процесса явно отмечается, чтобы caller не принимал её за пустые paths.
 */
export async function processUsageRecords(): Promise<ProcessUsageRecord[]> {
  const result: ProcessUsageRecord[] = [];

  for (const name of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) {
      continue;
    }

    const directory = '/proc/' + name;

    try {
      if ((await fs.stat(directory)).uid !== process.getuid?.()) {
        continue;
      }

      const item: ProcessUsageRecord = {
        pid: Number(name),
        name: (await fs.readFile(directory + '/comm', 'utf8')).trim(),
        cwd: '',
        args: [],
        paths: [],
        unchecked: false,
        starttime: null,
        session: null,
        cgroup: '',
      };
      /**
       * Ограничивает permission failures одним record без сокрытия других ошибок.
       * Caller сохраняет explicit unchecked и сам решает допустимость процесса.
       */
      const guarded = async (run: () => Promise<void>): Promise<void> => {
        try {
          await run();
        } catch (error) {
          if (!['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
            throw error;
          }

          item.unchecked = true;
        }
      };

      await guarded(async () => {
        item.args = (await fs.readFile(directory + '/cmdline', 'utf8')).split('\0').filter(Boolean);
        item.paths.push(...item.args.filter((arg) => arg.startsWith('/')));
      });
      await guarded(async () => {
        const stat = await fs.readFile(directory + '/stat', 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);

        const starttime = fields[19];

        item.starttime = starttime !== undefined && /^\d+$/.test(starttime) ? starttime : null;
        item.session = /^\d+$/.test(fields[3] ?? '') ? Number(fields[3]) : null;
        item.cgroup = await fs.readFile(directory + '/cgroup', 'utf8');
      });
      await guarded(async () => {
        item.cwd = await procLink(directory + '/cwd');
        item.paths.push(item.cwd, await procLink(directory + '/exe'));
      });
      await guarded(async () => {
        for (const fd of await fs.readdir(directory + '/fd')) {
          item.paths.push(await procLink(directory + '/fd/' + fd));
        }
      });
      await guarded(async () => {
        for (const line of (await fs.readFile(directory + '/maps', 'utf8')).split('\n')) {
          const file = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\/.*)$/.exec(line)?.[1];

          if (file) {
            item.paths.push(file.replace(/ \(deleted\)$/, ''));
          }
        }
      });
      result.push(item);
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw error;
      }
    }
  }

  return result;
}
