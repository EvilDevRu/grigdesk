import { constants } from 'node:fs';
import { lstat, open, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

import type { FileHandle } from 'node:fs/promises';

export type LogPart = {
  name: string;
  base: string;
  sequence: number;
  compressed: boolean;
};

export type LogSnapshot = {
  parts: Array<{
    handle: FileHandle;
    size: number;
    name: string;
  }>;
};

/**
 * Узнаёт только собственные завершённые части журнала. Несжатая часть остаётся
 * читаемой после аварии; при наличии gzip с тем же номером выбирается gzip.
 */
export function logParts(names: string[], base: string): LogPart[] {
  const found = new Map<number, LogPart>();

  for (const name of names) {
    if (!name.startsWith(`${base}.`)) {
      continue;
    }

    const match = /^(\d{16})\.(gz|raw)$/u.exec(name.slice(base.length + 1));

    if (!match) {
      continue;
    }

    const sequence = Number(match[1]);
    const compressed = match[2] === 'gz';

    if (!Number.isSafeInteger(sequence)) {
      continue;
    }

    if (!found.has(sequence) || compressed) {
      found.set(sequence, {
        name,
        base,
        sequence,
        compressed,
      });
    }
  }

  return [...found.values()].sort((left, right) => left.sequence - right.sequence);
}

/**
 * Открывает только обычный файл без перехода по симлинку. Проверка типа
 * выполняется по дескриптору и не зависит от замены имени после open.
 */
export async function openLogFile(file: string, flags = constants.O_RDONLY): Promise<FileHandle> {
  const handle = await open(file, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);

  try {
    if (!(await handle.stat()).isFile()) {
      throw new Error('log_not_regular_file');
    }

    return handle;
  } catch (error) {
    await handle.close();

    throw error;
  }
}

/**
 * Незавершённый gzip не является архивом: он удаляется и строится из raw заново.
 * После публикации gzip лишняя raw-копия удаляется, не удваивая бюджет хранения.
 */
export async function recoverLogArchives(file: string): Promise<void> {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const names = await readdir(dir);

  for (const name of names) {
    if (!name.startsWith(`${base}.`)) {
      continue;
    }

    const suffix = name.slice(base.length + 1);

    if (/^\d{16}\.gz\.tmp$/u.test(suffix)) {
      await unlink(path.join(dir, name));
    }
  }

  for (const part of logParts(names.filter((name) => name.endsWith('.raw')), base)) {
    const raw = path.join(dir, part.name);

    if (names.includes(part.name.slice(0, -4) + '.gz')) {
      await unlink(raw);
    } else {
      await compressLog(raw);
    }
  }
}

/**
 * Прежняя единственная копия .1 становится обычным архивом до новых записей.
 * Симлинк не импортируется: читать чужой файл под видом лога запрещено.
 */
export async function importLegacyLog(file: string): Promise<void> {
  const legacy = `${file}.1`;
  const info = await lstat(legacy).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }

    return null;
  });

  if (info?.isFile()) {
    await archiveLog(file, legacy);
  }
}

/**
 * Сначала закрытая часть получает собственное имя, затем gzip публикуется
 * атомарно. Ошибка сжатия оставляет raw; чужие файлы не перезаписываются.
 */
export async function archiveLog(file: string, source = file): Promise<void> {
  const names = await readdir(path.dirname(file));
  const previous = logParts(names, path.basename(file)).at(-1)?.sequence ?? 0;
  const sequence = String(Math.max(Date.now(), previous + 1)).padStart(16, '0');
  const raw = `${file}.${sequence}.raw`;

  await rename(source, raw);
  await compressLog(raw);
}

/**
 * Потоковое сжатие ограничивает память независимо от размера старого лога.
 * Временный gzip никогда не участвует в чтении и убирается после отказа.
 */
export async function compressLog(raw: string): Promise<void> {
  const target = raw.slice(0, -4) + '.gz';
  const temporary = `${target}.tmp`;
  const input = await openLogFile(raw);
  let output: FileHandle | undefined;

  try {
    output = await openLogFile(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);

    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        void output!.writeFile(chunk).then(() => callback(), callback);
      },
    });

    await pipeline(Readable.from(readPart(input, (await input.stat()).size)), createGzip(), destination);
    await output.sync();
    await rename(temporary, target);
    await unlink(raw);
  } catch (error) {
    if (output) {
      await unlink(temporary).catch(() => undefined);
    }

    throw error;
  } finally {
    await Promise.all([input.close(), output?.close()]);
  }
}

/**
 * Фиксирует дескрипторы и размеры до начала скачивания. Ротация и уборка
 * могут менять имена, но уже открытое скачивание дочитает прежние inode.
 */
export async function snapshotLogs(dir: string, names: string[]): Promise<LogSnapshot> {
  const snapshot: LogSnapshot = { parts: [] };

  try {
    for (const name of names) {
      const handle = await openLogFile(path.join(dir, name));
      const part = {
        handle,
        name,
        size: 0,
      };

      snapshot.parts.push(part);
      part.size = (await handle.stat()).size;
    }

    return snapshot;
  } catch (error) {
    await closeLogSnapshot(snapshot);

    throw error;
  }
}

/**
 * Один снимок допускает несколько потоковых проходов reader-а.
 * Дескрипторы закрывает владелец снимка после последнего прохода.
 */
export async function* snapshotChunks(snapshot: LogSnapshot): AsyncGenerator<Buffer> {
  for (const part of snapshot.parts) {
    if (part.size === 0) {
      continue;
    }

    const input = Readable.from(readPart(part.handle, part.size));
    const stream = part.name.endsWith('.gz') ? input.pipe(createGunzip()) : input;

    if (stream !== input) {
      input.on('error', (error) => stream.destroy(error));
    }

    try {
      for await (const chunk of stream) {
        yield chunk as Buffer;
      }
    } finally {
      input.destroy();
      stream.destroy();
    }
  }
}

/**
 * Читает ограниченный диапазон через FileHandle, не передавая потоку владение fd.
 * Поэтому отмена первого прохода не мешает повторному чтению того же снимка.
 */
async function* readPart(handle: FileHandle, size: number): AsyncGenerator<Buffer> {
  let position = 0;

  while (position < size) {
    const buffer = Buffer.alloc(Math.min(64 * 1024, size - position));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);

    if (bytesRead === 0) {
      break;
    }

    position += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}

/**
 * Закрытие идемпотентно: destroy скачивания может случиться до первого next.
 * Это также освобождает снимок при раннем отказе HTTP-клиента.
 */
export async function closeLogSnapshot(snapshot: LogSnapshot): Promise<void> {
  await Promise.all(snapshot.parts.map((part) => part.handle.close()));
}

/**
 * HTTP-поток владеет снимком и освобождает его при конце или отмене.
 * Все части возвращаются обычным текстом, gzip прозрачен потребителю.
 */
export function logSnapshotStream(snapshot: LogSnapshot): Readable {
  const stream = Readable.from(snapshotChunks(snapshot));

  stream.once('close', () => {
    void closeLogSnapshot(snapshot).catch(() => undefined);
  });

  return stream;
}
