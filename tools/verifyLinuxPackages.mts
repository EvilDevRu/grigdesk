import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import { withWorkDirectory } from '../shared/node/files.ts';
import { sha256File } from '../shared/node/hash.ts';
import { offlinePackageFiles } from './linuxOfflinePackage.mts';
import { OFFLINE_DEB_BOOTSTRAP, DEB_DESKTOP_ENTRY } from './buildDeb.mts';

const execute = promisify(execFile);
const toolOptions = { timeout: 180_000, maxBuffer: 1024 * 1024 };
const debDirectories = [
  '.',
  'usr',
  'usr/bin',
  'usr/lib',
  'usr/lib/grigdesk',
  'usr/share',
  'usr/share/applications',
];

const debScripts = new Set(['usr/bin/grigdesk', 'usr/lib/grigdesk/grigdesk-install']);
const invalidDebInventory = 'offline_deb_inventory_invalid';


export interface PublicReleaseFile {
  name: string;
  size: number;
  sha256: string;
}

/**
 * Сверяет плоский инвентарь до чтения членов ZIP и после распаковки deb.
 * Точные имена исключают скрытые, повторные и дополнительные вложения.
 */
function assertFileList(actual: string[], expected: string[], failure: string) {
  if (JSON.stringify(actual.sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(failure);
  }
}

/**
 * Публичный файл должен быть обычным и проходить лимит загрузки GitHub.
 * Хеш считается потоком, чтобы размер комплекта не определял память процесса.
 */
export async function publicReleaseFile(directory: string, name: string): Promise<PublicReleaseFile> {
  const file = path.join(directory, name);
  const stat = await fs.lstat(file);

  if (!stat.isFile() || stat.size <= 0 || stat.size >= 2 * 1024 ** 3) {
    throw new Error(`public_release_file_invalid: ${name}`);
  }

  return {
    name,
    size: stat.size,
    sha256: await sha256File(file),
  };
}

/**
 * Сравнивает локальный набор с проверенными файлами build artifact.
 * Каждый попавший в пакет архив нужен установщику в исходном виде.
 */
async function comparePackage(directory: string, expected: PublicReleaseFile[]) {
  for (const file of expected) {
    const local = await publicReleaseFile(directory, file.name);

    if (local.sha256 !== file.sha256 || local.size !== file.size) {
      throw new Error(`offline_package_bytes_mismatch: ${file.name}`);
    }
  }
}

/**
 * До извлечения читает ограниченный список записей tar и проверяет оба процесса.
 * Размер содержимого пакета не определяет объём памяти проверки.
 */
async function debTarListing(deb: string, flag: '--ctrl-tarfile' | '--fsys-tarfile') {
  const dpkg = spawn('dpkg-deb', [flag, deb], {
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: toolOptions.timeout,
  });
  const tar = execute('tar', [
    '-tvf', '-', '--numeric-owner', '--full-time',
    '--quoting-style=escape', '--block-number', '--ignore-zeros',
  ], {
    ...toolOptions,
    env: { ...process.env, LC_ALL: 'C' },
  });
  const [source, sink, transfer] = await Promise.allSettled([
    once(dpkg, 'close'),
    tar,
    pipeline(dpkg.stdout!, tar.child.stdin!),
  ]);

  if (source.status !== 'fulfilled' || source.value[0] !== 0
    || sink.status !== 'fulfilled' || sink.value.stderr || transfer.status !== 'fulfilled') {
    throw new Error(invalidDebInventory);
  }

  return sink.value.stdout.trimEnd().split('\n');
}

/**
 * Отвергает повторы, ссылки, изменение владельца и скрытые расширения tar.
 * Разрыв номеров блоков означает, что tar пропустил служебную запись.
 */
function assertDebTarEntries(list: string[], directories: string[], files: string[]) {
  const expected = new Map(directories.map((name) => [name === '.' ? './' : `./${name}/`, 'drwxr-xr-x']));

  for (const name of files) {
    expected.set(`./${name}`, debScripts.has(name) ? 'script' : '-rw-r--r--');
  }

  const entryCount = expected.size;
  let block = 0;

  for (const line of list.slice(0, entryCount)) {
    const header = /^block (\d+): ([d-][rwxstST-]{9}) 0\/0 +([0-9]+) \S+ \S+ ([./a-zA-Z0-9_-]+)$/u;
    const match = header.exec(line);
    const mode = match?.[2];
    const name = match?.[4];
    const required = name && expected.get(name);
    const size = Number(match?.[3]);

    if (!name || !required || Number(match?.[1]) !== block || !Number.isSafeInteger(size)
      || (required === 'script' ? !mode?.startsWith('-') : required !== mode)
      || (mode?.startsWith('d') && size !== 0)) {
      throw new Error(invalidDebInventory);
    }

    expected.delete(name);
    block += 1 + Math.ceil(size / 512);
  }

  const padding = list.slice(entryCount, -1);

  if (expected.size || padding.length < 2
    || padding.some((line, index) => line !== `block ${block + index}: ** Block of NULs **`)
    || list.at(-1) !== `block ${block + padding.length}: ** End of File **`) {
    throw new Error(invalidDebInventory);
  }
}

/**
 * Читает точную плоскую опись ZIP и сверяет распакованные bytes с проверенной поставкой.
 * Временная распаковка не требует запуска программы.
 */
export async function verifyOfflineZip(zipPath: string, expected: PublicReleaseFile[]): Promise<void> {
  const directory = path.dirname(zipPath);
  const listing = await execute('unzip', ['-Z1', zipPath], toolOptions);

  assertFileList(listing.stdout.trimEnd().split('\n'), expected.map((file) => file.name),
    'offline_zip_inventory_invalid');

  await withWorkDirectory(directory, async (work) => {
    await execute('unzip', ['-q', zipPath, '-d', work], toolOptions);
    await comparePackage(work, expected);
  });
}

/**
 * Проверяет оба офлайн-пакета стабильного Linux x64.
 * Извлечённые каталоги используются во временной проверке и не запускаются.
 */
export async function verifyLinuxPackages(directory: string,
  version: string): Promise<PublicReleaseFile[]> {
  const files = offlinePackageFiles('release');
  const expected = await Promise.all(files.map((name) => publicReleaseFile(directory, name)));
  const debName = `grigdesk_${version}_amd64.deb`;
  const deb = await publicReleaseFile(directory, debName);
  const debPath = path.join(directory, debName);

  assertDebTarEntries(await debTarListing(debPath, '--ctrl-tarfile'), ['.'], ['control']);
  assertDebTarEntries(await debTarListing(debPath, '--fsys-tarfile'), debDirectories, [
    ...files.map((name) => `usr/lib/grigdesk/${name}`),
    'usr/bin/grigdesk',
    'usr/share/applications/grigdesk.desktop',
  ]);

  await withWorkDirectory(directory, async (work) => {
    await execute('dpkg-deb', ['--raw-extract', debPath, work], toolOptions);
    assertFileList(await fs.readdir(work), ['DEBIAN', 'usr'], 'offline_deb_inventory_invalid');

    for (const [entry, contents] of [
      ['DEBIAN', ['control']],
      ['usr', ['bin', 'lib', 'share']],
      ['usr/bin', ['grigdesk']],
      ['usr/lib', ['grigdesk']],
      ['usr/lib/grigdesk', files],
      ['usr/share', ['applications']],
      ['usr/share/applications', ['grigdesk.desktop']],
    ] as const) {
      const target = path.join(work, entry);

      if (!(await fs.lstat(target)).isDirectory()) {
        throw new Error('offline_deb_inventory_invalid');
      }

      assertFileList(await fs.readdir(target), [...contents], 'offline_deb_inventory_invalid');
    }

    for (const [file, text, mode] of [
      ['usr/bin/grigdesk', OFFLINE_DEB_BOOTSTRAP, 0o755],
      ['usr/share/applications/grigdesk.desktop', DEB_DESKTOP_ENTRY, 0o644],
    ] as const) {
      const entry = path.join(work, file);
      const stat = await fs.lstat(entry);

      if (!stat.isFile() || (stat.mode & 0o7777) !== mode
        || await fs.readFile(entry, 'utf8') !== text) {
        throw new Error('offline_deb_entry_invalid');
      }
    }

    const local = path.join(work, 'usr/lib/grigdesk');
    const installer = await fs.lstat(path.join(local, 'grigdesk-install'));

    if (!installer.isFile() || (installer.mode & 0o7777) !== 0o755) {
      throw new Error('offline_deb_entry_invalid');
    }

    assertFileList(await fs.readdir(local), files, 'offline_deb_inventory_invalid');
    await comparePackage(local, expected);
  });

  const zipName = `grigdesk-${version}-linux-x64-offline.zip`;
  const zip = await publicReleaseFile(directory, zipName);
  const zipPath = path.join(directory, zipName);

  await verifyOfflineZip(zipPath, expected);

  return [expected[0]!, zip, deb];
}
