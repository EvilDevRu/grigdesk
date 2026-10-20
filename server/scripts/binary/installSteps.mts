import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { acquireInstallLock, assertInstallFileUnchanged } from '../../../shared/node/binaryInstall.ts';
import { syncDirectory } from '../../../shared/node/files.ts';
import { sha256File } from '../../../shared/node/hash.ts';
import { decodeServerBinaryInfo } from '../../../shared/runtime/serverBinary.ts';
import { copyInstallCandidate, removeInstallStage } from './installFiles.mts';
import { approveInstall, previousInstall, savePrevious } from './installOwnership.mts';

const run = promisify(execFile);
const snapshotPolicy = {
  invalid: () => new Error('Проверенная копия сервера изменилась во время проб'),
};

export interface InstallOptions {
  binary: string;
  target: string;
  releasesDir: string;
}

interface ProbeContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
}

export interface InstallHooks {
  copy?: typeof copyInstallCandidate;
  probe?: (binary: string, args: string[], context: ProbeContext) => Promise<unknown>;
  publish?: typeof fs.rename;
}

/**
 * Metadata и полная проверка выполняются только на закрытом staged inode.
 * Окружение приходит из allowlist, а временные данные физически отделены от установки.
 */
async function probe(binary: string, args: string[], context: ProbeContext): Promise<unknown> {
  const result = await run(binary, args, { ...context, maxBuffer: 64 * 1024 });

  if (result.stderr !== '') {
    throw new Error('Проба сервера записала ошибку');
  }

  return JSON.parse(result.stdout);
}

/**
 * Установщик получает собственные stage и probe roots, удаляя только их.
 * Данные проб не попадают внутрь установки, где серверный guard запрещает размещать D.
 */
export async function installBinary(options: InstallOptions, hooks: InstallHooks = {}) {
  for (const value of Object.values(options)) {
    if (!path.isAbsolute(value) || value.includes('\0')) {
      throw new Error('Пути установщика сервера должны быть абсолютными');
    }
  }

  const parent = await fs.realpath(path.dirname(options.target));
  const target = path.join(parent, path.basename(options.target));
  const lock = await acquireInstallLock(target);
  let stage: string | undefined;
  let probeRoot: string | undefined;

  try {
    stage = await fs.mkdtemp(path.join(parent, '.grigdesk-server-install-'));
    probeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-server-probe-'));
    await fs.chmod(stage, 0o700);
    await fs.chmod(probeRoot, 0o700);

    const installation = path.dirname(parent);
    const physicalProbe = await fs.realpath(probeRoot);

    if (physicalProbe === installation || physicalProbe.startsWith(`${installation}${path.sep}`)
      || installation.startsWith(`${physicalProbe}${path.sep}`)) {
      throw new Error('Данные проб должны находиться вне установки сервера');
    }

    for (const directory of ['home', 'data', 'tmp', 'cache']) {
      await fs.mkdir(path.join(probeRoot, directory), { mode: 0o700 });
    }

    const staged = path.join(stage, 'grigdesk-server');

    await (hooks.copy ?? copyInstallCandidate)(options.binary, staged);

    const stamp = await fs.lstat(staged, { bigint: true });
    const digest = await sha256File(staged);
    const context = {
      cwd: probeRoot,
      env: {
        PATH: '',
        LANG: 'C.UTF-8',
        HOME: path.join(probeRoot, 'home'),
        GRIGDESK_HOME: path.join(probeRoot, 'data'),
        TMPDIR: path.join(probeRoot, 'tmp'),
        XDG_CACHE_HOME: path.join(probeRoot, 'cache'),
      },
      timeout: 30000,
    };
    const check = hooks.probe ?? probe;
    const info = decodeServerBinaryInfo(await check(staged, ['--runtime-info', '--json'], context));
    const proof = await check(staged, ['--verify', '--json'], {
      ...context,
      timeout: 120000,
    }) as Record<string, unknown> | null;

    if (!proof || proof.ok !== true || proof.verified !== true || proof.packageId !== info.packageId
      || proof.elfSha256 !== digest || !proof.runtime || typeof proof.runtime !== 'object'
      || Object.entries(info.runtime).some(([key, value]) =>
        Reflect.get(proof.runtime as object, key) !== value)
      || !Number.isSafeInteger(proof.filesVerified) || Number(proof.filesVerified) < 1
      || proof.nativeBindingsVerified !== 2) {
      throw new Error('Полная проверка сервера не подтвердила Node/native и packageId');
    }

    await assertInstallFileUnchanged(staged, stamp, digest, snapshotPolicy);

    const old = await previousInstall(target, stage);
    const previous = await savePrevious(old, options.releasesDir);

    await assertInstallFileUnchanged(staged, stamp, digest, snapshotPolicy);
    await approveInstall(old, digest, stage);
    await (hooks.publish ?? fs.rename)(staged, target);
    await syncDirectory(parent);

    return {
      packageId: info.packageId,
      sha256: digest,
      previous,
    };
  } finally {
    try {
      if (stage) {
        await removeInstallStage(stage);
      }
    } finally {
      try {
        if (probeRoot) {
          await removeInstallStage(probeRoot);
        }
      } finally {
        await lock.release();
      }
    }
  }
}
