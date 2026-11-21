import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
let binary = process.env.FACTORY_TEST_BINARY;

/**
 * Тесты используют свежую Go-сборку из одноразового каталога.
 * Общий прогон может заранее передать один абсолютный бинарник для всех файлов.
 */
export function testFactoryBinary() {
  if (binary) {
    return path.resolve(binary);
  }

  const directory = mkdtempSync(path.join(os.tmpdir(), 'grigdesk-test-factory-'));

  process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
  execFileSync('bash', [path.join(repo, 'tools/build-factory.sh'), directory], {
    cwd: repo,
    timeout: 60_000,
  });
  binary = path.join(directory, 'factory');

  return binary;
}
