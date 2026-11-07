import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPackageTests } from '../../shared/node/packageTests.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const safeRunner = path.join(root, 'tests/run-node-tests-safe.sh');

/**
 * Запускает быстрый или SEA-набор tracker только через сторож памяти репозитория.
 * Неизвестные аргументы и пустой набор дают код 2 без запуска тестов.
 */
export async function runTests(argv: readonly string[]): Promise<number> {
  const sea = argv.length === 1 && argv[0] === '--sea';

  if (argv.length > 1 || (argv.length === 1 && !sea)) {
    process.stderr.write('Использование: node scripts/test.mts [--sea]\n');

    return 2;
  }

  const directory = path.join(root, sea ? 'tests/tracker/sea' : 'tests/tracker');

  return runPackageTests({
    root,
    runner: safeRunner,
    directory,
    sea,
  });
}

void runTests(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}, (error: unknown) => {
  process.stderr.write(`Не удалось запустить тесты tracker: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
