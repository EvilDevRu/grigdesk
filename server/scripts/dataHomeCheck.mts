// Проверка запускалок не создаёт данных и не запускает приложение.
import * as fs from 'node:fs';
import os from 'node:os';
import { checkDataHome } from '../src/lib/dataHomeBoot.ts';
import { runtimeInstallationRoot } from '../src/lib/runtimePaths.ts';

const args = process.argv.slice(2);

try {
  if (args.length && (args.length !== 2 || args[0] !== '--code-root')) {
    throw new Error('Допустим только --code-root <путь>.');
  }

  const codeRoot = args[1] || runtimeInstallationRoot();

  checkDataHome({
    codeRoot,
    home: os.homedir(),
    env: process.env
  }, fs);
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 78;
}
