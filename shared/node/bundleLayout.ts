import { constants, realpathSync, lstatSync, openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
import path from 'node:path';

import type { ReleaseChannel } from '../runtime/productReleaseVersion.ts';

export const bundleMarker = 'bin/bundle.json';

/**
 * Marker отличает переносимый комплект от исходников и прежней поставки R.
 * Само чтение не готовит сервер и не меняет пользовательские настройки.
 */
export function isPortableBundle(root: string): boolean {
  try {
    const marker = JSON.parse(readFileSync(path.join(root, bundleMarker), 'utf8'));

    return marker.format === 1 && marker.kind === 'portable';
  } catch {
    return false;
  }
}

export interface InstallationReceipt {
  format: 1;
  installationId: string;
  uid: number;
  root: string;
  mode: 'local' | 'remote' | 'server';
  channel: ReleaseChannel;
  dataHome: string;
  userData: string;
}

/**
 * Receipt привязывает управление к физической папке и пользователю установки.
 * Папки данных и профиля обязаны находиться за пределами заменяемой программы.
 */
export function decodeInstallationReceipt(value: InstallationReceipt, root: string): InstallationReceipt {
  const keys = 'channel,dataHome,format,installationId,mode,root,uid,userData';

  if (!value || Object.keys(value).sort().join(',') !== keys || value.format !== 1
    || value.uid !== process.getuid!() || value.root !== root
    || !/^[a-f0-9-]{36}$/u.test(value.installationId)
    || !['local', 'remote', 'server'].includes(value.mode)
    || !['release', 'dev'].includes(value.channel)
    || [value.dataHome, value.userData].some((directory) => typeof directory !== 'string'
      || !path.isAbsolute(directory) || path.resolve(directory) !== directory
      || directory === root || directory.startsWith(root + path.sep))) {
    throw new Error('installation_receipt_invalid');
  }

  return value;
}

/**
 * Сервер вычисляет I до загрузки config, когда асинхронного bootstrap ещё нет.
 * Синхронный reader проверяет физический root и приватный fd теми же ограничениями.
 */
export function readInstallationSync(root: string): InstallationReceipt {
  const directory = lstatSync(root);

  if (!path.isAbsolute(root) || root === '/' || realpathSync(root) !== root
    || !directory.isDirectory() || directory.uid !== process.getuid!() || directory.mode & 0o022) {
    throw new Error('installation_root_invalid');
  }

  const descriptor = openSync(path.join(root, 'installation.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

  try {
    const stat = fstatSync(descriptor);

    if (!stat.isFile() || stat.uid !== process.getuid!() || stat.mode & 0o077 || stat.size > 1024 * 1024) {
      throw new Error('installation_state_invalid');
    }

    return decodeInstallationReceipt(JSON.parse(readFileSync(descriptor, 'utf8')), root);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Физический путь допускает только известные компоненты поколения, без обхода каталогов.
 * Это распознавание раскладки, а доверие к root устанавливает приватный receipt.
 */
export function installationCandidate(physical: string): string | null {
  const parts = physical.split(path.sep);
  const index = parts.lastIndexOf('generations');

  const version = parts[index + 1] ?? '';
  const product = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-dev\.(0|[1-9][0-9]*))?$/u;
  const numbers = version.split(/[.-]/u).filter((part) => part !== 'dev');

  if (index < 1 || !product.test(version) || numbers.some((part) => !Number.isSafeInteger(Number(part)))
    || !['desktop', 'server'].includes(parts[index + 2] ?? '')) {
    return null;
  }

  const component = parts[index + 2];
  const suffix = parts.slice(index + 3).join('/');

  if (component === 'desktop' ? suffix !== 'GrigDesk' : suffix !== 'bin/grigdesk-server') {
    return null;
  }

  return parts.slice(0, index).join(path.sep);
}

/**
 * Boot resolver выводит registered root из физического компонента до чтения серверного config.
 * Переменные окружения не добавляют прав на управление произвольной установкой.
 */
export function installationForExecutableSync(executable: string): InstallationReceipt | null {
  const root = installationCandidate(realpathSync(executable));

  return root ? readInstallationSync(root) : null;
}
