import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createGunzip } from 'node:zlib';

import type { ReleaseArtifact } from '../runtime/installedUpdateContracts.ts';
import { sha256File } from './hash.ts';
import { syncDirectory } from './files.ts';

/**
 * Загрузка ограничена подписанным размером, HTTPS и общим таймаутом.
 * Частичный файл остаётся только в собственном staging и никогда не исполняется.
 */
export async function downloadReleaseArtifact(input: {
  artifact: ReleaseArtifact;
  destination: string;
  fetcher?: typeof fetch;
  progress(bytes: number): Promise<void>;
}): Promise<void> {
  const response = await (input.fetcher ?? fetch)(input.artifact.url, {
    redirect: 'error',
    signal: AbortSignal.timeout(10 * 60_000),
  });

  if (!response.ok || !response.body) {
    await response.body?.cancel();

    throw new Error('release_download_failed');
  }

  const reader = response.body.getReader();
  const output = await fs.open(input.destination, 'wx', 0o600);
  let size = 0;

  try {
    for (;;) {
      const chunk = await reader.read();

      if (chunk.done) {
        break;
      }

      size += chunk.value.length;

      if (size > input.artifact.size) {
        throw new Error('release_download_size_invalid');
      }

      await output.writeFile(chunk.value);
      await input.progress(size);
    }

    await output.sync();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    await output.close();
  }

  if (size !== input.artifact.size || await sha256File(input.destination) !== input.artifact.sha256) {
    throw new Error('release_download_integrity_invalid');
  }
}

function tarText(header: Buffer, offset: number, size: number): string {
  return header.subarray(offset, offset + size).toString('utf8').replace(/\0.*$/su, '');
}

/**
 * Ustar читается последовательно без внешнего tar и без неограниченной распаковки.
 * Принимаются только подписанные ordinary files; links, pax и специальные записи запрещены.
 */
export async function extractReleaseArtifact(
  archive: string,
  destination: string,
  artifact: ReleaseArtifact,
): Promise<void> {
  if (await sha256File(archive) !== artifact.sha256 || (await fs.stat(archive)).size !== artifact.size) {
    throw new Error('release_download_integrity_invalid');
  }

  await fs.mkdir(destination, { mode: 0o700 });

  const expected = new Map(artifact.files.map((entry) => [entry.path, entry]));
  const source = createReadStream(archive);
  const unpack = source.pipe(createGunzip());

  source.on('error', (error) => unpack.destroy(error));

  let pending = Buffer.alloc(0);
  let total = 0;
  let remaining = 0;
  let padding = 0;
  let endBlocks = 0;
  let current: (typeof artifact.files)[number] | null = null;
  let output: Awaited<ReturnType<typeof fs.open>> | null = null;
  let digest = createHash('sha256');

  try {
    for await (const chunk of unpack) {
      total += chunk.length;

      if (total > artifact.unpackedSize + artifact.files.length * 2048 + 10240) {
        throw new Error('release_archive_limit');
      }

      pending = Buffer.concat([pending, chunk]);

      for (;;) {
        if (output && remaining === 0 && current) {
          if (digest.digest('hex') !== current.sha256) {
            throw new Error('release_file_integrity_invalid');
          }

          await output.chmod(current.mode & 0o111 ? 0o555 : 0o444);
          await output.sync();
          await output.close();
          output = null;
          expected.delete(current.path);
          current = null;
        }

        if (remaining > 0) {
          const length = Math.min(remaining, pending.length);

          if (!length) {
            break;
          }

          const part = pending.subarray(0, length);

          digest.update(part);
          await output!.writeFile(part);
          remaining -= length;
          pending = pending.subarray(length);

          continue;
        }

        if (padding) {
          const length = Math.min(padding, pending.length);

          padding -= length;
          pending = pending.subarray(length);

          if (padding) {
            break;
          }
        }

        if (pending.length < 512) {
          break;
        }

        const header = pending.subarray(0, 512);

        pending = pending.subarray(512);

        if (header.every((byte) => byte === 0)) {
          endBlocks += 1;

          continue;
        }

        const checksum = Number.parseInt(tarText(header, 148, 8).trim(), 8);
        const computed = header.reduce((sum, byte, index) =>
          sum + (index >= 148 && index < 156 ? 32 : byte), 0);
        const prefix = tarText(header, 345, 155);
        const name = (prefix ? prefix + '/' : '') + tarText(header, 0, 100);
        const type = header[156];
        const sizeText = tarText(header, 124, 12).trim();
        const size = /^[0-7]+$/u.test(sizeText) ? Number.parseInt(sizeText, 8) : NaN;

        if (endBlocks || checksum !== computed || !Number.isSafeInteger(size)
          || (type !== 0 && type !== 48) || !expected.has(name)) {
          throw new Error('release_archive_entry_invalid');
        }

        current = expected.get(name)!;

        if (size !== current.size) {
          throw new Error('release_archive_size_invalid');
        }

        const target = path.join(destination, name);

        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        output = await fs.open(target, 'wx', 0o600);
        remaining = size;
        padding = (512 - size % 512) % 512;
        digest = createHash('sha256');
      }
    }

    if (output || remaining || padding || pending.some((byte) => byte !== 0)
      || endBlocks < 2 || expected.size) {
      throw new Error('release_archive_incomplete');
    }

    await syncDirectory(destination);
  } finally {
    await output?.close();
    source.destroy();
    unpack.destroy();
  }
}
