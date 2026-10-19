import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2);

/**
 * Отдельный release gate выполняет все медленные SEA-тесты через memory guard.
 * Настоящая служба и GUI имеют отдельный явный E2E; отсутствие пакета — ошибка.
 */
async function main(): Promise<void> {
  if (args.length !== 2 || args[0] !== '--release-dir' || !args[1] || args[1].startsWith('--')) {
    throw new Error('Использование: npm --prefix server run test:sea -- --release-dir <комплект>');
  }

  const release = path.resolve(args[1]);
  const directory = 'tests/server/sea';

  if (!(await stat(release)).isDirectory()) {
    throw new Error('Ожидался каталог готового комплекта');
  }

  const tests = (await readdir(path.join(root, directory))).filter((file) => file.endsWith('.test.mts'))
    .sort().map((file) => `${directory}/${file}`);

  if (!tests.length) {
    throw new Error('Нет SEA acceptance tests');
  }

  const child = spawn('bash', ['tests/run-node-tests-safe.sh', '--test', '--test-concurrency=1',
    ...tests], {
    cwd: root,
    env: { ...process.env, GRIGDESK_SERVER_RELEASE_DIR: release },
    stdio: 'inherit',
  });

  child.once('error', (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
  child.once('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}

void main().catch((error: Error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
});
