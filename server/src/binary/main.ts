import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAsset, getRawAsset, isSea } from 'node:sea';

import { dataHome } from '../../../shared/runtime/dataHome.ts';
import { DataHomeError, checkDataHome } from '../lib/dataHomeBoot.ts';
import { packagedLaunchEnvironment } from '../lib/seaLaunch.ts';
import { parseServerBinaryArgs, type ServerBinaryArgs } from './args.ts';
import { materializePayload, resolveServerCache, type ExtractionOptions } from './cache.ts';
import * as runtimeLeases from './leases.ts';
import { decodeServerManifest, publicServerBinaryInfo, type ServerPackageManifest } from './metadata.ts';
import { verifyPreparedRuntime } from './verify.ts';
import { pruneServerCache, recordServerRuntimeUsage } from './prune.ts';
import { runLauncherWorker, workerEnvironment, type WorkerOptions } from './worker.ts';

export interface BinaryAssets {
  manifest(): { bytes: string; packageId: string };
  license(): string;
  archive(): AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
}

export interface LauncherInput {
  assets: BinaryAssets;
  env?: NodeJS.ProcessEnv;
  home?: () => string;
  binary?: () => string;
  cwd?: () => string;
  externalParent?: boolean;
  parentAlive?: () => boolean;
  send?: (message: object) => Promise<void>;
  writeOut?: (text: string) => void;
  writeError?: (text: string) => void;
  leases?: Partial<typeof runtimeLeases>;
  materialize?: typeof materializePayload;
  worker?: (options: WorkerOptions) => ReturnType<typeof runLauncherWorker>;
  verify?: typeof verifyPreparedRuntime;
  prune?: (input: { cacheDir: string; currentPackageId: string }) => Promise<unknown>;
  recordUsage?: typeof recordServerRuntimeUsage;
}

/**
 * Разрешение HOME/D и физического ELF отложено до завершения metadata веток.
 * Placement guard сравнивает D с I, а единственный cache определяется раскладкой данных.
 */
function launchPaths(input: LauncherInput) {
  const env = input.env ?? process.env;
  const home = (input.home ?? os.homedir)();
  const binary = (input.binary ?? (() => fs.realpathSync(process.execPath)))();
  const installationBin = path.dirname(binary);

  try {
    dataHome({ env, home });
    checkDataHome({
      codeRoot: path.dirname(installationBin),
      env,
      home,
    }, fs);
  } catch (error) {
    throw new DataHomeError((error as Error).message);
  }

  return {
    env,
    home,
    binary,
    installationBin,
    cacheDir: resolveServerCache({ env, home }),
  };
}

/**
 * Parent ACK передаётся только по настоящему IPC и после записи launcher owner.
 * Ошибка отправки не превращает передачу preparation в успешный запуск worker.
 */
async function sendParent(message: object): Promise<void> {
  if (process.send && process.connected) {
    await new Promise<void>((resolve, reject) => process.send!(message, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    }));
  }
}

/**
 * Обычный запуск удерживает launcher/worker owners до подтверждённого close.
 * Внешний parent теряет только внутренний IPC своего worker, без group kill фабрики.
 */
async function runPrepared(input: LauncherInput, args: Exclude<ServerBinaryArgs, { mode: 'error' }>,
  manifest: ServerPackageManifest, paths: ReturnType<typeof launchPaths>) {
  const leases = { ...runtimeLeases, ...input.leases };
  const extraction: ExtractionOptions = {
    cacheDir: paths.cacheDir,
    packageId: manifest.packageId,
    payload: manifest.payload,
    archive: () => input.assets.archive(),
    fullVerify: args.mode === 'verify',
  };
  let root: string;
  let lease: runtimeLeases.RuntimeLease;

  if (args.preparationToken) {
    lease = await leases.adoptPreparation({
      cacheDir: paths.cacheDir,
      packageId: manifest.packageId,
      token: args.preparationToken,
    });
    root = path.join(paths.cacheDir, 'packages', manifest.packageId);
  } else {
    const prepared = await leases.materializeWithLease(extraction, {
      kind: args.mode === 'prepare' ? 'prepare' : 'server',
      ownerPid: args.mode === 'prepare' ? process.ppid : process.pid,
    });

    root = prepared.root;
    lease = prepared.lease;
  }

  if (args.mode === 'prepare') {
    try {
      await (input.recordUsage ?? recordServerRuntimeUsage)({
        cacheDir: paths.cacheDir,
        packageId: manifest.packageId,
        activate: false,
      });
    } catch (error) {
      const owner = lease.owners.find((item) => item.pid === process.ppid);

      if (owner) {
        await leases.releaseRuntimeLeaseOwner({
          cacheDir: paths.cacheDir,
          packageId: manifest.packageId,
          token: lease.token,
          owner,
        });
      }

      throw error;
    }

    return {
      packageId: manifest.packageId,
      root,
      node: path.join(root, 'runtime/node/bin/node'),
      engine: path.join(root, 'engine/bin/factory'),
      installationBin: paths.installationBin,
      preparationToken: lease.token,
    };
  }

  const location = {
    cacheDir: paths.cacheDir,
    packageId: manifest.packageId,
    token: lease.token,
  };
  const launcherOwner = lease.owners.find((owner) => owner.pid === process.pid);
  let workerOwner: runtimeLeases.RuntimeOwner | undefined;

  if (!launcherOwner) {
    throw new Error('Lease не подтверждает владельца launcher');
  }

  try {
    await (input.recordUsage ?? recordServerRuntimeUsage)({
      cacheDir: paths.cacheDir,
      packageId: manifest.packageId,
      activate: args.mode === 'run',
    });

    if (args.preparationToken) {
      await (input.send ?? sendParent)({
        type: 'grigdesk:preparation-adopted',
        packageId: manifest.packageId,
        token: lease.token,
      });
      await (input.materialize ?? materializePayload)(extraction);
    }

    if (args.mode === 'verify') {
      return await (input.verify ?? verifyPreparedRuntime)({
        root,
        binary: paths.binary,
        manifest,
      });
    }

    const externalParent = input.externalParent ?? typeof process.send === 'function';
    const env = await packagedLaunchEnvironment({
      root,
      installationBin: paths.installationBin,
      parent: paths.env,
      home: paths.home,
    });

    delete env.GRIGDESK_DESKTOP_CHILD;
    env.GRIGDESK_SERVER_BINARY = paths.binary;

    if (externalParent) {
      env.GRIGDESK_DESKTOP_CHILD = '1';
    }

    const result = await (input.worker ?? runLauncherWorker)({
      root,
      binary: paths.binary,
      cwd: (input.cwd ?? process.cwd)(),
      env: workerEnvironment(env),
      externalParent,
      parentAlive: input.parentAlive,
      onSpawn: async (child) => {
        if (!child.pid) {
          throw new Error('Worker не получил PID');
        }

        const owned = await leases.addRuntimeLeaseOwner({ ...location, ownerPid: child.pid });

        workerOwner = owned.owners.find((owner) => owner.pid === child.pid);

        if (!workerOwner) {
          throw new Error('Lease не подтверждает владельца worker');
        }
      },
    });

    return result.code;
  } finally {
    if (workerOwner) {
      await leases.releaseRuntimeLeaseOwner({ ...location, owner: workerOwner });
    }

    await leases.releaseRuntimeLeaseOwner({ ...location, owner: launcherOwner });
  }
}

