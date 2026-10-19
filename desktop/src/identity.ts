import { constants } from 'node:fs';
import { chmod, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { createPrivateKey, randomBytes, X509Certificate } from 'node:crypto';
import path from 'node:path';

import type { DeviceIdentity, IdentityStore } from '../../shared/desktop/deviceIdentity.ts';
import { selfSignedCertificate } from './selfSignedCert.ts';

export type SafeStorageLike = {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(text: string): Buffer;
  decryptString(data: Buffer): string;
};

export type Sealer = {
  available(): boolean;
  seal(text: string): Buffer;
  open(data: Buffer): string;
};

const BACKENDS = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);
const KEY = 'device-key.sealed';
const CERT = 'device-cert.pem';
const LIMIT = 16_384;

/**
 * Linux допускает только backend, который хранит секрет через системную связку ключей.
 * Windows использует DPAPI; отсутствие метода выбора backend там допустимо.
 */
export function electronSealer(storage: SafeStorageLike, platform: NodeJS.Platform): Sealer {
  return {
    /**
     * Ошибка системного сервиса означает недоступность защищённого backend.
     * Она не включает резервное открытое хранение ключа.
     */
    available() {
      try {
        return storage.isEncryptionAvailable() &&
          (platform !== 'linux' || BACKENDS.has(storage.getSelectedStorageBackend?.() ?? ''));
      } catch {
        return false;
      }
    },
    seal: (text) => storage.encryptString(text),
    open: (data) => storage.decryptString(data),
  };
}

/**
 * Лимит действует на чтение дескриптора, поэтому рост файла не увеличивает буфер.
 * POSIX запрещает symlink; на Windows флаг отсутствует и не защищает reparse points.
 */
async function boundedFile(file: string): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));

  try {
    if (!(await handle.stat()).isFile()) {
      throw new Error('store_corrupt');
    }

    const buffer = Buffer.alloc(LIMIT + 1);
    let offset = 0;

    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);

      if (!bytesRead) {
        break;
      }

      offset += bytesRead;
    }

    if (offset > LIMIT) {
      throw new Error('store_corrupt');
    }

    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

/**
 * Каждая часть публикуется после fsync через уникальный временный файл с O_EXCL.
 * Авария между двумя rename оставляет неполную пару, которую create не заменяет.
 */
async function writeAtomic(file: string, data: Buffer | string): Promise<void> {
  const temporary = file + '.' + randomBytes(12).toString('hex') + '.tmp';

  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);

    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Личность никогда не перегенерируется при повреждении или потере подтверждения pair.
 * На диск попадает только зашифрованный ключ; чтение сверяет его с сертификатом.
 */
export function sealedIdentity(sealer: Sealer): IdentityStore {
  const requireStorage = () => {
    if (!sealer.available()) {
      throw new Error('secure_store_unavailable');
    }
  };

  /**
   * Читает обе части и сверяет сертификат с расшифрованным закрытым ключом.
   * Любое повреждение возвращает одну причину без внутренних файловых путей.
   */
  const load = async (directory: string): Promise<DeviceIdentity> => {
    requireStorage();

    try {
      const sealed = await boundedFile(path.join(directory, KEY));
      const cert = (await boundedFile(path.join(directory, CERT))).toString('utf8');
      const key = sealer.open(sealed);
      const certificate = new X509Certificate(cert);

      if (!certificate.checkPrivateKey(createPrivateKey(key))) {
        throw new Error('store_corrupt');
      }

      return { key, cert };
    } catch {
      throw new Error('store_corrupt');
    }
  };

  return {
    load,
    /**
     * Готовая пара переиспользуется даже без link.json после потери ACK.
     * Неполная запись требует явного сброса, существующий ключ не перетирается.
     */
    async create(directory, name) {
      requireStorage();

      try {
        const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') {
            return [];
          }

          throw new Error('store_corrupt');
        });
        const identityEntries = entries.filter((entry) => entry.startsWith('device-'));

        if (entries.some((entry) => ![KEY, CERT, 'link.json', 'paired.json', 'outbox.json',
          'media', 'updates'].includes(entry))) {
          throw new Error('store_corrupt');
        }

        if (identityEntries.length) {
          if (identityEntries.length !== 2 || !identityEntries.includes(KEY) ||
            !identityEntries.includes(CERT)) {
            throw new Error('store_corrupt');
          }

          return load(directory);
        }

        if (entries.length) {
          throw new Error('store_corrupt');
        }

        const pair = selfSignedCertificate(name);
        const sealed = sealer.seal(pair.key);

        await mkdir(directory, { recursive: true, mode: 0o700 });
        await chmod(directory, 0o700);
        await writeAtomic(path.join(directory, KEY), sealed);
        await writeAtomic(path.join(directory, CERT), pair.cert);

        return pair;
      } catch (error) {
        if (error instanceof Error && error.message === 'secure_store_unavailable') {
          throw error;
        }

        throw new Error('store_corrupt');
      }
    },
  };
}
