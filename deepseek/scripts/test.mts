import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPackageTests } from '../../shared/node/packageTests.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const sea = args.length === 1 && args[0] === '--sea';

if (args.length > 1 || args.length === 1 && !sea) {
  process.stderr.write('Использование: node scripts/test.mts [--sea]\n');
  process.exitCode = 2;
} else {
  await runPackageTests({
    root,
    runner: path.join(root, 'tests/run-node-tests-safe.sh'),
    directory: path.join(root, sea ? 'tests/deepseek/sea' : 'tests/deepseek'),
    sea,
  }).then((code) => {
    process.exitCode = code;
  }, (error: unknown) => {
    process.stderr.write(`Не удалось запустить тесты DeepSeek: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
