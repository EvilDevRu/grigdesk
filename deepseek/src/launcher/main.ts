import os from 'node:os';
import path from 'node:path';
import { getRawAsset } from 'node:sea';

import { decodeDeepSeekRuntimeInfo } from '../../../shared/chat/deepSeekBinary.ts';
import { sha256 } from '../../../shared/node/hash.ts';
import { launcherFailure, parseLauncherArgs } from './args.ts';
import { materializePayload, resolveExtractionCache } from './extract.ts';
import { runLauncherWorker } from './worker.ts';

/**
 * Assets защищаются полным packageId, а metadata-команды не вычисляют HOME и cache.
 * Runtime-info возвращает публичный контракт без многомегабайтного внутреннего индекса.
 */
async function main(): Promise<void> {
  const args = parseLauncherArgs(process.argv.slice(2));
  const bytes = Buffer.from(getRawAsset('manifest.json'));
  const packageId = Buffer.from(getRawAsset('package-id')).toString('utf8');

  if (sha256(bytes) !== packageId) {
    throw new Error('Identity поставки изменилась');
  }

  const manifest = { ...JSON.parse(bytes.toString('utf8')), packageId };
  const info = decodeDeepSeekRuntimeInfo(manifest);

  if (args.expectedPackageId !== null && args.expectedPackageId !== info.packageId) {
    throw new Error('Identity поставки изменилась');
  }

  if (args.mode === 'runtime-info') {
    process.stdout.write(`${JSON.stringify(info)}\n`);

    return;
  }

  if (args.mode === 'version') {
    process.stdout.write(`${info.upstreamVersion}\n`);

    return;
  }

  if (args.mode === 'help') {
    process.stdout.write('DeepSeek Harness для GrigDesk\n'
      + '--runtime-info --json | --verify --json | -V | --license\n'
      + '--cache-dir <абсолютный путь> --expect-package-id <SHA256> [аргументы Harness]\n');

    return;
  }

  if (args.mode === 'license') {
    process.stdout.write(Buffer.from(getRawAsset('NODE-LICENSE')).toString('utf8'));
    process.stdout.write('\nПолный набор notices Harness встроен в generation/licenses/index.json.\n');

    return;
  }

  const asset = getRawAsset('payload.zip');
  const directory = await materializePayload({
    cacheDir: resolveExtractionCache(args.cacheDir ?? undefined, { env: process.env, home: os.homedir() }),
    packageId: info.packageId,
    fullVerify: args.mode === 'verify',
    payload: manifest.payload,
    archive: function* () {
      for (let offset = 0; offset < asset.byteLength; offset += 65536) {
        yield new Uint8Array(asset, offset, Math.min(65536, asset.byteLength - offset));
      }
    },
  });
  const result = await runLauncherWorker({
    directory,
    entry: path.join(directory, args.mode === 'verify' ? 'worker-verify.mjs' : 'generation/entry.mjs'),
    args: args.mode === 'verify' ? [directory] : args.harnessArgs,
    capture: args.mode === 'verify',
  });

  if (args.mode === 'verify') {
    if (result.code !== 0 || result.stderr !== '') {
      throw new Error('Worker отказал в проверке');
    }

    const verified = JSON.parse(result.stdout);

    if (verified.buildId !== info.buildId || verified.workerNode?.version !== info.workerNode.version
      || verified.workerNode?.abi !== info.workerNode.abi || verified.glmPlugin !== true) {
      throw new Error('Worker не подтвердил metadata поставки');
    }

    process.stdout.write(`${JSON.stringify({
      ...info,
      verified: true,
      glmPlugin: true,
    })}\n`);
  }

  process.exitCode = result.code;
}

void main().catch((error: unknown) => {
  const metadata = process.argv.slice(2).some((arg) => arg === '--runtime-info' || arg === '--verify');
  const result = launcherFailure(error, metadata);

  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
});
