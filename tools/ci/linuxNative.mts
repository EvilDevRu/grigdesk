import { execFile } from 'node:child_process';
import { createPublicKey } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

import { sha256 } from '../../shared/node/hash.ts';
import { RELEASE_SIGNING_PUBLIC_KEY } from '../../shared/runtime/releaseChannelContracts.ts';
import { offlinePackageFiles } from '../linuxOfflinePackage.mts';
import { readStableReleasePlan } from '../stableReleasePlan.mts';
import { publicReleaseFile } from '../verifyLinuxPackages.mts';

const execute = promisify(execFile);
const repository = path.resolve(import.meta.dirname, '../..');

export type UnixTarget = 'linux-arm64' | 'darwin-arm64';
type Plan = Awaited<ReturnType<typeof readStableReleasePlan>>;

interface UnixInputs {
  target: UnixTarget;
  plan: Plan;
  planDigest: string;
}

/**
 * Стабильные Linux ARM64 и Apple Silicon собираются на нативном раннере своей
 * архитектуры. План читается по хешу job plan, identity выводится из точного commit.
 */
export async function unixStableInputs(target: string | undefined, file: string | undefined):
Promise<UnixInputs> {
  if (target !== 'linux-arm64' && target !== 'darwin-arm64') {
    throw new Error(`stable_native_adapter_missing (${target})`);
  }

  const native = target === 'linux-arm64'
    ? process.platform === 'linux' && process.arch === 'arm64'
    : process.platform === 'darwin' && process.arch === 'arm64';

  if (!file || !native) {
    throw new Error('unix_native_runner_mismatch');
  }

  const planDigest = process.env.STABLE_PLAN_SHA256 ?? '';
  const plan = await readStableReleasePlan(file, {
    commit: process.env.GITHUB_SHA ?? '',
    runId: process.env.GITHUB_RUN_ID ?? '',
    digest: planDigest,
  });

  return {
    target,
    plan,
    planDigest,
  };
}

/**
 * Сборщик вызывает штатный bundle checkout на нативной архитектуре. Серверный
 * сборщик сам выбирает закреплённый Node своей платформы и отвергает чужой ELF.
 * Ключ подписи передаётся файлом и не попадает в окружение builders.
 */
export async function buildUnixNative(
  target: UnixTarget, plan: Plan, output: string, keyFile: string,
): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GRIGDESK_RELEASE_VERSION: plan.current.version,
    GRIGDESK_RELEASE_CHANNEL: plan.current.channel,
    GRIGDESK_RELEASE_COMMIT: plan.current.commit,
    GRIGDESK_RELEASE_ID: plan.current.releaseId,
    GRIGDESK_RELEASE_SIGNING_KEY: keyFile,
    GRIGDESK_CTL_BUILD_OBSERVED: '1',
    GOTOOLCHAIN: 'local',
    GOWORK: 'off',
    CGO_ENABLED: '0',
  };

  await execute(process.execPath, [path.join(repository, 'tools/bundle.mts')], {
    cwd: repository,
    env,
    timeout: 1_800_000,
    maxBuffer: 64 * 1024 * 1024,
  });

  const artifacts = path.join(repository, 'release-artifacts');

  await fs.mkdir(output, { recursive: true });

  for (const name of offlinePackageFiles('release')) {
    await fs.copyFile(path.join(artifacts, name), path.join(output, name));
  }
}

/**
 * Опись проверенного комплекта повторяет контракт сборщика: размер и SHA каждого
 * обычного файла. Proof связывает платформу с точным планом и отпечатком ключа.
 */
export async function unixNativeProof(
  target: UnixTarget, plan: Plan, planDigest: string, source: string,
  signerFingerprint: string, manifestDigest: string,
) {
  const files = [];

  for (const name of offlinePackageFiles('release')) {
    const file = path.join(source, name);
    const stat = await fs.lstat(file);

    if (!stat.isFile() || stat.size < 1) {
      throw new Error(`unix_release_file_invalid: ${name}`);
    }

    files.push({
      name,
      size: stat.size,
      sha256: await sha256(await fs.readFile(file)),
    });
  }

  return {
    format: 1 as const,
    parts: [{
      ...plan.current,
      runId: plan.runId,
      platform: target,
      planDigest,
      manifestDigest,
      signerFingerprint,
      files,
    }],
  };
}

