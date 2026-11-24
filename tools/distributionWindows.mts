import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import type { createDistributionProgress } from '../cli/distributionProgress.ts';
import { sha256File } from '../shared/node/hash.ts';
import { withWorkDirectory } from '../shared/node/files.ts';
import { readNodeRuntime } from '../shared/node/nodeRuntime.ts';
import { downloadFile } from '../shared/node/seaBuild.ts';
import { artifactsPath, dataHome, dataPath } from '../shared/runtime/dataHome.ts';
import { buildReleaseIdentity } from '../shared/runtime/productReleaseVersion.ts';
import { createSourceSnapshot } from './distributionSnapshot.mts';
import { publishDistributionOutput } from './distributionOutput.mts';
import { zipStore } from './linuxOfflinePackage.mts';
import { stableAssetNames } from './stablePlatformRelease.mts';

const execute = promisify(execFile);
const target = 'windows-x64';

/**
 * Windows получает node.exe той же версии, что и нативный раннер.
 * Распаковка начинается только после сверки архива с SHA из исходников.
 */
async function prepareWindowsNode(root: string, work: string): Promise<string> {
  const manifest = path.join(root, 'server/build/node-runtime.json');
  const pin = JSON.parse(await fs.readFile(manifest, 'utf8'));
  const { version } = readNodeRuntime(pin, manifest);
  const checksum: unknown = pin.windowsX64ZipSha256;

  if (typeof checksum !== 'string' || !/^[a-f0-9]{64}$/u.test(checksum)) {
    throw new Error('windows_node_checksum_missing');
  }

  const distribution = `node-v${version}-win-x64`;
  const archive = path.join(work, distribution + '.zip');
  const executable = `${distribution}/node.exe`;

  await downloadFile(`https://nodejs.org/dist/v${version}/${distribution}.zip`, archive);

  if (await sha256File(archive) !== checksum) {
    throw new Error('windows_node_checksum_mismatch');
  }

  await execute('unzip', ['-q', archive, executable, '-d', work], { timeout: 30_000 });

  return path.join(work, executable);
}

/**
 * Linux собирает пробный Windows-комплект в отдельном снимке с временным ключом.
 * Публичное имя ZIP появляется только после проверки описи и архива.
 */
export async function runDistributionWindowsBuild(
  root: string, progress?: ReturnType<typeof createDistributionProgress>,
): Promise<number> {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('Сборка Windows x64 доступна на Linux x64.');
  }

  await execute('wine', ['--version'], { timeout: 10_000 }).catch((error: Error) => {
    throw new Error('Для сборки Windows x64 нужен рабочий Wine в PATH.', { cause: error });
  });

  const home = { env: process.env, home: os.homedir() };
  const artifacts = artifactsPath(home);
  const dists = dataPath(dataHome(home), 'dists');

  await fs.mkdir(artifacts, { recursive: true, mode: 0o700 });

  const run = await fs.mkdtemp(path.join(await fs.realpath(artifacts), 'dist-windows-'));

  progress?.plan(4);

  try {
    const output = await withWorkDirectory(run, async (work) => {
      progress?.phase('snapshot');

      const { cloneRoot, commit } = await createSourceSnapshot({ root, runDir: work });
      const base = (await fs.readFile(path.join(cloneRoot, 'VERSION'), 'utf8')).trim();
      const runId = String(Date.now());
      const plan = { current: buildReleaseIdentity('dev', `${base}-dev.${runId}`, commit), runId };

      progress?.completed();
      progress?.phase('setup');

      const node = await prepareWindowsNode(cloneRoot, work);

      for (const directory of ['server', 'web', 'desktop']) {
        await execute('npm', ['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
          cwd: path.join(cloneRoot, directory),
          timeout: 300_000,
        });
      }

      progress?.completed();
      progress?.phase('windows');

      const adapter = pathToFileURL(path.join(cloneRoot, 'tools/ci/windowsNative.mts'));
      const windows: typeof import('./ci/windowsNative.mts') = await import(adapter.href);
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const components = path.join(work, 'components');

      await windows.buildWindowsNative(target, plan, components, privateKey, node);

      const { files } = await windows.verifyWindowsPackage(components, target, plan, publicKey);

      progress?.completed();
      progress?.phase('record');

      const name = stableAssetNames(target, plan.current.version)[0]!;
      const partial = path.join(work, name);

      await zipStore(components, partial, files.map((file) => file.name));
      await execute('7z', ['t', partial], { timeout: 120_000 });
      await fs.mkdir(dists, { recursive: true, mode: 0o700 });

      const result = path.join(await fs.realpath(dists), path.basename(run), name);

      await publishDistributionOutput(partial, result);

      return result;
    });

    progress?.success();
    process.stdout.write(output + '\n');

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const output = error as { stdout?: string; stderr?: string } | null;
    const log = path.join(run, 'build-error.log');

    await fs.writeFile(log, [message, output?.stdout, output?.stderr].filter(Boolean).join('\n') + '\n', {
      mode: 0o600,
    });

    throw new Error(`${message}\n${log}`, { cause: error });
  }
}
