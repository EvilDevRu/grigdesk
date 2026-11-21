import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
let binary;

/**
 * Пишет данные теста через Go store в выделенном каталоге.
 * Утилита собирается единожды на процесс и не попадает в поставку фабрики.
 */
export function writeFactoryLedger(root, operation, input) {
  if (!binary) {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'factory-ledger-tool-'));

    process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
    binary = path.join(directory, 'ledger-fixture');
    execFileSync('go', ['-C', 'utilities/factory', 'build', '-o', binary, './testdata/ledger-fixture'], {
      cwd: repo,
      env: {
        ...process.env,
        GOTOOLCHAIN: 'local',
        GOWORK: 'off',
      },
      timeout: 60_000,
    });
  }

  return JSON.parse(execFileSync(binary, [], {
    input: JSON.stringify({
      ...input,
      root,
      operation,
    }),
    encoding: 'utf8',
    timeout: 5000,
  }));
}
