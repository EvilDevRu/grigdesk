import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { decodeDeepSeekRuntimeInfo } from '../../shared/chat/deepSeekBinary.ts';
import { canonicalJson } from '../../shared/lib/canonicalJson.ts';
import { acquireDirectoryLock } from '../../shared/node/directoryLock.ts';
import { sha256, sha256File } from '../../shared/node/hash.ts';
import { readWorkerArtifact } from '../src/runtime/artifact.ts';
import { GLM_COMPATIBILITY } from '../src/runtime/glmCompatibility.ts';
import { createDeepSeekMetadata, packageIdFor, type DeepSeekManifest } from '../src/runtime/metadata.ts';
import { consumePayloadArchive, decodePayloadDescriptor } from '../src/runtime/payloadIndex.ts';
import { createReadStream } from 'node:fs';

import { binaryPackageInputs } from './binaryInputs.mts';
import { deepSeekBuildInputs } from './buildRuntime.mts';
import type { BinaryBuildOptions } from './buildSteps.mts';
import { packagePayload } from './packagePayload.mts';
import { deepSeekPackagePaths } from './paths.ts';
import { readPreparedRuntimeDependencies } from './prepareRuntimeDeps.mts';

const run = promisify(execFile);

/**
 * Закрытый reusable payload всегда сопровождается полным manifest предыдущей упаковки.
 * Перед переупаковкой сверяются packageId, весь ZIP и индекс, без пересборки generation.
 */
async function reusePayload(file: string, work: string): Promise<DeepSeekManifest> {
  const value = JSON.parse(await readFile(`${file}.manifest.json`, 'utf8'));
  const info = decodeDeepSeekRuntimeInfo(value);
  const payload = decodePayloadDescriptor(value.payload);

  if (packageIdFor(value) !== info.packageId) {
    throw new Error('Manifest готового payload повреждён');
  }

  await consumePayloadArchive(createReadStream(file), payload);
  await copyFile(file, path.join(work, 'payload.zip'));

  return value;
}

/**
 * Под pinned Node собирается только собственный prefix, его lock сверяется с exact источником.
 * Возвращённый lock удерживается вызывающим до конца упаковки и чтения journal contract.
 * При ошибке подготовки владелец освобождается здесь, готовое дерево не становится production current.
 */
async function generation(work: string, options: BinaryBuildOptions) {
  const prepared = await readPreparedRuntimeDependencies(options.nodeCacheDir);
  const node = prepared.node;
  const identitySource = 'JSON.stringify({ version: process.versions.node, abi: process.versions.modules })';
  const actual = JSON.parse((await run(node, ['--print', identitySource], { env: {} })).stdout);

  if (actual.version !== prepared.version || actual.abi !== prepared.abi
    || await sha256File(path.join(work, 'bin/node')) !== prepared.nodeSha256) {
    throw new Error('Dependencies подготовлены другим worker Node');
  }

  const paths = deepSeekPackagePaths();
  const vendorDir = options.vendorDir ?? paths.vendorDir;
  const inputs = await deepSeekBuildInputs(vendorDir, prepared.directory);
  const identity = sha256(canonicalJson({
    hashes: inputs.hashes,
    source: inputs.source,
    worker: {
      version: prepared.version,
      abi: prepared.abi,
      sha256: prepared.nodeSha256,
    },
  }));
  const parent = path.join(options.nodeCacheDir, 'generations');
  const directory = path.join(parent, identity);

  await mkdir(parent, { recursive: true, mode: 0o700 });

  const lock = await acquireDirectoryLock(`${directory}.lock`, { waitMs: 300000 });
  const worker = {
    nodeVersion: prepared.version,
    nativeAbi: prepared.abi,
    platform: 'linux',
    arch: 'x64',
  };

  try {
    const exists = await readFile(path.join(directory, 'runtime.json')).then(() => true, () => false);

    if (!exists) {
      const home = path.join(options.nodeCacheDir, 'build-home');
      const temporary = path.join(options.nodeCacheDir, 'tmp');

      await mkdir(home, { recursive: true, mode: 0o700 });
      await mkdir(temporary, { recursive: true, mode: 0o700 });
      await run(node, [paths.scripts.runtime, '--vendor-dir', vendorDir,
        '--runtime-deps-dir', prepared.directory,
        '--output-dir', directory, '--read-only'], {
        env: {
          PATH: `${path.dirname(node)}:/usr/bin:/bin`,
          HOME: home,
          TMPDIR: temporary,
          XDG_CACHE_HOME: path.join(options.nodeCacheDir, 'build-cache'),
        },
        timeout: 300000,
        maxBuffer: 16 * 1024 * 1024,
      });
    }

    const verified = await readWorkerArtifact(directory, worker);

    return {
      directory,
      artifact: verified.artifact,
      worker,
      nodeSha256: prepared.nodeSha256,
      lock,
    };
  } catch (error) {
    await lock.release();

    throw error;
  }
}

