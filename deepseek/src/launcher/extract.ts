import fs, { constants, type BigIntStats } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { sha256File } from '../../../shared/node/hash.ts';
import { acquireDirectoryLock, type DirectoryLockOptions } from '../../../shared/node/directoryLock.ts';
import { consumePayloadArchive, decodePayloadDescriptor, invalidPayload } from '../runtime/payloadIndex.ts';
import type { PayloadDescriptor, PayloadEntry, PayloadSink } from '../runtime/payloadIndex.ts';
import { dataHome, dataPath, type DataHomeInput } from '../../../shared/runtime/dataHome.ts';

export interface ExtractionOptions {
  cacheDir: string;
  packageId: string;
  payload: PayloadDescriptor;
  archive: () => AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  fileSystem?: {
    write?(fd: number, bytes: Uint8Array): number;
    hashFile?(file: string): Promise<string>;
  };
  fullVerify?: boolean;
  lockOptions?: DirectoryLockOptions;
}

function absoluteCache(value: string): string {
  if (!path.isAbsolute(value) || value === '/') {
    throw Object.assign(new Error('Кэш DeepSeek требует абсолютный путь'), {
      code: 'deepseek_cache_invalid',
    });
  }

  return value;
}

/**
 * Явный cache-dir имеет приоритет без fallback на cwd, DSH_HOME или родительский HOME.
 * Умолчание вычисляется только по запросу режима распаковки из общей папки данных.
 */
export function resolveExtractionCache(explicit: string | undefined, input: DataHomeInput): string {
  return absoluteCache(explicit ?? dataPath(dataHome(input), 'deepseekRuntime'));
}

/**
 * Только приватный обычный каталог текущего пользователя может владеть cache и staging.
 * Symlink вместо cache не получает побочных файлов и не исправляется изменением прав.
 */
async function privateDirectory(directory: string): Promise<void> {
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });

  const stat = await fsp.lstat(directory);

  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0
    || (process.getuid && stat.uid !== process.getuid())) {
    throw Object.assign(new Error('Кэш DeepSeek должен быть приватным каталогом владельца'), {
      code: 'deepseek_cache_invalid',
    });
  }
}

/**
 * Файл создаётся эксклюзивно без следования ссылке, а запись учитывает короткий write.
 * Оригинальный mode применяется только после получения всех проверенных байтов.
 */
function openSink(
  directory: string,
  entry: PayloadEntry & { type: 'file' },
  write: (fd: number, bytes: Uint8Array) => number,
): PayloadSink {
  const file = path.join(directory, entry.path);
  const fd = fs.openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    | constants.O_NOFOLLOW, 0o600);
  let closed = false;

  return {
    /**
     * Короткая запись продолжается с оставшихся байтов, нулевой write даёт отказ.
     * FS seam позволяет проверить ENOSPC без настоящего заполнения диска.
     */
    write(bytes) {
      let offset = 0;

      while (offset < bytes.length) {
        const written = write(fd, bytes.subarray(offset));

        if (written === 0) {
          throw Object.assign(new Error('Не удалось записать payload'), { code: 'EIO' });
        }

        offset += written;
      }
    },
    close() {
      fs.fchmodSync(fd, entry.mode);
      fs.closeSync(fd);
      closed = true;
    },
    abort() {
      if (!closed) {
        fs.closeSync(fd);
        closed = true;
      }
    },
  };
}

/**
 * Приватный staging получает файлы раньше ссылок, поэтому ZIP не пишет сквозь link.
 * Каталоги сначала доступны владельцу для записи, затем получают исходные modes.
 */
async function extractInto(directory: string, options: ExtractionOptions): Promise<void> {
  const directories = options.payload.entries.filter((entry) => entry.type === 'dir')
    .sort((left, right) => left.path.split('/').length - right.path.split('/').length);

  for (const entry of directories) {
    await fsp.mkdir(path.join(directory, entry.path), { mode: 0o700 });
  }

  const write = options.fileSystem?.write ?? fs.writeSync;

  await consumePayloadArchive(options.archive(), options.payload, (entry) => (
    openSink(directory, entry, write)
  ));

  for (const entry of options.payload.entries) {
    if (entry.type === 'link') {
      await fsp.symlink(entry.target, path.join(directory, entry.path));
    }
  }

  for (const entry of directories.reverse()) {
    await fsp.chmod(path.join(directory, entry.path), entry.mode);
  }
}

