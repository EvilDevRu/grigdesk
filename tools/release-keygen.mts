import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Генерация пары ключей подписи релизов. Приватный ключ никогда не коммитится и не
 * печатается: наружу уходит только публичный PEM и подсказка о секрете CI.
 */
async function main(): Promise<void> {
  const directory = process.argv[2];

  if (!directory || process.argv.length !== 3 || !path.isAbsolute(directory)) {
    throw new Error('Использование: node tools/release-keygen.mts <абсолютный каталог>');
  }

  await fs.mkdir(directory, { recursive: true });

  const privatePath = path.join(directory, 'release-signing.pem');
  const exists = await fs.stat(privatePath).then(() => {
    return true;
  }, (error) =>
    {
    return (error.code === 'ENOENT' ? false : Promise.reject(error));
  });

  if (exists) {
    throw new Error(`Приватный ключ уже существует: ${privatePath}; перезапись запрещена`);
  }

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({
    type: 'pkcs8',
    format: 'pem'
  });
  const publicPem = publicKey.export({
    type: 'spki',
    format: 'pem'
  });

  await fs.writeFile(privatePath, privatePem, {
    mode: 0o600,
    flag: 'wx'
  });
  await fs.writeFile(path.join(directory, 'release-signing.pub.pem'), publicPem,
    {
      mode: 0o644,
      flag: 'wx'
    });
  await fs.chmod(privatePath, 0o600);
  await fs.chmod(path.join(directory, 'release-signing.pub.pem'), 0o644);
  process.stdout.write([
    'Пара ключей создана.',
    `Приватный (секрет CI RELEASE_SIGNING_KEY, содержимое файла): ${privatePath}`,
    'Публичный (впишите в RELEASE_SIGNING_PUBLIC_KEY shared/runtime/releaseChannelContracts.ts):',
    String(publicPem),
  ].join('\n'));
}

if (process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
