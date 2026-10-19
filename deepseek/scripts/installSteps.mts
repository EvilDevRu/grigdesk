import { execFile } from 'node:child_process';
import type { BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  assertDeepSeekHostCompatibility,
  decodeDeepSeekHostContract,
  decodeDeepSeekRuntimeInfo,
  type DeepSeekRuntimeInfo,
} from '../../shared/chat/deepSeekBinary.ts';
import { acquireDirectoryLock } from '../../shared/node/directoryLock.ts';
import { syncDirectory } from '../../shared/node/files.ts';
import { assertDeepSeekGlmApiAdmission } from '../../shared/node/glmCompatibility.ts';
import { sha256File } from '../../shared/node/hash.ts';
import { copyInstallCandidate, removeInstallStage } from './installFiles.mts';
import { approveInstall, previousInstall, savePrevious } from './installOwnership.mts';

const run = promisify(execFile);

export interface InstallOptions {
  binary: string;
  target: string;
  hostContract: string;
  releasesDir: string;
}

export interface InstallResult {
  packageId: string;
  sha256: string;
  previous: string | null;
  memory: 'unknown' | 'continues' | 'resets';
}

export interface InstallHooks {
  copy?: typeof copyInstallCandidate;
  publish?: typeof fs.rename;
}

/**
 * Пробы получают одноразовые home/cache и не наследуют ключи, loader или NODE_OPTIONS.
 * Даже metadata читаются только из закрытой копии, а не из исходного candidate.
 */
async function probe(binary: string, stage: string, args: string[], timeout: number): Promise<unknown> {
  const result = await run(binary, args, {
    cwd: stage,
    env: {
      PATH: '',
      LANG: 'C.UTF-8',
      HOME: path.join(stage, 'home'),
      GRIGDESK_HOME: path.join(stage, 'data'),
      DSH_HOME: path.join(stage, 'home'),
      TMPDIR: path.join(stage, 'tmp'),
    },
    timeout,
    maxBuffer: 64 * 1024,
  });

  if (result.stderr !== '') {
    throw new Error('Проба DeepSeek записала ошибку');
  }

  return JSON.parse(result.stdout);
}

/**
 * Установленный потребитель задаёт все требования, включая фактический admission API.
 * Декларация compatibility без совпадения с входами плагина не даёт права публикации.
 */
async function checkCandidate(binary: string, stage: string, hostFile: string): Promise<DeepSeekRuntimeInfo> {
  const info = decodeDeepSeekRuntimeInfo(await probe(binary, stage, ['--runtime-info', '--json'], 30000));
  const host = decodeDeepSeekHostContract(JSON.parse(await fs.readFile(hostFile, 'utf8')));

  assertDeepSeekHostCompatibility(info, host);

  assertDeepSeekGlmApiAdmission(info, host);

  const proof = await probe(binary, stage, [
    '--cache-dir', path.join(stage, 'cache'), '--verify', '--json',
  ], 120000) as Record<string, unknown>;

  if (proof.verified !== true || proof.packageId !== info.packageId || proof.glmPlugin !== true) {
    throw new Error('Проверка целостности DeepSeek не подтвердила поставку');
  }

  return info;
}

/**
 * Хэш и lstat связывают публикацию с закрытой копией до первого запуска probes.
 * Проверка повторяется после любых запусков старого ELF и подготовки резервной копии.
 */
async function assertCandidateUnchanged(binary: string, stamp: BigIntStats, digest: string): Promise<void> {
  const checked = await fs.lstat(binary, { bigint: true });

  if (!checked.isFile() || (checked.mode & 0o777n) !== 0o555n
    || ['ino', 'size', 'mode', 'mtimeNs', 'ctimeNs'].some((field) =>
      Reflect.get(checked, field) !== Reflect.get(stamp, field))
    || await sha256File(binary) !== digest) {
    throw new Error('Проверенная копия DeepSeek изменилась во время проб');
  }
}

/**
 * Установка проверяет отдельную копию до изменения команды потребителя.
 * Атомарный rename публикует ровно те байты, чьи пробы завершились успешно.
 */
export async function installBinary(
  options: InstallOptions,
  hooks: InstallHooks = {},
): Promise<InstallResult> {
  for (const value of Object.values(options)) {
    if (!path.isAbsolute(value)) {
      throw new Error('Пути установщика DeepSeek должны быть абсолютными');
    }
  }

  const parent = await fs.realpath(path.dirname(options.target));
  const target = path.join(parent, path.basename(options.target));
  const lock = await acquireDirectoryLock(`${target}.install-lock`, { waitMs: 120000 });
  let stage: string | undefined;

  try {
    stage = await fs.mkdtemp(path.join(parent, '.deepseek-install-'));
    await fs.chmod(stage, 0o700);

    for (const directory of ['home', 'data', 'tmp', 'cache']) {
      await fs.mkdir(path.join(stage, directory), { mode: 0o700 });
    }

    const staged = path.join(stage, 'deepseek');

    await (hooks.copy ?? copyInstallCandidate)(options.binary, staged);

    const stamp = await fs.lstat(staged, { bigint: true });
    const digest = await sha256File(staged);
    const info = await checkCandidate(staged, stage, options.hostContract);

    await assertCandidateUnchanged(staged, stamp, digest);

    const old = await previousInstall(target, stage);
    const oldInfo = old.snapshot
      ? decodeDeepSeekRuntimeInfo(await probe(old.snapshot, stage, ['--runtime-info', '--json'], 30000))
      : null;
    const memory = oldInfo === null ? 'unknown'
      : info.journal.read.includes(oldInfo.journal.write) ? 'continues' : 'resets';
    const previous = await savePrevious(old, options.releasesDir);

    await assertCandidateUnchanged(staged, stamp, digest);
    await approveInstall(old, digest, stage);
    await (hooks.publish ?? fs.rename)(staged, target);
    await syncDirectory(parent);

    return {
      packageId: info.packageId,
      sha256: digest,
      previous,
      memory,
    };
  } finally {
    try {
      if (stage) {
        await removeInstallStage(stage);
      }
    } finally {
      await lock.release();
    }
  }
}