const statFields = ['ino', 'size', 'mode', 'mtimeNs', 'ctimeNs'] as const;

interface ReadySnapshot {
  root: string[];
  entries: string[][];
}

/**
 * BigInt значения сохраняются decimal strings без потери наносекунд и inode.
 * Порядок полей фиксирован в marker, записи идут в порядке защищённого payload index.
 */
function fingerprint(stat: BigIntStats): string[] {
  return statFields.map((field) => stat[field].toString());
}

/**
 * Полный состав обходится без следования ссылкам, каждый путь получает bigint lstat.
 * Проверка target/containment ссылок нужна полному пути; быстрый сверяет их inode/ctime.
 */
function inspectTree(directory: string, payload: PayloadDescriptor, links: boolean): ReadySnapshot {
  const root = fs.lstatSync(directory, { bigint: true });

  if (!root.isDirectory() || (root.mode & 0o077n) !== 0n
    || process.getuid && root.uid !== BigInt(process.getuid())) {
    invalidPayload();
  }

  const expected = new Map(payload.entries.map((entry, index) => [entry.path, { entry, index }]));
  const entries: string[][] = new Array(payload.entries.length);
  let count = 0;

  /**
   * Неизвестный путь, иной type/mode/size и пропуск записи запрещают reuse.
   * Синхронный lstat не создаёт десятки тысяч promises на критическом пути startup.
   */
  function visit(relative: string): void {
    for (const name of fs.readdirSync(path.join(directory, relative))) {
      const item = relative ? `${relative}/${name}` : name;

      if (item === '.ready.json') {
        continue;
      }

      const selected = expected.get(item);
      const file = path.join(directory, item);
      const stat = fs.lstatSync(file, { bigint: true });

      if (!selected || (stat.mode & 0o777n) !== BigInt(selected.entry.mode)) {
        invalidPayload();
      }

      const { entry, index } = selected;

      entries[index] = fingerprint(stat);
      count += 1;

      if (entry.type === 'file' && stat.isFile() && stat.size === BigInt(entry.size)) {
        continue;
      }

      if (entry.type === 'dir' && stat.isDirectory()) {
        visit(item);
      } else if (entry.type === 'link' && stat.isSymbolicLink()) {
        if (links) {
          const resolved = path.relative(directory, fs.realpathSync(file));

          if (fs.readlinkSync(file) !== entry.target || resolved === '..'
            || resolved.startsWith('../') || path.isAbsolute(resolved)) {
            invalidPayload();
          }
        }
      } else {
        invalidPayload();
      }
    }
  }

  visit('');

  if (count !== expected.size) {
    invalidPayload();
  }

  return { root: fingerprint(root), entries };
}

/**
 * Любое изменение kernel fingerprint или состава требует полной проверки.
 * Значения marker не исполняются и сравниваются с каждой фактической записью.
 */
function sameSnapshot(value: ReadySnapshot, actual: ReadySnapshot): boolean {
  const same = (left: unknown, right: string[]) => Array.isArray(left)
    && left.length === statFields.length && right.every((field, index) => field === left[index]);

  return same(value.root, actual.root) && Array.isArray(value.entries)
    && value.entries.length === actual.entries.length
    && actual.entries.every((entry, index) => same(value.entries[index], entry));
}

/**
 * Полный путь проверяет hashes, targets и modes независимо от marker snapshots.
 * Повторный lstat после чтения не позволяет записать snapshot изменившегося при hash файла.
 */
async function fullSnapshot(directory: string, options: ExtractionOptions): Promise<ReadySnapshot> {
  const snapshot = inspectTree(directory, options.payload, true);
  const files = options.payload.entries.filter((entry) => entry.type === 'file');
  const hash = options.fileSystem?.hashFile ?? sha256File;

  for (let start = 0; start < files.length; start += 16) {
    await Promise.all(files.slice(start, start + 16).map(async (entry) => {
      if (await hash(path.join(directory, entry.path)) !== entry.sha256) {
        invalidPayload();
      }
    }));
  }

  if (!sameSnapshot(snapshot, inspectTree(directory, options.payload, true))) {
    invalidPayload();
  }

  return snapshot;
}