/**
 * Номера журналов берутся из скомпилированного first-party catalog, а не констант builder.
 * Catalog гарантирует полную смежную цепочку codec от v0 до своего currentVersion.
 */
async function journalContract(node: string, directory: string): Promise<{ write: number; read: number[] }> {
  const source = `
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const requireRuntime = createRequire(${JSON.stringify(path.join(directory, 'package.json'))});
const { sessionFormatCatalog } = await import(pathToFileURL(
  requireRuntime.resolve('@deepseek-ai/dsh-session-format-catalog'),
).href);
const write = sessionFormatCatalog.currentVersion;
console.log(JSON.stringify({ write, read: Array.from({ length: write + 1 }, (_, version) => version) }));
`;
  const result = await run(node, ['--input-type=module', '-e', source], { env: {}, timeout: 30000 });

  return JSON.parse(result.stdout);
}

/**
 * Полный manifest связывает generation, Node, launcher, codecs, admission и bytes архива.
 * Sidecar остаётся build-артефактом для --payload; установленному ELF соседние файлы не нужны.
 */
export async function prepareBinaryPayload(
  work: string,
  options: BinaryBuildOptions,
): Promise<DeepSeekManifest> {
  const paths = deepSeekPackagePaths();
  const compatibility = GLM_COMPATIBILITY;
  const manifest = JSON.parse(await readFile(path.join(paths.root, 'package.json'), 'utf8'));
  let base: Record<string, unknown>;

  if (options.payload) {
    base = await reusePayload(options.payload, work);
  } else {
    const built = await generation(work, options);

    try {
      const raw = JSON.parse(await readFile(path.join(built.directory, 'runtime.json'), 'utf8'));
      const payload = await packagePayload({
        generationDirectory: built.directory,
        workerNode: path.join(work, 'bin/node'),
        nodeLicense: path.join(work, 'LICENSE'),
        workerBootstrap: path.join(work, 'worker-bootstrap.mjs'),
        workerVerify: path.join(work, 'worker-verify.mjs'),
        worker: built.worker,
        outputFile: path.join(work, 'payload.zip'),
      });

      base = {
        format: 1,
        upstreamVersion: built.artifact.source.version,
        buildId: built.artifact.buildId,
        runtimeVersion: built.artifact.runtimeVersion,
        hostContract: built.artifact.hostContract,
        journal: await journalContract(path.join(work, 'bin/node'), built.directory),
        platform: 'linux',
        arch: 'x64',
        workerNode: {
          version: built.worker.nodeVersion,
          abi: built.worker.nativeAbi,
          sha256: built.nodeSha256,
        },
        capabilities: built.artifact.capabilities,
        glm: {
          inputs: {
            source: { commit: raw.source.commit },
            inputIdentity: {
              composition: raw.inputIdentity.composition,
              dependencyLock: raw.inputIdentity.dependencyLock,
            },
            llmPiAi: raw.llmPiAi,
          },
        },
        payload,
      };
    } finally {
      await built.lock.release();
    }
  }

  const raw = {
    ...base,
    binaryVersion: options.binaryVersion ?? manifest.version,
    launcher: await sha256File(path.join(work, 'bundle.cjs')),
    packageInputs: await binaryPackageInputs(),
    glm: { ...(base.glm as object), ...compatibility },
  };
  const payload = decodePayloadDescriptor(base.payload);
  const known = decodeDeepSeekRuntimeInfo({ ...raw, packageId: packageIdFor(raw) });
  const result = createDeepSeekMetadata({
    ...raw,
    ...known,
    payload,
  });
  const payloadRoot = path.join(options.nodeCacheDir, 'payloads', payload.sha256);

  await mkdir(payloadRoot, { recursive: true, mode: 0o700 });
  await copyFile(path.join(work, 'payload.zip'), path.join(payloadRoot, 'payload.zip'));
  await writeFile(path.join(payloadRoot, 'payload.zip.manifest.json'), JSON.stringify(result), {
    mode: 0o600,
  });

  return result;
}
