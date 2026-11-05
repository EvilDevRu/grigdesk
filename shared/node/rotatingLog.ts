import { constants } from 'node:fs';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';

import { archiveLog, importLegacyLog, logParts, openLogFile, recoverLogArchives } from './logArchives.ts';

export type RotatingLogOptions = {
  maxBytes?: number;
  maxArchives?: number;
  maxTotalBytes?: number;
  maxAgeMs?: number;
};

/**
 * Единственный потребитель stdout/stderr владеет файлом и ротацией.
 * Backpressure удерживает очередь в пределах Writable, gzip идёт потоком.
 */
export class RotatingLog extends Writable {
  readonly file: string;
  private readonly limits: Required<RotatingLogOptions>;

  constructor(file: string, options: RotatingLogOptions = {}) {
    super({ highWaterMark: 64 * 1024 });
    this.file = file;
    this.limits = {
      maxBytes: options.maxBytes ?? 10 * 1024 * 1024,
      maxArchives: options.maxArchives ?? 10,
      maxTotalBytes: options.maxTotalBytes ?? 100 * 1024 * 1024,
      maxAgeMs: options.maxAgeMs ?? 14 * 24 * 60 * 60 * 1000,
    };

    if (Object.values(this.limits).some((value) => !Number.isSafeInteger(value) || value < 1)
      || this.limits.maxTotalBytes < this.limits.maxBytes) {
      throw new Error('invalid_log_limits');
    }
  }

  /**
   * Каталог нового журнала закрыт от других пользователей. Готовый родитель
   * не меняет права, поскольку в нём могут лежать другие данные приложения.
   */
  override _construct(callback: (error?: Error | null) => void): void {
    void mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
      .then(() => recoverLogArchives(this.file))
      .then(() => importLegacyLog(this.file))
      .then(() => this.prepareCurrent())
      .then(() => this.prune())
      .then(() => callback(), callback);
  }

  /**
   * Старый активный файл мог вырасти сверх нового предела ещё до обновления.
   * Он архивируется до первого chunk, чтобы бюджет действовал уже при запуске.
   */
  private async prepareCurrent(): Promise<void> {
    const handle = await openLogFile(this.file, constants.O_WRONLY | constants.O_CREAT);
    let size: number;

    try {
      await handle.chmod(0o600);
      size = (await handle.stat()).size;
    } finally {
      await handle.close();
    }

    if (size >= this.limits.maxBytes) {
      await archiveLog(this.file);
      await this.prepareCurrent();
    }
  }

  /**
   * Пишет ограниченными частями и закрывает fd до переименования.
   * Даже один большой chunk не может создать активный файл сверх лимита.
   */
  private async append(buffer: Buffer): Promise<void> {
    let offset = 0;

    while (offset < buffer.length) {
      const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND;
      const handle = await openLogFile(this.file, flags);
      let size = 0;

      try {
        await handle.chmod(0o600);
        size = (await handle.stat()).size;

        if (size < this.limits.maxBytes) {
          const length = Math.min(buffer.length - offset, this.limits.maxBytes - size);
          const result = await handle.write(buffer, offset, length);

          if (result.bytesWritten === 0) {
            throw new Error('log_short_write');
          }

          offset += result.bytesWritten;
          size += result.bytesWritten;
        }
      } finally {
        await handle.close();
      }

      if (size >= this.limits.maxBytes) {
        await archiveLog(this.file);

        const current = await openLogFile(this.file, constants.O_WRONLY | constants.O_CREAT);

        await current.close();
        await this.prune();
      }
    }
  }

  /**
   * Очередь Writable сериализует обе трубы и не подтверждает chunk до записи.
   * Ошибка диска становится error владельца вместо молчаливой потери событий.
   */
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    void this.append(chunk).then(() => callback(), callback);
  }

  /**
   * Удаляет только старейшие собственные архивы по возрасту, числу и сумме.
   * Активному файлу заранее оставлен полный бюджет одного сегмента.
   */
  private async prune(): Promise<void> {
    const dir = path.dirname(this.file);
    const parts = logParts(await readdir(dir), path.basename(this.file));
    const sizes = await Promise.all(parts.map((part) => stat(path.join(dir, part.name))));
    let total = sizes.reduce((sum, info) => sum + info.size, this.limits.maxBytes);

    for (let index = 0; index < parts.length; index += 1) {
      const info = sizes[index]!;
      const expired = Date.now() - info.mtimeMs > this.limits.maxAgeMs;
      const excess = parts.length - index > this.limits.maxArchives || total > this.limits.maxTotalBytes;

      if (expired || excess) {
        await unlink(path.join(dir, parts[index]!.name));
        total -= info.size;
      }
    }
  }
}
