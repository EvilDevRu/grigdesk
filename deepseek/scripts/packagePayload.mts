import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { createHash } from 'node:crypto';

import { Zip, ZipDeflate } from 'fflate';

import { sha256File } from '../../shared/node/hash.ts';
import { readOnlyFileMode } from '../../shared/node/files.ts';
import { contractDecoders } from '../../shared/lib/contractDecoders.ts';
import { readWorkerArtifact } from '../src/runtime/artifact.ts';
import type { DeepSeekWorkerRuntime } from '../src/runtime/artifact.ts';
import type { PayloadDescriptor, PayloadEntry } from '../src/runtime/payloadIndex.ts';
import { decodePayloadIndex, invalidPayload } from '../src/runtime/payloadIndex.ts';

export interface PackagePayloadOptions {
  generationDirectory: string;
  workerNode: string;
  nodeLicense: string;
  workerBootstrap: string;
  workerVerify: string;
  worker: DeepSeekWorkerRuntime;
  outputFile: string;
}

type SourceEntry = PayloadEntry & { source: string };

const decode = contractDecoders(invalidPayload);
const licenseInventory = decode.objectOf({
  format: decode.oneOf(1),
  packages: decode.listOf(decode.objectOf({
    files: decode.listOf(decode.objectOf({ copy: decode.text, sha256: decode.text })),
  })),
});

/**
 * Полный inventory и все скопированные notices обязательны даже при целой generation.
 * Отсутствующая лицензия не восстанавливается из сети и не пропускается молча.
 */
async function assertLicenses(root: string): Promise<void> {
  try {
    for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'licenses/UPSTREAM_NOTICES.md']) {
      if ((await readFile(path.join(root, name))).length === 0) {
        invalidPayload();
      }
    }

    const index = licenseInventory(JSON.parse(await readFile(
      path.join(root, 'licenses/index.json'), 'utf8',
    )), 'licenses');

    if (index.packages.length === 0) {
      invalidPayload();
    }

    for (const record of index.packages) {
      if (record.files.length === 0) {
        invalidPayload();
      }

      for (const file of record.files) {
        if (!file.copy || file.copy === '.' || file.copy === '..' || /[/\\\0]/u.test(file.copy)
          || !/^[a-f0-9]{64}$/u.test(file.sha256)
          || await sha256File(path.join(root, 'licenses', file.copy)) !== file.sha256) {
          invalidPayload();
        }
      }
    }
  } catch {
    invalidPayload();
  }
}

/**
 * Источники обходятся в стабильном порядке без следования symlink.
 * В публичный индекс попадают только относительные имена, modes и хеши байтов.
 */
async function inventory(source: string, name: string): Promise<SourceEntry[]> {
  const stat = await lstat(source);
  const mode = stat.isFile() ? readOnlyFileMode(stat.mode) : stat.isDirectory() ? 0o700 : stat.mode & 0o777;

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

      for await (const chunk of createReadStream(entry.source)) {
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
 * Архив поставки включает только проверенную generation и явные ресурсы worker.
 * Его индекс не должен хранить адреса исходной сборки.
 */
export async function packagePayload(options: PackagePayloadOptions): Promise<PayloadDescriptor> {
  await readWorkerArtifact(options.generationDirectory, options.worker);
  await assertLicenses(options.generationDirectory);

  for (const file of [
    options.workerNode, options.nodeLicense, options.workerBootstrap, options.workerVerify,
  ]) {
    if (!(await lstat(file)).isFile() || (await lstat(file)).size === 0) {
      invalidPayload();
    }
  }

  const entries = [
    ...await inventory(options.generationDirectory, 'generation'),
    ...await inventory(options.workerNode, 'node'),
    ...await inventory(options.nodeLicense, 'NODE-LICENSE'),
    ...await inventory(options.workerBootstrap, 'worker-bootstrap.mjs'),
    ...await inventory(options.workerVerify, 'worker-verify.mjs'),
  ].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

  decodePayloadIndex(entries);
  await writeArchive(entries, options.outputFile);

  return {
    entries: entries.map(({ source: _source, ...entry }) => entry),
    sha256: await sha256File(options.outputFile),
    size: (await lstat(options.outputFile)).size,
  };
}
