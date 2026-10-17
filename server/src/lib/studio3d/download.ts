// .part продолжается только с валидатором прежнего объекта и проверенным диапазоном.
// Полный EOF/размер подтверждаются до публикации; сбой диска не повторяется как сеть.
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as FS,
  createWriteStream,
  fstatSync,
  ftruncateSync,
  openSync,
  promises as fs,
} from 'node:fs';
import { Readable, Transform } from 'node:stream';
import type { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { setTimeout as pause } from 'node:timers/promises';

import { fetchPublicDownload } from './publicDownload.ts';

export interface DownloadOptions {
  url: string;
  dest: string;
  fetchImpl?: typeof fetch;
  refresh?: () => Promise<string>;
  attempts?: number;
  idleTimeoutMs?: number;
  maxBytes?: number;
  sleep?: (ms: number) => Promise<void>;
  createWriter?: (file: string, flags: number) => Writable;
  signal?: AbortSignal;
}

export type DownloadErrorCode = 'too-large' | 'expired' | 'gave-up' | 'disk' | 'invalid-range' | 'aborted';

export class DownloadError extends Error {
  code: DownloadErrorCode;

  constructor(code: DownloadErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

interface PartialMetadata {
  url: string;
  validator: string;
  total: number | null;
}

/**
 * Размер обычного своего partial. Ссылка и hardlink не превращаются в исходник
 * докачки; отсутствие допустимо, остальные отказы файловой системы видны как disk.
 */
async function sizeOf(file: string): Promise<number> {
  try {
    const stat = await fs.lstat(file);

    if (!stat.isFile() || stat.nlink !== 1) {
      throw new DownloadError('disk', 'Небезопасный частичный файл.');
    }

    return stat.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }

    throw diskFailure(error);
  }
}

/**
 * Сумма считается потоком и не требует держать модель в памяти. Имена/каталог
 * закрепляет вызывающая библиотека, а basename читается без следования ссылке.
 */
async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');

  const handle = await fs.open(file, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);

  try {
    await pipeline(handle.createReadStream({ autoClose: false }), hash);
  } finally {
    await handle.close();
  }

  return hash.digest('hex');
}

/**
 * Writer открывает имя без ссылок и передаёт stream уже проверенный fd.
 * Hardlink не позволяет изменить чужой inode даже при допустимом basename.
 */
function fileWriter(file: string, flags: number): Writable {
  const descriptor = openSync(file, flags & ~FS.O_TRUNC, 0o600);
  const stat = fstatSync(descriptor);

  if (!stat.isFile() || stat.nlink !== 1) {
    closeSync(descriptor);

    throw new DownloadError('disk', 'Небезопасный частичный файл.');
  }

  if (flags & FS.O_TRUNC) {
    ftruncateSync(descriptor, 0);
  }

  return createWriteStream(file, { fd: descriptor, autoClose: true });
}

/**
 * Сильный ETag пригоден для If-Range. Отсутствующий/weak validator заставляет
 * начать заново: один mtime или совпавшая длина целостности объекта не доказывают.
 */
function strongValidator(raw: string | null): string | null {
  return raw && /^"[^"\r\n]{1,512}"$/.test(raw) ? raw : null;
}

/**
 * Небольшое metadata читается отдельно от partial и имеет строгую форму. Битое
 * или недописанное metadata консервативно отключает докачку после рестарта.
 */
