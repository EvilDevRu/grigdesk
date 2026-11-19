import { constants, realpathSync, lstatSync, openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
import { createPublicKey } from 'node:crypto';
import path from 'node:path';

import type { ReleaseChannel } from '../runtime/productReleaseVersion.ts';
import {
  RELEASE_DISTRIBUTION_SOURCE, RELEASE_SIGNING_PUBLIC_KEY, type ReleaseDistributionSource,
} from '../runtime/releaseChannelContracts.ts';
import { sha256 } from './hash.ts';

export const bundleMarker = 'bin/bundle.json';
export const MAC_APP_DIRECTORY = 'grigdesk.app';
export const MAC_APP_EXECUTABLE = 'grigdesk.app/Contents/MacOS/grigdesk';

/**
 * Внутренний путь executable зависит от платформы окна.
 * Серверный файл использует одну раскладку во всех установках.
 */
export function installedExecutableSuffix(
  component: 'desktop' | 'server', platform: NodeJS.Platform = process.platform,
): string {
  return component === 'server' ? 'bin/grigdesk-server'
    : platform === 'darwin' ? MAC_APP_EXECUTABLE : 'GrigDesk';
}

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

interface InstallationReceiptFields {
  installationId: string;
  uid: number;
  root: string;
  mode: 'local' | 'remote' | 'server';
  channel: ReleaseChannel;
  dataHome: string;
  userData: string;
}

type InstallationTrust = { format: 1 } | {
  format: 2;
  source: Exclude<ReleaseDistributionSource, 'channel'>;
  trustKeySha256: string;
};

export type InstallationReceipt = InstallationReceiptFields & InstallationTrust;

/**
 * Хеш вычисляется из нормализованного SPKI PEM. Иной тип ключа
 * отклоняется, даже если Node умеет импортировать его как public key.
 */
export function installedReleaseKeyFingerprint(publicKeyPem = RELEASE_SIGNING_PUBLIC_KEY): string {
  const key = createPublicKey(publicKeyPem);

  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('installation_release_trust_mismatch');
  }

  return sha256(String(key.export({ type: 'spki', format: 'pem' })));
}

/**
 * Источник доставки закрепляется в собранном приложении. У сетевого
 * выпуска сохраняется форма v1, у двух offline источников — форма v2.
 */
export function installationTrustFields(
  source: ReleaseDistributionSource = RELEASE_DISTRIBUTION_SOURCE, publicKeyPem?: string,
): InstallationTrust {
  if (source === 'channel') {
    return { format: 1 };
  }

  return {
    format: 2,
    source,
    trustKeySha256: installedReleaseKeyFingerprint(publicKeyPem),
  };
}

/**
 * При смене канала, подготовке или применении нельзя перейти на другое
 * происхождение пакета или на ключ другой сборки.
 */
export function assertInstallationReleaseTrust(
  receipt: InstallationReceipt, publicKeyPem?: string,
): void {
  const expected = installationTrustFields(RELEASE_DISTRIBUTION_SOURCE, publicKeyPem);

  if (expected.format !== receipt.format || expected.format === 2 && receipt.format === 2
      && (expected.source !== receipt.source || expected.trustKeySha256 !== receipt.trustKeySha256)) {
    throw new Error('installation_release_trust_mismatch');
  }
}

/**
 * Receipt привязывает управление к физической папке и пользователю установки.
 * Папки данных и профиля обязаны находиться за пределами заменяемой программы.
 */
export function decodeInstallationReceipt(value: InstallationReceipt, root: string): InstallationReceipt {
  const keys = value?.format === 2
    ? 'channel,dataHome,format,installationId,mode,root,source,trustKeySha256,uid,userData'
    : 'channel,dataHome,format,installationId,mode,root,uid,userData';

  if (!value || Object.keys(value).sort().join(',') !== keys
    || (value.format !== 1 && value.format !== 2)
    || value.format === 2 && (!['candidate-file', 'local-test'].includes(value.source)
      || !/^[a-f0-9]{64}$/u.test(value.trustKeySha256))
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
export function installationCandidate(physical: string, platform = process.platform): string | null {
  const parts = physical.split(path.sep);
  const index = parts.lastIndexOf('generations');

  const version = parts[index + 1] ?? '';
  const product = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-dev\.(0|[1-9][0-9]*))?$/u;
  const numbers = version.split(/[.-]/u).filter((part) => part !== 'dev');

  const component = parts[index + 2];

  if (index < 1 || !product.test(version) || numbers.some((part) => !Number.isSafeInteger(Number(part)))
    || component !== 'desktop' && component !== 'server') {
    return null;
  }

  const suffix = parts.slice(index + 3).join('/');

  if (suffix !== installedExecutableSuffix(component, platform)) {
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
