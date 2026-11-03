import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { build } from 'esbuild';

import { canonicalJson } from '../../../shared/lib/canonicalJson.ts';
import { sha256, sha256File } from '../../../shared/node/hash.ts';
import { readNodeRuntime } from '../../../shared/node/nodeRuntime.ts';
import { createServerManifest } from '../../src/binary/metadata.ts';
import { buildPayload } from './buildPayload.mts';
import { bundleLauncher } from './bundle.mts';
import { packagePayload } from './packagePayload.mts';
import { readBuildInputs } from './buildSteps.mts';

/**
 * Отдельный процесс каждой тяжёлой стадии даёт независимые log/exit и ограниченный RSS.
 * Только builder передаёт абсолютные собственные staging paths через закрытый build input.
 */
async function main(): Promise<void> {
  const stage = process.argv[2];
  const input = JSON.parse(await readFile(process.argv[3]!, 'utf8')) as {
    sourceRoot: string;
    work: string;
    cacheDir: string;
    archive: string;
    buildInputs: Record<string, string>;
  };
  const runtime = readNodeRuntime(JSON.parse(await readFile(
    path.join(input.sourceRoot, 'server/build/node-runtime.json'), 'utf8',
  )), 'server/build/node-runtime.json');

  if (stage === 'prepare') {
    const bootstrap = path.join(input.work, 'worker-bootstrap.cjs');
    const result = await build({
      absWorkingDir: input.sourceRoot,
      entryPoints: ['server/src/binary/workerBootstrap.ts'],
      outfile: bootstrap,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      logLevel: 'silent',
    });

    if (result.warnings.length > 0) {
      throw new Error(result.warnings.map((warning) => warning.text).join('\n'));
    }

    const directory = path.join(input.work, 'payload');

    await mkdir(directory, { mode: 0o700 });

    const report = await buildPayload({
      ...input,
      directory,
      runtime,
      bootstrap,
    });

    await writeFile(path.join(input.work, 'payload-report.json'), JSON.stringify(report));
  } else if (stage === 'bundle') {
    await bundleLauncher({ sourceRoot: input.sourceRoot, outfile: path.join(input.work, 'bundle.cjs') });
  } else if (stage === 'package') {
    const payload = await packagePayload({
      directory: path.join(input.work, 'payload'),
      outputFile: path.join(input.work, 'payload.zip'),
    });
    const buildInputs = await readBuildInputs(input.sourceRoot);

    if (canonicalJson(buildInputs) !== canonicalJson(input.buildInputs)) {
      throw new Error('Входные контракты сборки изменились во время подготовки payload');
    }

    const manifest = createServerManifest(payload, {
      version: (await readFile(path.join(input.sourceRoot, 'VERSION'), 'utf8')).trim(),
      launcherSha256: await sha256File(path.join(input.work, 'bundle.cjs')),
      engineSha256: sha256(canonicalJson(payload.entries.filter((entry) =>
        entry.path.startsWith('engine/') || entry.path.startsWith('schemas/analytics/')))),
      buildInputs,
    });

    await writeFile(path.join(input.work, 'prepared-manifest.json'), JSON.stringify(manifest));
    process.stdout.write(`${JSON.stringify({
      packageId: manifest.packageId,
      payloadSha256: payload.sha256,
      size: payload.size,
      entries: payload.entries.length,
    })}\n`);
  } else {
    throw new Error('Неизвестная стадия сборки серверного ELF');
  }
}

await main();
