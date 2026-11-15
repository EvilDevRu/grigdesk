import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { VoiceError } from '../contract.ts';

export interface CheckedDownload {
  url: string;
  file: string;
  expectedSha256: string;
  expectedBytes: number;
  fetch: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Считает хеш файла потоком, чтобы модели не загружались целиком в память Node.
 * Отмена проверяется между чанками и завершает принадлежащий вызову поток.
 */
export async function sha256OfFile(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(file);

  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      hash.update(chunk as Buffer);
    }

    signal?.throwIfAborted();

    return hash.digest('hex');
  } finally {
    stream.destroy();
  }
}

/**
 * Кэш допускает только обычный файл: ссылка не должна менять чужую цель при restart.
 * Отсутствие файла означает пустой префикс, остальные ошибки доступа не скрываются.
 */
async function cachedBytes(file: string): Promise<number> {
  try {
    const info = await fs.lstat(file);

    if (!info.isFile()) {
      throw new VoiceError('Кэш загрузки должен быть обычным файлом.');
    }

    return info.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }

    throw error;
  }
}

/**
 * Обнуляет только проверенный обычный файл кэша, не следуя ссылке.
 * Один integrity restart не превращается в бесконечное скачивание повреждённого источника.
 */
async function resetCache(file: string): Promise<void> {
  const handle = await fs.open(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  );

  await handle.close();
}

/**
 * Закрывает неиспользованное тело ответа до следующего запроса.
 * Ошибка отмены тела не заменяет первоначальный отказ статуса или диапазона.
 */
async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/**
 * Проверяет Content-Range независимо от заголовка запроса: сервер мог вернуть другой кусок.
 * Неправильный offset или размер не дописывается к уже сохранённым данным.
 */
function rangeLength(response: Response, offset: number, total: number): number {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(response.headers.get('content-range') ?? '');
  const first = Number(match?.[1]);
  const last = Number(match?.[2]);
  const size = Number(match?.[3]);

  if (!match || first !== offset || size !== total
    || !Number.isSafeInteger(last) || last < first || last >= total) {
    throw new VoiceError('Источник вернул неверный Content-Range; кэш не изменён.');
  }

  return last - first + 1;
}

/**
 * Сохраняет каждый принятый чанк сразу: сетевой обрыв оставляет настоящий префикс для повтора.
 * Read/write ограничены размером пакета; поток и файловый дескриптор закрываются на любом исходе.
 */
async function storeBody(
  response: Response,
  file: string,
  offset: number,
  maximum: number,
  signal: AbortSignal,
): Promise<number> {
  if (!response.body) {
    throw new VoiceError('Источник не вернул тело файла.');
  }

  const reader = response.body.getReader();
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW
    | (offset > 0 ? constants.O_APPEND : constants.O_TRUNC);
  const handle = await fs.open(file, flags, 0o600).catch(async (error: unknown) => {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();

    throw error;
  });
  let received = 0;
  const cancel = (): void => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };

  signal.addEventListener('abort', cancel, { once: true });

  try {
    signal.throwIfAborted();

    for (;;) {
      const chunk = await reader.read();

      signal.throwIfAborted();

      if (chunk.done) {
        break;
      }

      if (received + chunk.value.byteLength > maximum) {
        throw new VoiceError('Источник превысил закреплённый размер файла.');
      }

      let written = 0;

      while (written < chunk.value.byteLength) {
        const result = await handle.write(chunk.value, written, chunk.value.byteLength - written);

        if (result.bytesWritten === 0) {
          throw new VoiceError('Не удалось записать полученную часть модели.');
        }

        written += result.bytesWritten;
        received += result.bytesWritten;
      }
    }

    return received;
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    await handle.close();
  }
}

/**
 * Принимает только файл с закреплённым размером и SHA: готовый кэш проверяется до сети.
 * Сетевой обрыв оставляет partial; повреждение полного файла или 416 допускает один restart.
 */
export async function downloadChecked(spec: CheckedDownload): Promise<string> {
  if (!Number.isSafeInteger(spec.expectedBytes) || spec.expectedBytes <= 0
    || !/^[a-f0-9]{64}$/u.test(spec.expectedSha256)) {
    throw new VoiceError('У пакета нет корректного размера и SHA-256.');
  }

  const timeout = spec.timeoutMs ?? 900_000;

  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new VoiceError('Срок загрузки должен быть положительным числом миллисекунд.');
  }

  const signal = AbortSignal.any([
    AbortSignal.timeout(timeout),
    ...(spec.signal ? [spec.signal] : []),
  ]);
  let restarted = false;

  await fs.mkdir(path.dirname(spec.file), { recursive: true, mode: 0o700 });

  try {
    for (;;) {
      signal.throwIfAborted();

      let have = await cachedBytes(spec.file);

      if (have >= spec.expectedBytes) {
        const actual = await sha256OfFile(spec.file, signal);

        if (have === spec.expectedBytes && actual === spec.expectedSha256) {
          return spec.file;
        }

        if (restarted) {
          throw new VoiceError(`SHA-256: ожидалось ${spec.expectedSha256}, получено ${actual}.`);
        }

        await resetCache(spec.file);
        restarted = true;
        have = 0;
      }

      const response = await spec.fetch(spec.url, {
        headers: have > 0 ? { Range: `bytes=${have}-` } : {},
        signal,
      });

      if (response.status === 416) {
        await discard(response);

        if (restarted) {
          throw new VoiceError('Источник повторно отверг докачку: HTTP 416.');
        }

        await resetCache(spec.file);
        restarted = true;
        continue;
      }

      if (response.status !== 200 && response.status !== 206) {
        await discard(response);

        throw new VoiceError(`Не удалось скачать модель: HTTP ${response.status}.`);
      }

      let expectedBody = spec.expectedBytes;

      if (response.status === 206) {
        try {
          expectedBody = rangeLength(response, have, spec.expectedBytes);
        } catch (error) {
          await discard(response);

          throw error;
        }
      } else {
        have = 0;
      }

      const received = await storeBody(response, spec.file, have, expectedBody, signal);

      if (received !== expectedBody || have + received !== spec.expectedBytes) {
        throw new VoiceError('Загрузка оборвалась; сохранённый префикс будет использован при повторе.');
      }

      // Полный файл проверяется в начале следующей итерации; один restart ещё возможен.
    }
  } catch (error) {
    if (signal.aborted) {
      const reason = spec.signal?.aborted ? 'Установка отменена.' : 'Истёк срок загрузки модели.';

      throw new VoiceError(`${reason} Сохранённый префикс можно докачать повторным запуском.`);
    }

    if (error instanceof VoiceError) {
      throw error;
    }

    throw new VoiceError('Загрузка или запись оборвалась; сохранённый префикс доступен при повторе.');
  }
}
