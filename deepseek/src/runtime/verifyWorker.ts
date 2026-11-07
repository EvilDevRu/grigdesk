import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { readWorkerArtifact } from './artifact.ts';

/**
 * Полная generation проверяется настоящим обычным worker Node с его фактическим ABI.
 * Наличие модельного plugin доказывается разрешением его файла без запуска модели.
 */
async function verify(): Promise<void> {
  const generation = path.join(process.argv[2]!, 'generation');
  const { artifact } = await readWorkerArtifact(generation, {
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    nativeAbi: process.versions.modules,
  });
  const requireRuntime = createRequire(path.join(generation, 'package.json'));

  await access(requireRuntime.resolve('@deepseek-ai/dsh-llm-pi-ai'));
  process.stdout.write(`${JSON.stringify({
    buildId: artifact.buildId,
    workerNode: {
      version: process.versions.node,
      abi: process.versions.modules,
    },
    glmPlugin: true,
  })}\n`);
}

await verify().catch(() => {
  process.stderr.write(`${JSON.stringify({
    code: 'deepseek_verify_failed',
    message: 'Не удалось проверить generation собственным Node',
  })}\n`);
  process.exitCode = 1;
});
