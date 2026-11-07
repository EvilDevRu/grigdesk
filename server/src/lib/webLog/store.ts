import { constants } from 'node:fs';
import { chmod, mkdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import {
  archiveLog, logSnapshotStream, openLogFile, recoverLogArchives, snapshotLogs,
} from '../../../../shared/node/logArchives.ts';
import { validUtcDay, webLogFiles } from './files.ts';

export { validUtcDay } from './files.ts';

import type { FileHandle } from 'node:fs/promises';
import type { WebLogEntry } from '../../../../shared/web-log/webLogContracts.ts';

export type WebLogAck = {
  accepted: number;
  dropped: number;
  reason: 'daily_limit' | null;
};

export type WebLogStoreOptions = {
  dir: string;
  now?: () => Date;
  segmentBytes?: number;
  maxTotalBytes?: number;
  maxArchives?: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const RETAINED_PAST_DAYS = 13;

/**
 * Все операции append проходят через одну цепочку. Проверка размера и запись
 * образуют критическую секцию даже при нескольких одновременных HTTP-запросах.
 */
export function createWebLogStore(options: WebLogStoreOptions) {
  const dir = options.dir;
  const now = options.now ?? (() => new Date());
  const segmentBytes = options.segmentBytes ?? 20 * 1024 * 1024;
  const maxTotalBytes = options.maxTotalBytes ?? 280 * 1024 * 1024;
  const maxArchives = options.maxArchives ?? 128;
  const repaired = new Set<string>();
  let chain: Promise<unknown> = Promise.resolve();
  let closed = false;
  let recovered = false;

  if ([segmentBytes, maxTotalBytes, maxArchives].some((value) => !Number.isSafeInteger(value) || value < 1)
    || maxTotalBytes < segmentBytes) {
    throw new Error('invalid_web_log_limits');
  }

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

    if (!recovered) {
      const groups = await webLogFiles(dir);

      for (const day of groups.keys()) {
        await recoverLogArchives(fileOf(day));
      }

      recovered = true;
    }
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
   * Пачка последовательно записывается целыми строками, при заполнении части
   * запись продолжается после ротации. Ошибка диска не превращается в ACK.
   */
  function append(entries: WebLogEntry[]): Promise<WebLogAck> {
    return exclusive(async () => {
      if (closed) {
        throw new Error('web_log_closed');
      }

      await ensureDirectory();

      const received = now().toISOString();
      const day = received.slice(0, 10);
      let index = 0;

      while (index < entries.length) {
        const handle = await openLogFile(fileOf(day), constants.O_RDWR | constants.O_CREAT);
        let rotate = false;

        try {
          await handle.chmod(0o600);
          await repairTail(handle, day);

          let size = (await handle.stat()).size;
          const lines: string[] = [];

          while (index < entries.length) {
            const entry = entries[index]!;
            const line = `${JSON.stringify({ ...entry, rx: received })}\n`;
            const length = Buffer.byteLength(line, 'utf8');

            if (size > 0 && size + length > segmentBytes) {
              rotate = true;

              break;
            }

            lines.push(line);
            size += length;
            index += 1;
          }

          if (lines.length) {
            await writeLines(handle, day, lines);
          }
        } finally {
          await handle.close();
        }

        if (rotate) {
          await archiveLog(fileOf(day));
          repaired.delete(day);
          await cleanupFiles();
        }
      }

      await cleanupFiles();

      return {
        accepted: entries.length,
        dropped: 0,
        reason: null,
      };
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

      await cleanupFiles();
    });
  }

  /**
   * Возраст, число частей и общий размер ограничивают весь каталог журнала.
   * Самый новый активный файл сохраняется, старые данные уходят первыми.
   */
  async function cleanupFiles(): Promise<void> {
    const cutoff = new Date(now().getTime() - RETAINED_PAST_DAYS * DAY_MS)
      .toISOString()
      .slice(0, 10);
    const groups = await webLogFiles(dir);
    const files = [...groups.entries()].flatMap(([day, names]) => names.map((name) => ({ day, name })));
    const sizes = await Promise.all(files.map((file) => stat(path.join(dir, file.name))));
    let total = sizes.reduce((sum, info) => sum + info.size, 0);
    let archives = files.filter((file) => file.name !== `${file.day}.ndjson`).length;

    for (let index = 0; index < files.length; index += 1) {
      const { day, name } = files[index]!;
      const newest = index === files.length - 1;
      const archive = name !== `${day}.ndjson`;
      const excess = total > maxTotalBytes || (archive && archives > maxArchives);

      if (day < cutoff || (!newest && excess)) {
        await unlink(path.join(dir, name));
        total -= sizes[index]!.size;
        archives -= Number(archive);
      }
    }
  }

  /**
   * Снимок всех частей фиксируется под той же очередью, что запись и ротация.
   * Поток владеет FileHandle и закрывает их при окончании или отмене скачивания.
   */
  function download(day: string): Promise<Readable | null> {
    return exclusive(async () => {
      if (!validUtcDay(day)) {
        return null;
      }

      await ensureDirectory();

      const names = (await webLogFiles(dir)).get(day);

      return names ? logSnapshotStream(await snapshotLogs(dir, names)) : null;
    });
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
