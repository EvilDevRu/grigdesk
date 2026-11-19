import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { canonicalJson } from '../lib/canonicalJson.ts';
import {
  MAC_APP_ARCHIVE, MAC_APP_MAX_BYTES, MAC_APP_TREE, type ReleaseArtifact,
} from '../runtime/installedUpdateContracts.ts';
import { sha256, sha256File } from './hash.ts';
import { MAC_APP_DIRECTORY, MAC_APP_EXECUTABLE } from './bundleLayout.ts';
import { syncDirectory } from './files.ts';
import { isArm64MachOExecutable } from './machO.ts';
import { verifyMacZip } from './macosZip.ts';

const MAC_BUNDLE_ID = 'local.grigdesk.desktop';
const TREE_LIMIT = 4 * 1024 * 1024;
const APP_LIMIT = 10_000;
const execute = promisify(execFile);
export const MAC_ARCHIVE_OPTIONS = ['--norsrc', '--noextattr', '--noacl', '--noqtn'] as const;

type AppEntry =
  | { type: 'directory'; relativePath: string }
  | {
    type: 'link';
    relativePath: string;
    target: string;
  }
  | {
    type: 'file';
    relativePath: string;
    bytes: number;
    mode: number;
    sha256: string;
  };
interface AppTree {
  format: 1;
  entries: AppEntry[];
}

const safePart = (part: string) => part && part !== '.' && part !== '..'
  && !/[\x00-\x1f\x7f\\:]/u.test(part) && Buffer.byteLength(part) <= 255;
const fold = (name: string) => name.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
const regularMode = (mode: number) => [0o444, 0o555, 0o644, 0o755].includes(mode);
const exact = (value: object, keys: string[]) => Object.keys(value).sort().join(',') === keys.join(',');

/**
 * Ссылка разрешается по одной части пути, включая промежуточные ссылки.
 * Запрещены циклы, выход из корня, отсутствующие цели и коллизии имён.
 */
function resolveLink(entries: Map<string, AppEntry>, name: string, target: string): void {
  let remaining = target.split('/');
  const resolved = name.split('/').slice(0, -1);
  let links = 0;

  while (remaining.length) {
    const next = remaining.shift()!;

    if (next === '.') {
      continue;
    }

    if (next === '..') {
      if (resolved.length <= 1) {
        throw new Error('release_mac_app_link_escape');
      }

      resolved.pop();
      continue;
    }

    if (!safePart(next)) {
      throw new Error('release_mac_app_link_invalid');
    }

    const entry = entries.get([...resolved, next].join('/'));

    if (!entry || entry.type === 'file' && remaining.length) {
      throw new Error('release_mac_app_link_invalid');
    }

    if (entry.type === 'link') {
      if (++links > 40) {
        throw new Error('release_mac_app_link_cycle');
      }

      remaining = [...entry.target.split('/'), ...remaining];
    } else {
      resolved.push(next);
    }
  }
}

/**
 * У каждой записи ровно один тип и обычный родитель по точному имени.
 * Полный подписанный размер считается из файлов, включая исполняемый Mach-O.
 */
