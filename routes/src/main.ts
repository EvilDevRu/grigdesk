import { getAsset, isSea } from 'node:sea';

import manifest from '../package.json' with { type: 'json' };
import { runRoutes } from './app.ts';

/**
 * Локальные сведения о CLI доступны без токена, файлов профиля и HTTP.
 * Рабочие команды используют прежний авторинг API и его коды завершения.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 1 && args[0] === '--version') {
    const runtime = `Node ${process.version}, ${process.platform} ${process.arch}`;

    console.log(`routes ${manifest.version} (${runtime})`);

    return;
  }

  if (args.length === 1 && args[0] === '--license') {
    process.stdout.write(isSea()
      ? getAsset('NODE-LICENSE', 'utf8')
      : 'Исходный запуск использует лицензию установленного Node.js.\n');

    return;
  }

  await runRoutes();
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 5;
});
