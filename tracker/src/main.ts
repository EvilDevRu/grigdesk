import os from 'node:os';
import { getAsset, isSea } from 'node:sea';

import { readTextOrNull } from '../../shared/node/files.ts';

import manifest from '../package.json' with { type: 'json' };
import { runB24 } from './app.ts';
import { request } from './http.ts';

const SOURCE_LICENSE = 'Исходный запуск использует лицензию установленного Node.js. '
  + 'Полная лицензия включена в tracker SEA.\n';

/**
 * Читает stdin до EOF без декодирования: create передаёт байты серверу как есть.
 * Вызывается только командой create.
 */
async function readStdin(): Promise<Uint8Array> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * Пишет значение в поток и ждёт callback записи.
 * Ошибка потока отклоняет Promise вместо необработанного события.
 */
function writeTo(stream: NodeJS.WriteStream, value: string | Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(value, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Связывает app с процессом: argv, окружение, файлы, stdin, сеть и потоки вывода.
 * Ошибки событий потоков гасятся здесь, их учитывает callback записи.
 */
async function main(): Promise<void> {
  process.stdout.on('error', () => undefined);
  process.stderr.on('error', () => undefined);
  process.exitCode = await runB24(process.argv.slice(2), {
    version: manifest.version,
    license: () => isSea() ? getAsset('NODE-LICENSE', 'utf8') : SOURCE_LICENSE,
  }, {
    env: process.env,
    getHome: () => os.homedir(),
    readText: readTextOrNull,
    request,
    readStdin,
    writeStdout: (value) => writeTo(process.stdout, value),
    writeStderr: (value) => writeTo(process.stderr, value),
  });
}

void main().catch(() => {
  process.exitCode = 1;
});
