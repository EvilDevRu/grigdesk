import { fileURLToPath, pathToFileURL } from 'node:url';

import { superviseProcess, watchdogFromEnv } from './supervision.ts';

/**
 * Сохраняет исходный запуск и публичный адаптер контейнерного сторожа.
 * Пути исходников вычисляются только здесь и не попадают в SEA bundle.
 */
export function supervise(options: {
  childFile?: string;
  watchdogMs?: number;
} = {}): Promise<number> {
  return superviseProcess({
    command: process.execPath,
    args: [options.childFile ?? fileURLToPath(new URL('./main.ts', import.meta.url))],
    watchdogMs: options.watchdogMs ?? watchdogFromEnv(process.env),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await supervise();
}
