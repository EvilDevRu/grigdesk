import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readdir, readlink, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { finished } from 'node:stream/promises';

import { Zip, ZipDeflate } from 'fflate';

import { canonicalJson } from '../../../shared/lib/canonicalJson.ts';
import { readOnlyFileMode, syncDirectory } from '../../../shared/node/files.ts';
import { sha256File } from '../../../shared/node/hash.ts';
import { decodePayloadIndex, type PayloadDescriptor, type PayloadEntry } from '../../src/binary/payload.ts';

type SourceEntry = PayloadEntry & { source: string };

/**
 * Источники обходятся в стабильном порядке без следования symlink.
 * В публичный индекс попадают только относительные имена, modes и хеши байтов.
 */
async function inventory(source: string, name: string): Promise<SourceEntry[]> {
  const stat = await lstat(source);
  const mode = stat.isFile() ? readOnlyFileMode(stat.mode) : stat.isDirectory() ? 0o700 : stat.mode & 0o777;

  if (!stat.isSymbolicLink() && (stat.mode & 0o777) !== mode) {
    throw new Error('Права входа payload изменились или не зафиксированы до индекса');
  }

  if (stat.isFile()) {
    return [{
      path: name,
      type: 'file',
      mode,
      source,
      size: stat.size,
      sha256: await sha256File(source),
    }];
  }

  if (stat.isSymbolicLink()) {
    return [{
      path: name,
      type: 'link',
      mode,
      source,
      target: await readlink(source),
    }];
  }

  if (!stat.isDirectory()) {
    throw new Error('Специальный файл в payload запрещён');
  }

  const entries: SourceEntry[] = [{
    path: name,
    type: 'dir',
    mode,
    source,
  }];

  for (const child of (await readdir(source)).sort()) {
    entries.push(...await inventory(path.join(source, child), `${name}/${child}`));
  }

  return entries;
}

/**
 * ZIP сжимается частями с ограниченным выходным буфером и фиксированной датой.
 * Повторное чтение сверяет hash: смена source между индексом и архивом не публикуется.
 */
async function writeArchive(entries: SourceEntry[], target: string): Promise<void> {
  const output = createWriteStream(target, { mode: 0o600 });
  const completion = finished(output);
  let buffered = false;
  const zip = new Zip((error, bytes, final) => {
    if (error) {
      output.destroy(error);

      return;
    }

    buffered = !output.write(bytes) || buffered;

    if (final) {
      output.end();
    }
  });

  void completion.catch(() => {});

  try {
    for (const entry of entries) {
      if (entry.type !== 'file') {
        continue;
      }

      const stream = new ZipDeflate(entry.path, { level: 6 });
      const hash = createHash('sha256');
      let size = 0;

      stream.mtime = new Date(1980, 0, 1);
      zip.add(stream);

      for await (const chunk of createReadStream(entry.source, { highWaterMark: 65536 })) {
        hash.update(chunk);
        size += chunk.length;
        stream.push(chunk, false);

        if (buffered) {
          await once(output, 'drain');
          buffered = false;
        }
      }

      if (size !== entry.size || hash.digest('hex') !== entry.sha256) {
        throw new Error('Вход payload изменился во время упаковки');
      }

      stream.push(new Uint8Array(), true);

      if (buffered) {
        await once(output, 'drain');
        buffered = false;
      }
    }

    zip.end();
    await completion;
  } catch (error) {
    output.destroy();
    await completion.catch(() => {});

    throw error;
  }
}

/**
 * Корень stage не становится записью индекса; все children имеют относительные пути.
 * Ссылки и родительские каталоги проверяет полный общий decoder до архивирования.
 */
async function stageInventory(directory: string): Promise<SourceEntry[]> {
  const entries: SourceEntry[] = [];

  for (const name of (await readdir(directory)).sort()) {
    entries.push(...await inventory(path.join(directory, name), name));
  }

  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  decodePayloadIndex(entries);

  return entries;
}

/**
 * ZIP публикуется атомарно лишь после повторной проверки исходных байтов и modes.
 * Ошибка записи или mutation оставляет прежний output и удаляет только собственный temp.
 */
export async function packagePayload(options: {
  directory: string;
  outputFile: string;
  afterInventory?: () => Promise<void>;
}): Promise<PayloadDescriptor> {
  const entries = await stageInventory(options.directory);
  const index = entries.map(({ source: _source, ...entry }) => entry);
  const temporary = `${options.outputFile}.${randomUUID()}.tmp`;

  await mkdir(path.dirname(options.outputFile), { recursive: true });

  try {
    await options.afterInventory?.();
    await writeArchive(entries, temporary);

    const after = (await stageInventory(options.directory)).map(({ source: _source, ...entry }) => entry);

    if (canonicalJson(index) !== canonicalJson(after)) {
      throw new Error('Вход payload изменился во время упаковки');
    }

    const descriptor: PayloadDescriptor = {
      entries: index,
      sha256: await sha256File(temporary),
      size: (await lstat(temporary)).size,
    };
    const handle = await open(temporary, 'r+');

    try {
      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(temporary, options.outputFile);
    await syncDirectory(path.dirname(options.outputFile));

    return descriptor;
  } finally {
    await rm(temporary, { force: true });
  }
}
