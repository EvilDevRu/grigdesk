import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { deepSeekTestArtifactsRoot, testDeepSeekBinarySelection } from './deepseekBinary.mts';

const execute = promisify(execFile);
let selection: ReturnType<typeof testDeepSeekBinarySelection> | undefined;

/**
 * Проверяет исходный host-plugin на настоящем compiled registry закреплённого Harness.
 * Приватный scratch разделяет только неизменные зависимости candidate и удаляется целиком.
 */
export async function runToolPermissionRegistry(scenario: string): Promise<string> {
  selection ??= testDeepSeekBinarySelection();

  const candidate = await selection;
  const directory = await fs.mkdtemp(path.join(deepSeekTestArtifactsRoot(), 'tool-registry-'));
  const repository = path.resolve(import.meta.dirname, '../..');

  try {
    await fs.symlink(path.join(candidate.generation, 'node_modules'), path.join(directory, 'node_modules'));

    for (const file of ['toolPermissionGate.mjs', 'toolPermissionPolicy.mjs', 'toolPermissionPaths.mjs']) {
      await fs.copyFile(path.join(repository, 'deepseek/src/host', file), path.join(directory, file));
    }

    await fs.copyFile(path.join(repository, 'tests/fixtures/deepseek-harness/toolPermissionRegistry.mjs'),
      path.join(directory, 'probe.mjs'));

    const result = await execute(candidate.worker, [
      path.join(directory, 'probe.mjs'), candidate.generation, scenario,
    ], {
      cwd: directory,
      timeout: 15_000,
      maxBuffer: 128 * 1024,
    });

    return result.stdout;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
