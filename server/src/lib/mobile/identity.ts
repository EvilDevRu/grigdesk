import { execFile } from 'node:child_process';
import { createHash, createPrivateKey, randomBytes, X509Certificate } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { MobileInputError } from './errors.ts';
import { privateWrite, serialized } from './files.ts';

const execute = promisify(execFile);

/**
 * Пин вычисляется по полному X.509-сертификату, одинаково для QR и TLS-проверки.
 * Единая запись в нижнем регистре без двоеточий исключает неоднозначное сравнение.
 */
export function fingerprintOf(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256.replaceAll(':', '').toLowerCase();
}

/**
 * Выпускает отдельную P-256 личность в приватном временном каталоге.
 * Ключ не проходит через аргументы командной строки и журнал процесса.
 */
async function generate(directory: string, cn: string) {
  await fs.mkdir(directory, {
    recursive: true,
    mode: 0o700,
  });
  await fs.chmod(directory, 0o700);

  const temporary = await fs.mkdtemp(path.join(directory, '.identity-'));

  try {
    await execute(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-days',
        '3650',
        '-subj',
        `/CN=${cn}`,
        '-keyout',
        path.join(temporary, 'key.pem'),
        '-out',
        path.join(temporary, 'cert.pem'),
      ],
      { timeout: 15000 },
    );

    const keyPem = await fs.readFile(path.join(temporary, 'key.pem'), 'utf8');
    const certPem = await fs.readFile(path.join(temporary, 'cert.pem'), 'utf8');

    return {
      keyPem,
      certPem,
      privateKey: createPrivateKey(keyPem),
      fp: fingerprintOf(certPem),
    };
  } catch {
    throw new MobileInputError(
      'mobile_identity_error',
      'Не удалось выпустить сертификат мобильного доступа.',
      503,
    );
  } finally {
    await fs.rm(temporary, {
      recursive: true,
      force: true,
    });
  }
}

/**
 * Читает существующую пару, различая отсутствие и неполное/повреждённое состояние.
 * Неисправная личность не заменяется новой, иначе телефоны потеряют доверенный пин.
 */
async function readIdentity(keyFile: string, certFile: string) {
  const values = await Promise.all(
    [keyFile, certFile].map(async (file) => {
      try {
        return await fs.readFile(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return null;
        }

        throw new MobileInputError(
          'mobile_identity_error',
          'Не удалось прочитать личность мобильного доступа.',
          503,
        );
      }
    }),
  );
  const [keyPem, certPem] = values;

  if (keyPem === null && certPem === null) {
    return null;
  }

  try {
    if (!keyPem || !certPem) {
      throw new Error('partial');
    }

    const privateKey = createPrivateKey(keyPem);

    if (!new X509Certificate(certPem).checkPrivateKey(privateKey)) {
      throw new Error('mismatch');
    }

    return {
      keyPem,
      certPem,
      privateKey,
      fp: fingerprintOf(certPem),
    };
  } catch {
    throw new MobileInputError(
      'mobile_identity_error',
      'Личность мобильного доступа повреждена.',
      503,
    );
  }
}

/**
 * Создаёт личность мозга один раз и сериализует конкурентные старты.
 * Полузаписанная пара требует восстановления человеком, а не смены отпечатка.
 */
export function ensureBrainIdentity(directory: string) {
  return serialized(path.join(directory, 'brain-identity'), async () => {
    const keyFile = path.join(directory, 'brain-key.pem');
    const certFile = path.join(directory, 'brain-cert.pem');
    const existing = await readIdentity(keyFile, certFile);

    if (existing) {
      return existing;
    }

    const identity = await generate(directory, 'grigdesk-brain');

    await privateWrite(keyFile, identity.keyPem);
    await privateWrite(certFile, identity.certPem);

    return identity;
  });
}

/**
 * Выпускает сертификат и независимые токены ролей для нового посредника.
 * Идентификатор проверяется до использования как имени приватного каталога.
 */
export async function createRelayCredentials(directory: string, id: string) {
  if (!/^r[a-f0-9]{8,32}$/.test(id)) {
    throw new MobileInputError('bad_relay_id', 'Неверный идентификатор посредника.');
  }

  const folder = path.join(directory, 'relays', id);
  const identity = await generate(folder, 'grigdesk-relay');

  await privateWrite(path.join(folder, 'relay-key.pem'), identity.keyPem);
  await privateWrite(path.join(folder, 'relay-cert.pem'), identity.certPem);

  return {
    ...identity,
    brainToken: randomBytes(32).toString('base64url'),
    deviceToken: randomBytes(32).toString('base64url'),
  };
}

/**
 * Формирует конфигурацию Docker только с хэшами токенов ролей.
 * Сам текст содержит приватный TLS-ключ и выдаётся только защищённой админ-ручкой.
 */
export function renderRelayEnv(credentials: {
  keyPem: string;
  certPem: string;
  brainToken: string;
  deviceToken: string;
}): string {
  const hash = (token: string) => createHash('sha256').update(token).digest('hex');

  return [
    `RELAY_TLS_KEY_B64=${Buffer.from(credentials.keyPem).toString('base64')}`,
    `RELAY_TLS_CERT_B64=${Buffer.from(credentials.certPem).toString('base64')}`,
    `RELAY_BRAIN_TOKEN_SHA256=${hash(credentials.brainToken)}`,
    `RELAY_DEVICE_TOKEN_SHA256=${hash(credentials.deviceToken)}`,
    '',
  ].join('\n');
}
