import { getAsset, isSea } from 'node:sea';

import manifest from '../package.json' with { type: 'json' };
import { runB24 } from './app.ts';
import { createProcessIO } from './processIO.ts';

const SOURCE_LICENSE = 'Исходный запуск использует лицензию установленного Node.js. '
  + 'Полная лицензия включена в tracker SEA.\n';

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
  }, createProcessIO());
}

void main().catch(() => {
  process.exitCode = 1;
});