/**
 * Нативная приёмка ставит комплект штатным install-online в приватный корень и
 * подтверждает identity установленного сервера. Данные и корень разнесены,
 * поэтому проверка не затрагивает рабочую установку раннера.
 */
export async function verifyUnixNative(
  target: UnixTarget, plan: Plan, planDigest: string, source: string, output: string,
): Promise<void> {
  const files = [];

  for (const name of offlinePackageFiles('release')) {
    files.push(await publicReleaseFile(source, name));
  }

  const work = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'grigdesk-unix-verify-'));

  try {
    const helper = path.join(work, 'grigdesk-maintenance');

    await fs.writeFile(helper, gunzipSync(await fs.readFile(path.join(source, 'grigdesk-maintenance.gz'))),
      { mode: 0o700 });

    const paths = {
      root: path.join(work, 'installation'),
      dataHome: path.join(work, 'data'),
      userData: path.join(work, 'user-data'),
      binDirectory: path.join(work, 'bin'),
      applicationsDirectory: path.join(work, 'applications'),
      unitDirectory: path.join(work, 'units'),
      cacheDir: path.join(work, 'cache'),
      home: path.join(work, 'home'),
    };

    // Корень установки создаёт сам инсталлятор: уже существующий пустой каталог
    // распознаётся как прежняя установка и отвергается installation_root_conflict.
    for (const [name, directory] of Object.entries(paths)) {
      if (name !== 'root') {
        await fs.mkdir(directory, { recursive: true });
      }
    }

    for (const sub of ['.cache', '.config', path.join('.local', 'share')]) {
      await fs.mkdir(path.join(paths.home, sub), { recursive: true });
    }

    await execute(helper, [
      'install-online', '--release', path.join(source, 'release.json'), '--mode', 'local',
      '--root', paths.root, '--data-home', paths.dataHome, '--user-data', paths.userData,
      '--bin-dir', paths.binDirectory, '--applications-dir', paths.applicationsDirectory,
      '--unit-dir', paths.unitDirectory, '--cache-dir', paths.cacheDir, '--source-dir', source,
    ], {
      env: {
        ...process.env,
        HOME: paths.home,
        XDG_CONFIG_HOME: path.join(paths.home, '.config'),
        XDG_DATA_HOME: path.join(paths.home, '.local', 'share'),
        XDG_CACHE_HOME: path.join(paths.home, '.cache'),
      },
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
    });

    const pointer = JSON.parse(await fs.readFile(path.join(paths.root, 'current.json'), 'utf8')) as
      { server: string | null };

    if (!pointer.server) {
      throw new Error('unix_verify_server_generation_missing');
    }

    const serverBinary = path.join(paths.root, pointer.server, 'bin', 'grigdesk-server');
    const probe = await execute(serverBinary, ['--version'], {
      env: { ...process.env, HOME: paths.home },
      timeout: 60_000,
    });

    if (!probe.stdout.includes(plan.current.version)) {
      throw new Error('unix_verify_server_identity_invalid');
    }

    const targetOutput = path.join(output, target);

    await fs.mkdir(targetOutput, { recursive: true });

    for (const file of files) {
      await fs.copyFile(path.join(source, file.name), path.join(targetOutput, file.name));
    }

    const manifestDigest = sha256(await fs.readFile(path.join(source, 'release.json')));
    const signerFingerprint = sha256(createPublicKey(RELEASE_SIGNING_PUBLIC_KEY)
      .export({ type: 'spki', format: 'der' }));
    const proof = await unixNativeProof(target, plan, planDigest, source,
      signerFingerprint, manifestDigest);

    await fs.writeFile(path.join(output, 'stable-native-proof.json'),
      JSON.stringify(proof) + '\n', { flag: 'wx' });
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}