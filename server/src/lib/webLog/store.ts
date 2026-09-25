import { constants } from 'node:fs';
import { chmod, mkdir, open, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import type { FileHandle } from 'node:fs/promises';
import type { WebLogEntry } from '../../../../shared/webLogContracts.ts';

export type WebLogAck = {
  accepted: number;
  dropped: number;
  reason: 'daily_limit' | null;
};

export type WebLogStoreOptions = {
  dir: string;
  now?: () => Date;
  dailyBytes?: number;
  warn?: (message: string) => void;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const RETAINED_PAST_DAYS = 13;

/**
 * Календарный UTC-день вида YYYY-MM-DD, который реально существует.
 * Только такое имя может стать именем дневного файла журнала.
 */
export function validUtcDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Все операции append проходят через одну цепочку. Проверка размера и запись
 * образуют критическую секцию даже при нескольких одновременных HTTP-запросах.
 */
export function createWebLogStore(options: WebLogStoreOptions) {
  const dir = options.dir;
  const now = options.now ?? (() => new Date());
  const dailyBytes = options.dailyBytes ?? 20 * 1024 * 1024;
  const repaired = new Set<string>();
  const warned = new Set<string>();
  let chain: Promise<unknown> = Promise.resolve();
  let closed = false;

  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = chain.then(operation, operation);

    chain = result.then(() => undefined, () => undefined);

    return result;
  }

  /**
   * Проверяем права каталога до записи и чтения. Ошибка здесь остаётся ошибкой
   * конкретного endpoint, не причиной падения всего сервера при запуске.
   */
  async function ensureDirectory(): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });

    const info = await stat(dir);

    if (!info.isDirectory()) {
      throw new Error('web_log_directory_unavailable');
    }

    await chmod(dir, 0o700);
  }

  function fileOf(day: string): string {
    return path.join(dir, `${day}.ndjson`);
  }

  /**
   * После аварийного завершения в конце файла может остаться недописанная
   * строка. Отрезаем только её и только один раз за процесс для каждого дня.
   */
  async function repairTail(handle: FileHandle, day: string): Promise<void> {
    if (repaired.has(day)) {
      return;
    }

    const size = (await handle.stat()).size;

    if (size > 0) {
      const count = Math.min(size, 64 * 1024);
      const tail = Buffer.alloc(count);

      await handle.read(tail, 0, count, size - count);

      if (tail.at(-1) !== 10) {
        await handle.truncate(size - count + tail.lastIndexOf(10) + 1);
      }
    }

    repaired.add(day);
  }

  /**
   * Дописываем строки целиком; при ошибке записи файл возвращается к прежней
   * длине, чтобы в нём не осталось обрывка, а ошибка ушла наверх как 503.
   */
  async function writeLines(handle: FileHandle, day: string, lines: string[]): Promise<void> {
    const data = Buffer.from(lines.join(''), 'utf8');
    const start = (await handle.stat()).size;
    let written = 0;

    try {
      while (written < data.length) {
        const result = await handle.write(data, written, data.length - written, start + written);

        if (result.bytesWritten < 1) {
          throw new Error('web_log_short_write');
        }

        written += result.bytesWritten;
      }
    } catch (error) {
      repaired.delete(day);
      await handle.truncate(start).catch(() => undefined);

      throw error;
    }
  }

  /**
   * Приём пачки подтверждает только реально дописанный префикс. Дата и rx
   * принадлежат серверу, поэтому часы браузера не выбирают файл.
   */
  function append(entries: WebLogEntry[]): Promise<WebLogAck> {
    return exclusive(async () => {
      if (closed) {
        throw new Error('web_log_closed');
      }

      await ensureDirectory();

      const received = now().toISOString();
      const day = received.slice(0, 10);
      const flags = constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW;
      const handle = await open(fileOf(day), flags, 0o600);

      try {
        await handle.chmod(0o600);
        await repairTail(handle, day);

        let size = (await handle.stat()).size;
        const lines: string[] = [];

        for (const entry of entries) {
          const line = `${JSON.stringify({ ...entry, rx: received })}\n`;
          const length = Buffer.byteLength(line, 'utf8');

          if (size + length > dailyBytes) {
            break;
          }

          lines.push(line);
          size += length;
        }

        if (lines.length) {
          await writeLines(handle, day, lines);
        }

        const dropped = entries.length - lines.length;

        if (dropped && !warned.has(day)) {
          warned.add(day);
          options.warn?.('Суточная квота журнала окна исчерпана.');
        }

        return {
          accepted: lines.length,
          dropped,
          reason: dropped ? 'daily_limit' : null,
        };
      } finally {
        await handle.close();
      }
    });
  }

  /**
   * Удаляются только файлы собственного шаблона старше текущего и 13
   * предыдущих дней. Плановая уборка идёт даже без новых записей.
   */
  function cleanup(): Promise<void> {
    return exclusive(async () => {
      if (closed) {
        return;
      }

      await ensureDirectory();

      const cutoff = new Date(now().getTime() - RETAINED_PAST_DAYS * DAY_MS)
        .toISOString()
        .slice(0, 10);

      for (const name of await readdir(dir)) {
        const day = name.endsWith('.ndjson') ? name.slice(0, -'.ndjson'.length) : '';

        if (validUtcDay(day) && day < cutoff) {
          await unlink(fileOf(day));
        }
      }
    });
  }

  /**
   * Фиксируем длину открытого файла: активный append не удлиняет скачивание.
   * O_NOFOLLOW исключает подмену дневного файла ссылкой на чужие данные.
   * Поток получает сам FileHandle и закрывает его: голый fd закрывался бы
   * дважды — потоком и сборщиком мусора, уже чужой дескриптор.
   */
  async function download(day: string): Promise<Readable | null> {
    if (!validUtcDay(day)) {
      return null;
    }

    let handle: FileHandle;

    try {
      handle = await open(fileOf(day), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }

      throw error;
    }

    try {
      const size = (await handle.stat()).size;

      if (size === 0) {
        await handle.close();

        return Readable.from([]);
      }

      return handle.createReadStream({
        start: 0,
        end: size - 1,
      });
    } catch (error) {
      await handle.close();

      throw error;
    }
  }

  const timer = setInterval(() => {
    void cleanup().catch(() => undefined);
  }, DAY_MS);

  timer.unref();
  void cleanup().catch(() => undefined);

  /** Останавливаем плановую уборку и дожидаемся уже начатой записи. */
  async function close(): Promise<void> {
    clearInterval(timer);
    await chain;
    closed = true;
  }

  return {
    append,
    cleanup,
    download,
    close,
  };
}
