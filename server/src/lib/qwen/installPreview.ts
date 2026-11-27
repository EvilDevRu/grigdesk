import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import {
  QWEN_PREVIEW_SUPPORTED, QWEN_PREVIEW_VERSION, verifyQwenPreviewBinary,
} from './previewRelease.ts';

const execute = promisify(execFile);
const ARCHIVE = `https://github.com/QwenLM/qwen-code/releases/download/v${QWEN_PREVIEW_VERSION}`
  + '/qwen-linux-x64.tar.gz';
const ARCHIVE_SIZE = 68182495;
const ARCHIVE_SHA256 = '1543dfc2562b520bc03ba483f09d4acc41843f026b4187ccb76c7ea9f4fe58e8';
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Загружает только закреплённый архив с верхним пределом размера. Tar получает
 * файл после совпадения размера и SHA-256, а не сразу из сети.
 */
async function downloadArchive(file: string, signal?: AbortSignal): Promise<void> {
  const deadline = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const response = await fetch(ARCHIVE, {
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });

  if (!response.ok || !response.body) {
    await response.body?.cancel();

    throw new Error('Не удалось скачать официальный архив Qwen Code. Повторите установку.');
  }

  const hash = createHash('sha256');
  let size = 0;

  /**
   * Проверка выполняется при записи, чтобы лишние байты не заняли диск.
   * Точный digest сверяется после окончания потока.
   */
  async function* verify(stream: AsyncIterable<Uint8Array>) {
    for await (const chunk of stream) {
      size += chunk.byteLength;

      if (size > ARCHIVE_SIZE) {
        throw new Error('Размер архива Qwen Code не совпадает с ожидаемым.');
      }

      hash.update(chunk);

      yield chunk;
    }
  }

  await pipeline(response.body, verify, createWriteStream(file, { mode: 0o600 }));

  if (size !== ARCHIVE_SIZE || hash.digest('hex') !== ARCHIVE_SHA256) {
    throw new Error('Контрольная сумма архива Qwen Code не подтверждена.');
  }
}

/**
 * Готовый ELF публикуется одним rename после проверки архива и самого бинарника.
 * Действующая копия остаётся доступной при прерывании или отказе загрузки.
 */
export async function installQwenPreview(target: string, signal?: AbortSignal): Promise<void> {
  if (!QWEN_PREVIEW_SUPPORTED || !path.isAbsolute(target)) {
    throw new Error('Установка Qwen Code Preview.2 доступна на Linux x64.');
  }

  signal?.throwIfAborted();

  const installed = await verifyQwenPreviewBinary(target).catch(() => null);

  if (installed) {
    await installed.descriptor.close();

    return;
  }

  const root = path.dirname(target);

  await fs.mkdir(root, { recursive: true, mode: 0o700 });

  const stage = await fs.mkdtemp(path.join(root, '.install-'));
  const archive = path.join(stage, 'qwen.tar.gz');
  const binary = path.join(stage, 'qwen');

  try {
    await downloadArchive(archive, signal);
    await execute('/usr/bin/tar', ['-xzf', archive, '-C', stage, '--no-same-owner', '--', './qwen'], {
      timeout: 30000,
      signal,
    });
    await fs.chmod(binary, 0o555);

    const checked = await verifyQwenPreviewBinary(binary);

    await checked.descriptor.close();
    signal?.throwIfAborted();
    await fs.rename(binary, target);
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}
