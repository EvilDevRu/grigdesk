import { writeFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import { localStack } from '../../tests/mobile/helpers/local-stack.js';
import { makeCert } from '../../tests/relay/helpers.js';

const directory = process.argv[2];

if (!directory || !path.isAbsolute(directory)) {
  throw new Error('Тест требует собственный временный каталог');
}

const cleanup: Array<() => Promise<void> | void> = [];
const scope = { after: (callback: () => Promise<void> | void) => cleanup.unshift(callback) };
const execute = promisify(execFile);

await mkdir(directory, {
  recursive: true,
  mode: 0o700,
});

const stack = await localStack(scope);
const service = stack.service!;
const certificate = await makeCert(directory, 'jvm-device');

await execute('openssl', [
  'pkcs12',
  '-export',
  '-inkey',
  path.join(directory, 'jvm-device-key.pem'),
  '-in',
  path.join(directory, 'jvm-device-cert.pem'),
  '-out',
  path.join(directory, 'device.p12'),
  '-passout',
  'pass:test-only',
]);
await writeFile(path.join(directory, 'fixture.json'), JSON.stringify({ qr: stack.qr }), {
  mode: 0o600,
});

const input = createInterface({ input: process.stdin });

/**
 * JVM управляет только своим синтетическим сервером через stdin, без открытого admin HTTP.
 * В stdout идут короткие статусы, секреты стенда находятся только в его private файлах.
 */
async function command(value: string) {
  if (value === 'release') {
    await stack.waitForRuns(1);
    stack.runs[0].release('Ответ через настоящий Java TLS');
    await stack.core.mobileChat.reconcile('integration-chat');
  } else if (value === 'revoke') {
    const device = (await service.devices.list()).find(
      (item: { fp: string }) => item.fp === certificate.fp,
    );

    if (!device) {
      throw new Error('Тестовый телефон ещё не привязан');
    }

    await service.revokeDevice(device.id);
  } else if (value === 'close') {
    input.close();

    for (const close of cleanup) {
      await close();
    }

    process.stdout.write('closed\n');

    return;
  } else {
    throw new Error('Неизвестная команда стенда');
  }

  process.stdout.write('done\n');
}

let work = Promise.resolve();

input.on('line', (line) => {
  work = work
    .then(() => command(line))
    .catch(() => {
      process.stdout.write('failed\n');
    });
});
process.stdout.write('ready\n');