async function partialMetadata(file: string): Promise<PartialMetadata | null> {
  let handle;

  try {
    handle = await fs.open(file, FS.O_RDONLY | FS.O_NOFOLLOW);

    const stat = await handle.stat();

    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) {
      return null;
    }

    const parsed = JSON.parse(await handle.readFile('utf8')) as PartialMetadata;

    return parsed && typeof parsed.url === 'string' && strongValidator(parsed.validator)
      && (parsed.total === null || (Number.isSafeInteger(parsed.total) && parsed.total >= 0))
      ? parsed : null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/**
 * Metadata публикуется атомарно; потеря этой записи безопасно приводит к restart.
 * Своё временное имя убирается при отказе, чужие partial не затрагиваются.
 */
async function writeMetadata(file: string, value: PartialMetadata): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;

  try {
    await fs.writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

/**
 * Файловый отказ не маскируется бесконечными сетевыми повторами. Сообщение не
 * содержит путь, подписанную ссылку или текст системного исключения.
 */
function diskFailure(error: unknown): DownloadError {
  return error instanceof DownloadError ? error
    : new DownloadError('disk', 'Не удалось сохранить файл — проверьте место и доступ к библиотеке.');
}

/**
 * Начало/конец/полный размер 206 обязаны совпасть с прежним partial. Неполный
 * Content-Range или несогласованный Content-Length не разрешает append.
 */
function rangeOf(response: Response, have: number, previous: PartialMetadata | null) {
  const rawLength = response.headers.get('content-length');
  const length = rawLength !== null && /^\d+$/.test(rawLength) ? Number(rawLength) : null;

  if (length !== null && !Number.isSafeInteger(length)) {
    throw new DownloadError('invalid-range', 'Неверный размер ответа CDN.');
  }

  if (response.status === 200) {
    return {
      total: length,
      expected: length,
      append: false
    };
  }

  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
  const [start, end, total] = match ? match.slice(1).map(Number) : [];

  if (!match || !previous || have === 0 || start !== have || !Number.isSafeInteger(total)
    || !Number.isSafeInteger(end) || end! < start! || end! >= total!
    || (previous.total !== null && total !== previous.total)
    || (length !== null && length !== end! - start! + 1)) {
    throw new DownloadError('invalid-range', 'CDN вернул несогласованный диапазон.');
  }

  return {
    total: total!,
    expected: end! - start! + 1,
    append: true
  };
}

/**
 * Одна попытка включает срок headers и простой body. Только совпавший ETag
 * разрешает продолжение, все остальные ответы начинают новый объект с нуля.
 */
async function downloadAttempt(options: DownloadOptions, url: string, part: string, meta: string) {
  const maximum = options.maxBytes ?? 1024 ** 3;
  const idleMs = options.idleTimeoutMs ?? 60_000;
  const controller = new AbortController();
  const onAbort = () => controller.abort();

  options.signal?.addEventListener('abort', onAbort, { once: true });
  
  let timer: ReturnType<typeof setTimeout>;
  let received = 0;
  let response: Response | null = null;
  const previous = await partialMetadata(meta);
  const partialSize = await sizeOf(part);
  const resumable = previous?.url === url && strongValidator(previous.validator);
  const have = resumable ? partialSize : 0;
  const resetTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), idleMs);
  };
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('download_timeout')), { once: true });
  });

  if (options.signal?.aborted) {
    options.signal.removeEventListener('abort', onAbort);

    throw new DownloadError('aborted', 'Скачивание остановлено.');
  }

  if (partialSize > maximum) {
    throw new DownloadError('too-large', 'Файл больше допустимого размера.');
  }

  resetTimer();

  try {
    response = await Promise.race([(options.fetchImpl ?? fetchPublicDownload)(url, {
      redirect: 'manual',
      headers: have > 0 ? { Range: `bytes=${have}-`, 'If-Range': previous!.validator } : {},
      signal: controller.signal,
    }), aborted]);

    if ([401, 403, 404, 410].includes(response.status)) {
      return 'expired' as const;
    }

    if (response.status === 416) {
      await fs.rm(part, { force: true });
      await fs.rm(meta, { force: true });

      return 'retry' as const;
    }

    if (![200, 206].includes(response.status) || !response.body) {
      return 'retry' as const;
    }

    const validator = strongValidator(response.headers.get('etag'));

    if (response.status === 206 && (!validator || validator !== previous?.validator || !have)) {
      await fs.rm(part, { force: true });
      await fs.rm(meta, { force: true });

      return 'retry' as const;
    }

    const range = rangeOf(response, have, previous);

    if (range.total !== null && range.total > maximum) {
      throw new DownloadError('too-large', 'Файл больше допустимого размера.');
    }

    if (validator) {
      await writeMetadata(meta, {
        url,
        validator,
        total: range.total
      });
    } else {
      await fs.rm(meta, { force: true });
    }

    const flags = FS.O_WRONLY | FS.O_CREAT | FS.O_NOFOLLOW | (range.append ? FS.O_APPEND : FS.O_TRUNC);
    const guard = new Transform({
      /**
       * Лимит и срок обновляются до передачи chunk на диск. Переполнение
       * останавливает pipeline, не оставляя опубликованный частичный результат.
       */
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        resetTimer();

        if (received + (range.append ? have : 0) > maximum) {
          done(new DownloadError('too-large', 'Файл больше допустимого размера.'));

          return;
        }

        done(null, chunk);
      }
    });
    let writer: Writable;

    try {
      writer = options.createWriter?.(part, flags) ?? fileWriter(part, flags);
      writer.on('error', (error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOSPC') {
          guard.destroy(diskFailure(error));
        }
      });
    } catch (error) {
      throw diskFailure(error);
    }

    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>),
      guard,
      writer,
      { signal: controller.signal },
    );

    const actual = await sizeOf(part);

    if ((range.expected !== null && received !== range.expected)
      || (range.total !== null && actual !== range.total)) {
      return 'retry' as const;
    }

    return 'done' as const;
  } catch (error) {
    if (options.signal?.aborted) {
      throw new DownloadError('aborted', 'Скачивание остановлено.');
    }

    if (error instanceof DownloadError) {
      throw error;
    }

    if (['ENOSPC', 'EDQUOT', 'EACCES', 'EROFS', 'EIO', 'ENOENT', 'ENOTDIR', 'ELOOP']
      .includes((error as NodeJS.ErrnoException).code ?? '')) {
      throw diskFailure(error);
    }

    return 'retry' as const;
  } finally {
    clearTimeout(timer!);
    options.signal?.removeEventListener('abort', onAbort);
    void response?.body?.cancel().catch(() => {});
  }
}

/**
 * Готовый файл появляется только после проверки EOF/диапазона и локального SHA.
 * Refresh перечитывает оплаченный результат; новая ссылка не наследует старую докачку.
 */
export async function downloadToFile(options: DownloadOptions): Promise<{ size: number; sha256: string }> {
  const part = `${options.dest}.part`;
  const meta = `${part}.meta.json`;
  const attempts = options.attempts ?? 6;
  const sleep = options.sleep ?? pause;
  let url = options.url;
  let refreshes = 0;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (options.signal?.aborted) {
      throw new DownloadError('aborted', 'Скачивание остановлено.');
    }

    const result = await downloadAttempt(options, url, part, meta);

    if (result === 'done') {
      const size = await sizeOf(part);
      const sha256 = await hashFile(part);
      const handle = await fs.open(part, FS.O_RDONLY | FS.O_NOFOLLOW);

      try {
        await handle.sync();
      } finally {
        await handle.close();
      }

      await fs.rename(part, options.dest);
      await fs.rm(meta, { force: true });

      return { size, sha256 };
    }

    if (result === 'expired') {
      if (!options.refresh || refreshes >= 3) {
        throw new DownloadError('expired', 'Ссылка на файл протухла, а обновить её нечем.');
      }

      refreshes += 1;
      url = await options.refresh();
      continue;
    }

    if (attempt < attempts) {
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 15_000));
    }
  }

  throw new DownloadError('gave-up', `Файл не скачался за ${attempts} попыток.`);
}