/**
 * Закрытая CLI таблица и manifest проверяются до любых эффектов папки данных.
 * Metadata использует только assets; обычный Node и API запускаются явной run веткой.
 */
export async function runServerBinary(argv: readonly string[], input: LauncherInput): Promise<number> {
  const write = input.writeOut ?? ((text: string) => process.stdout.write(text));
  const report = input.writeError ?? ((text: string) => process.stderr.write(text));
  const args = parseServerBinaryArgs(argv);

  if (args.mode === 'error') {
    report(`${args.message}\n`);

    return 2;
  }

  try {
    if (args.mode === 'release-preparation') {
      const paths = launchPaths(input);
      const leases = { ...runtimeLeases, ...input.leases };

      await leases.releaseRuntimeLeaseOwner({
        cacheDir: paths.cacheDir,
        packageId: args.packageId!,
        token: args.preparationToken!,
        owner: await leases.readProcessOwner(process.ppid),
      });
      write('{"ok":true}\n');

      return 0;
    }

    const asset = input.assets.manifest();
    const manifest = decodeServerManifest(asset.bytes, asset.packageId);
    const info = publicServerBinaryInfo({
      ...manifest,
      payload: {
        sha256: manifest.payload.sha256,
        size: manifest.payload.size,
        entryCount: manifest.payload.entries.length,
      },
    });

    if (['help', 'license', 'version', 'runtime-info'].includes(args.mode)) {
      if (args.mode === 'help') {
        write('GrigDesk: --version --runtime-info --prepare --verify --license --cache-prune\n');
      } else if (args.mode === 'license') {
        write(input.assets.license().replace(/\n?$/u, '\n'));
      } else {
        write(args.json ? `${JSON.stringify(info)}\n` : `${manifest.version}\n`);
      }

      return 0;
    }

    if (args.expectPackageId && args.expectPackageId !== manifest.packageId) {
      throw Object.assign(new Error('Серверный пакет изменился; повторите подготовку'), {
        code: 'server_package_changed',
      });
    }

    const paths = launchPaths(input);

    if (args.mode === 'cache-prune') {
      write(`${JSON.stringify(await (input.prune ?? pruneServerCache)({
        cacheDir: paths.cacheDir,
        currentPackageId: manifest.packageId,
      }))}\n`);

      return 0;
    }

    const result = await runPrepared(input, args, manifest, paths);

    if (typeof result === 'number') {
      return result;
    }

    const output = argv.includes('--check-startup') ? { ok: true, ...result } : result;

    write(args.json ? `${JSON.stringify(output)}\n` : 'Серверный runtime полностью проверен\n');

    return 0;
  } catch (error) {
    const failure = error as Error & { code?: string };
    const text = {
      ok: false,
      verified: false,
      code: failure.code ?? 'server_binary_failed',
      message: failure.message.slice(0, 1024),
    };

    report(`${JSON.stringify(text)}\n`);

    return error instanceof DataHomeError ? 78 : 1;
  }
}

/**
 * ZIP asset выдаётся ленивыми views по 64KiB, без копирования большого Buffer.
 * Warm cache не запрашивает архив; метакоманды не вычисляют даже папку HOME.
 */
function* seaArchive(): Iterable<Uint8Array> {
  const bytes = new Uint8Array(getRawAsset('payload'));

  for (let offset = 0; offset < bytes.length; offset += 65536) {
    yield bytes.subarray(offset, offset + 65536);
  }
}

if (isSea()) {
  void runServerBinary(process.argv.slice(2), {
    assets: {
      manifest: () => ({
        bytes: getAsset('manifest', 'utf8'),
        packageId: getAsset('package-id', 'utf8'),
      }),
      license: () => getAsset('NODE-LICENSE', 'utf8'),
      archive: seaArchive,
    },
  }).then((code) => {
    process.exitCode = code;
    process.channel?.unref();
  });
}
