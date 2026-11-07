import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Быстрый и SEA-наборы пакетов перечисляют только непосредственные *.test.mts.
 * Общий запуск всегда проходит через переданный сторож памяти репозитория.
 */
export async function runPackageTests(options: {
  root: string;
  runner: string;
  directory: string;
  sea: boolean;
}): Promise<number> {
  const entries = await readdir(options.directory, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.test.mts'))
    .map((entry) => path.join(options.directory, entry.name)).sort();

  if (files.length === 0) {
    process.stderr.write(`Не найдено тестов в ${options.directory}.\n`);

    return 2;
  }

  const child = spawn('bash', [options.runner, '--test',
    `--test-concurrency=${options.sea ? 1 : 2}`, ...files], {
    cwd: options.root,
    stdio: 'inherit',
    env: { ...process.env, NODE_TEST_MAX_RSS_MB: '4096' },
  });

  return await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
}
