import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const safeRunner = path.join(root, 'tests/run-node-tests-safe.sh');

/**
 * Перечисляет только *.test.mts непосредственно в каталоге набора.
 * Отсутствующий каталог означает пустой набор, а не ошибку чтения.
 */
async function testFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return [];
    }

    throw error;
  });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mts'))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

/**
 * Запускает быстрый или SEA-набор b24 только через сторож памяти репозитория.
 * Неизвестные аргументы и пустой набор дают код 2 без запуска тестов.
 */
export async function runTests(argv: readonly string[]): Promise<number> {
  const sea = argv.length === 1 && argv[0] === '--sea';

  if (argv.length > 1 || (argv.length === 1 && !sea)) {
    process.stderr.write('Использование: node scripts/test.mts [--sea]\n');

    return 2;
  }

  const directory = path.join(root, sea ? 'tests/b24/sea' : 'tests/b24');
  const files = await testFiles(directory);

  if (files.length === 0) {
    process.stderr.write(`Не найдено тестов b24 в ${directory}.\n`);

    return 2;
  }

  const child = spawn('bash', [safeRunner, '--test', `--test-concurrency=${sea ? 1 : 2}`, ...files], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_TEST_MAX_RSS_MB: '4096',
    },
  });

  return await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      resolve(code ?? 1);
    });
  });
}

void runTests(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}, (error: unknown) => {
  process.stderr.write(`Не удалось запустить тесты b24: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