function validateTree(tree: AppTree): { entries: Map<string, AppEntry>; bytes: number } {
  if (!tree || !Array.isArray(tree.entries) || !exact(tree, ['entries', 'format'])
    || tree.format !== 1 || !tree.entries.length || tree.entries.length > APP_LIMIT) {
    throw new Error('release_mac_app_tree_invalid');
  }

  const entries = new Map<string, AppEntry>();
  const names = new Set<string>();
  let bytes = 0;
  let previous = '';

  for (const entry of tree.entries) {
    if (!entry || typeof entry.relativePath !== 'string') {
      throw new Error('release_mac_app_tree_invalid');
    }

    const name = entry.relativePath;
    const parts = name.split('/');
    const keys = Object.keys(entry).sort().join(',');

    if (name <= previous || parts[0] !== MAC_APP_DIRECTORY || parts.length > 64
      || Buffer.byteLength(name) > 4096 || parts.some((part) => !safePart(part))
      || names.has(fold(name))) {
      throw new Error('release_mac_app_path_invalid');
    }

    if (entry.type === 'directory' && keys === 'relativePath,type') {
      // Каталоги в описи закрепляют дерево и запрещают запись сквозь ссылку.
    } else if (entry.type === 'file' && keys === 'bytes,mode,relativePath,sha256,type'
      && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && regularMode(entry.mode)
      && typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(entry.sha256)) {
      bytes += entry.bytes;
    } else if (entry.type !== 'link' || keys !== 'relativePath,target,type'
      || typeof entry.target !== 'string' || !entry.target || entry.target.startsWith('/')
      || Buffer.byteLength(entry.target) > 1024 || entry.target.split('/').length > 64) {
      throw new Error('release_mac_app_tree_invalid');
    }

    if (parts.length > 1 && entries.get(path.posix.dirname(name))?.type !== 'directory') {
      throw new Error('release_mac_app_parent_invalid');
    }

    names.add(fold(name));
    entries.set(name, entry);
    previous = name;
  }

  const executable = entries.get(MAC_APP_EXECUTABLE);
  const plist = entries.get(MAC_APP_DIRECTORY + '/Contents/Info.plist');

  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAC_APP_MAX_BYTES
    || entries.get(MAC_APP_DIRECTORY)?.type !== 'directory'
    || executable?.type !== 'file' || !(executable.mode & 0o111) || plist?.type !== 'file') {
    throw new Error('release_mac_app_tree_invalid');
  }

  for (const entry of entries.values()) {
    if (entry.type === 'link') {
      resolveLink(entries, entry.relativePath, entry.target);
    }
  }

  return { entries, bytes };
}

/**
 * Обход читает сами ссылки и не следует им. Обычные файлы закреплены
 * размером, режимом и SHA. У результата один канонический порядок.
 */
async function scanTree(directory: string, durable = false): Promise<AppTree> {
  const pending = [MAC_APP_DIRECTORY];
  const directories: string[] = [];
  const entries: AppEntry[] = [];
  let bytes = 0;

  while (pending.length) {
    const relativePath = pending.pop()!;
    const absolute = path.join(directory, relativePath);
    const stat = await fs.lstat(absolute);
    const mode = stat.mode & 0o7777;

    if (entries.length + pending.length >= APP_LIMIT || stat.uid !== process.getuid!()) {
      throw new Error('release_mac_app_tree_invalid');
    }

    if (stat.isSymbolicLink()) {
      entries.push({
        type: 'link',
        relativePath,
        target: await fs.readlink(absolute),
      });
    } else if (stat.isDirectory() && !(mode & 0o7022)) {
      entries.push({ type: 'directory', relativePath });
      directories.push(absolute);

      const names = await fs.readdir(absolute);

      if (names.length + entries.length + pending.length > APP_LIMIT) {
        throw new Error('release_mac_app_tree_invalid');
      }

      pending.push(...names.map((name) => `${relativePath}/${name}`));
    } else if (stat.isFile() && stat.nlink === 1 && regularMode(mode)) {
      bytes += stat.size;

      if (bytes > MAC_APP_MAX_BYTES) {
        throw new Error('release_mac_app_tree_invalid');
      }

      entries.push({
        type: 'file',
        relativePath,
        bytes: stat.size,
        mode,
        sha256: await sha256File(absolute),
      });

      if (durable) {
        const handle = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);

        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
    } else {
      throw new Error('release_mac_app_entry_invalid');
    }
  }

  if (durable) {
    for (const absolute of directories.reverse()) {
      await syncDirectory(absolute);
    }
  }

  entries.sort((left, right) => left.relativePath < right.relativePath ? -1 : 1);

  return { format: 1, entries };
}

/**
 * До использования ditto имена и типы ZIP должны совпасть с signed tree.
 * Отдельно подтверждаются байты, включая относительные цели symlinks.
 */