/**
 * Marker обновляется под package lock через существующий inode без создания directory entry.
 * Это сохраняет root mtime/ctime; O_NOFOLLOW запрещает запись сквозь подменённый marker-link.
 */
async function writeReady(
  directory: string,
  options: ExtractionOptions,
  snapshot: ReadySnapshot,
): Promise<void> {
  const handle = await fsp.open(path.join(directory, '.ready.json'),
    constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);

  try {
    await handle.writeFile(JSON.stringify({
      format: 2,
      packageId: options.packageId,
      payloadSha256: options.payload.sha256,
      statFields,
      ...snapshot,
    }));
  } finally {
    await handle.close();
  }
}

/**
 * Marker допускает быстрый путь только после проверки identity, состава и всех lstat.
 * Явный verify и любое расхождение снова читают все bytes и обновляют snapshot после успеха.
 */
async function verifyMaterialized(directory: string, options: ExtractionOptions): Promise<void> {
  try {
    const markerPath = path.join(directory, '.ready.json');
    const stat = await fsp.lstat(markerPath);

    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
      invalidPayload();
    }

    const marker = JSON.parse(await fsp.readFile(markerPath, 'utf8'));

    if (marker.format !== 2 || marker.packageId !== options.packageId
      || marker.payloadSha256 !== options.payload.sha256
      || JSON.stringify(marker.statFields) !== JSON.stringify(statFields)) {
      invalidPayload();
    }

    if (!options.fullVerify) {
      let actual: ReadySnapshot | undefined;

      try {
        actual = inspectTree(directory, options.payload, false);
      } catch {
        // Любое расхождение направляется в полный путь; повреждение не восстанавливается вслепую.
      }

      if (actual && sameSnapshot(marker, actual)) {
        return;
      }
    }

    await writeReady(directory, options, await fullSnapshot(directory, options));
  } catch {
    invalidPayload();
  }
}

/**
 * Приватная поставка публикуется одним rename после завершения архива.
 * Общий кэш не должен показывать другим процессам половину распаковки.
 */
export async function materializePayload(options: ExtractionOptions): Promise<string> {
  absoluteCache(options.cacheDir);

  if (!/^[a-f0-9]{64}$/u.test(options.packageId)) {
    invalidPayload();
  }

  const payload = decodePayloadDescriptor(options.payload);

  if (payload.entries.some((entry) => entry.path === '.ready.json'
    || entry.type === 'file' && ![0o444, 0o555].includes(entry.mode)
    || entry.type === 'dir' && ![0o700, 0o500].includes(entry.mode))) {
    invalidPayload();
  }

  const packages = path.join(options.cacheDir, 'packages');
  const target = path.join(packages, options.packageId);

  await privateDirectory(options.cacheDir);
  await privateDirectory(packages);

  const lockRoot = path.join(options.cacheDir, '.locks');

  await privateDirectory(lockRoot);

  const lock = await acquireDirectoryLock(path.join(lockRoot, options.packageId), options.lockOptions);

  try {
    for (const name of await fsp.readdir(packages)) {
      if (name.startsWith(`.${options.packageId}.staging-`)) {
        await fsp.rm(path.join(packages, name), { recursive: true, force: true });
      }
    }

    const existing = await fsp.lstat(target).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }

      return null;
    });

    if (existing) {
      await verifyMaterialized(target, { ...options, payload });

      return target;
    }

    const staging = await fsp.mkdtemp(path.join(packages, `.${options.packageId}.staging-`));

    try {
      await extractInto(staging, { ...options, payload });
      await fsp.writeFile(path.join(staging, '.ready.json'), '', { flag: 'wx', mode: 0o600 });

      const selected = { ...options, payload };
      const snapshot = await fullSnapshot(staging, selected);

      await writeReady(staging, selected, snapshot);
      await fsp.rename(staging, target);
      snapshot.root = fingerprint(await fsp.lstat(target, { bigint: true }));
      await writeReady(target, selected, snapshot);

      return target;
    } finally {
      await fsp.rm(staging, { recursive: true, force: true });
    }
  } finally {
    await lock.release();
  }
}