export async function verifyMacDesktopZip(archive: string, tree: AppTree): Promise<void> {
  const { entries } = validateTree(tree);
  const visited = new Set<string>();

  await verifyMacZip(archive, (zip) => {
    const directory = zip.name.endsWith('/');
    const name = directory ? zip.name.slice(0, -1) : zip.name;
    const entry = entries.get(name);
    const kind = zip.mode & 0o170000;
    const mode = zip.mode & 0o7777;

    if (!entry || visited.has(name) || directory !== (entry.type === 'directory')) {
      throw new Error('release_mac_zip_path_invalid');
    }

    visited.add(name);

    if (entry.type === 'directory' && kind === 0o040000 && !(mode & 0o7022)) {
      return { size: 0 };
    }

    if (entry.type === 'link' && kind === 0o120000 && !(mode & 0o7000)) {
      return { size: Buffer.byteLength(entry.target), target: entry.target };
    }

    if (entry.type === 'file' && kind === 0o100000 && mode === entry.mode) {
      return { size: entry.bytes, sha256: entry.sha256 };
    }

    throw new Error('release_mac_zip_type_invalid');
  });

  if ([...entries.values()].some((entry) => entry.type !== 'directory'
    && !visited.has(entry.relativePath))) {
    throw new Error('release_mac_zip_entry_missing');
  }
}

/**
 * Опись вычисляется непосредственно из подписанного приложения до ZIP.
 * Возвращаемый объём будет частью подписанного внешнего артефакта.
 */
export async function buildMacDesktopTree(directory: string, destination: string) {
  const tree = await scanTree(directory);
  const { bytes } = validateTree(tree);
  const encoded = canonicalJson(tree) + '\n';

  if (Buffer.byteLength(encoded) > TREE_LIMIT) {
    throw new Error('release_mac_app_tree_invalid');
  }

  await fs.writeFile(destination, encoded, { flag: 'wx', mode: 0o444 });

  return { bytes, tree };
}

/**
 * Сборщик внешнего tar получает размер из уже сформированной описи.
 * Та же структура валидируется при подготовке и проверке поколения.
 */
export async function macDesktopTreeBytes(file: string): Promise<number> {
  const stat = await fs.lstat(file);

  if (!stat.isFile() || stat.size > TREE_LIMIT) {
    throw new Error('release_mac_app_tree_invalid');
  }

  return validateTree(JSON.parse(await fs.readFile(file, 'utf8')) as AppTree).bytes;
}

/**
 * Перед чтением производного дерева проверяет ровно два подписанных файла.
 * Размер из ZIP и size на диске не заменяют подписанный unpackedBundleBytes.
 */
async function readPackage(directory: string, artifact: ReleaseArtifact): Promise<AppTree> {
  if (artifact.files.length !== 2 || artifact.filesDigest !== sha256(canonicalJson(artifact.files))) {
    throw new Error('release_mac_desktop_inventory_invalid');
  }

  for (const name of [MAC_APP_ARCHIVE, MAC_APP_TREE]) {
    const expected = artifact.files.find((item) => item.path === name);
    const file = path.join(directory, name);
    const stat = await fs.lstat(file);
    const limit = name === MAC_APP_TREE ? TREE_LIMIT : MAC_APP_MAX_BYTES;

    if (!expected || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o444
      || expected.mode !== 0o444 || stat.size !== expected.size || stat.size > limit
      || await sha256File(file) !== expected.sha256) {
      throw new Error('release_mac_archive_integrity_invalid');
    }
  }

  const text = await fs.readFile(path.join(directory, MAC_APP_TREE), 'utf8');
  const tree = JSON.parse(text) as AppTree;
  const { bytes } = validateTree(tree);

  if (text !== canonicalJson(tree) + '\n' || bytes !== artifact.unpackedBundleBytes) {
    throw new Error('release_mac_app_tree_size_invalid');
  }

  return tree;
}

/**
 * После распаковки проверяет точные bytes дерева и штатную подпись кода.
 * Исполняемый файл обязан находиться физически по согласованному пути.
 */
async function verifyResult(directory: string, tree: AppTree, durable = false): Promise<string> {
  if (canonicalJson(await scanTree(directory, durable)) !== canonicalJson(tree)) {
    throw new Error('release_mac_app_tree_changed');
  }

  const binary = path.join(directory, MAC_APP_EXECUTABLE);
  const app = path.join(directory, MAC_APP_DIRECTORY);
  const handle = await fs.open(binary, constants.O_RDONLY | constants.O_NOFOLLOW);

  try {
    const header = Buffer.alloc(32);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);

    if (await fs.realpath(binary) !== binary || bytesRead !== header.length
      || !isArm64MachOExecutable(header)) {
      throw new Error('release_mac_app_binary_invalid');
    }
  } finally {
    await handle.close();
  }

  const options = { timeout: 60_000, maxBuffer: 64 * 1024 };
  const { stdout } = await execute('/usr/bin/plutil', [
    '-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(app, 'Contents/Info.plist'),
  ], options);

  if (stdout.trim() !== MAC_BUNDLE_ID) {
    throw new Error('release_mac_app_identifier_invalid');
  }

  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], options);

  return binary;
}

/**
 * Готовое поколение допускает только подписанную пару файлов и производную .app.
 * Общий verifier используется до apply, rollback и повторной установки.
 */
export async function verifyMacDesktop(directory: string, artifact: ReleaseArtifact): Promise<string> {
  const names = (await fs.readdir(directory)).sort();
  const expected = [MAC_APP_ARCHIVE, MAC_APP_TREE, MAC_APP_DIRECTORY].sort();

  if (names.join('\n') !== expected.join('\n')) {
    throw new Error('release_mac_desktop_inventory_invalid');
  }

  return verifyResult(directory, await readPackage(directory, artifact));
}

/**
 * Ditto получает проверенную копию в приватном пустом каталоге. До публикации
 * дерево проверяется ещё раз, а незавершённый запуск удаляет только свой staging.
 */
export async function materializeMacDesktop(
  directory: string, artifact: ReleaseArtifact,
): Promise<string> {
  const stat = await fs.lstat(directory);
  const names = (await fs.readdir(directory)).sort();

  if (!stat.isDirectory() || stat.uid !== process.getuid!() || stat.mode & 0o077
    || await fs.realpath(directory) !== directory
    || names.join('\n') !== [MAC_APP_TREE, MAC_APP_ARCHIVE].join('\n')) {
    throw new Error('release_mac_desktop_inventory_invalid');
  }

  const tree = await readPackage(directory, artifact);
  const work = await fs.mkdtemp(path.join(directory, '.app-'));

  try {
    const destination = path.join(work, 'unpacked');
    const archive = path.join(work, MAC_APP_ARCHIVE);
    const expected = artifact.files.find((file) => file.path === MAC_APP_ARCHIVE)!;

    await fs.copyFile(path.join(directory, MAC_APP_ARCHIVE), archive, constants.COPYFILE_EXCL);

    if (await sha256File(archive) !== expected.sha256) {
      throw new Error('release_mac_archive_integrity_invalid');
    }

    await verifyMacDesktopZip(archive, tree);
    await fs.mkdir(destination, { mode: 0o700 });
    await execute('/usr/bin/ditto', ['-x', '-k', ...MAC_ARCHIVE_OPTIONS, archive, destination], {
      timeout: 180_000,
      maxBuffer: 64 * 1024,
    });

    if ((await fs.readdir(destination)).join('\n') !== MAC_APP_DIRECTORY) {
      throw new Error('release_mac_zip_paths_changed');
    }

    await verifyResult(destination, tree, true);
    await fs.rename(path.join(destination, MAC_APP_DIRECTORY), path.join(directory, MAC_APP_DIRECTORY));
    await syncDirectory(directory);

    return path.join(directory, MAC_APP_EXECUTABLE);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}
