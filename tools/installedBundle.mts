import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import { canonicalJson } from '../shared/lib/canonicalJson.ts';
import {
  RELEASE_DISTRIBUTION_SOURCE, type ReleaseDistributionSource,
} from '../shared/runtime/releaseChannelContracts.ts';
import { buildReleaseIdentity, type ReleaseChannel } from '../shared/runtime/productReleaseVersion.ts';
import { decodeReleaseChannelIndex, MAC_APP_ARCHIVE, MAC_APP_TREE, type ReleaseArtifact, type ReleasePayload }
  from '../shared/runtime/installedUpdateContracts.ts';
import { macDesktopTreeBytes } from '../shared/node/macosAppArchive.ts';
import { readProductBuildVersion } from '../shared/node/releaseBuild.ts';
import { releaseSignedBytes } from '../shared/node/releaseTrust.ts';
import { sha256, sha256File } from '../shared/node/hash.ts';
import { acquireDirectoryLock } from '../shared/node/directoryLock.ts';
import { auditStage } from '../server/scripts/sea/stage.mts';
import { buildReleaseUtility } from './goReleaseUtility.mts';
import { renderBootstrap } from './installBootstrap.mts';
import type { BundleOptions, BundleBuildInput } from './bundleSteps.mts';

const execute = promisify(execFile);

/**
 * Описание задаётся отдельным RU/EN JSON до дорогих сборщиков и входит в подписанный payload.
 * Отсутствие описания сохраняется как null, а повреждённый ввод прекращает выпуск.
 */
function releaseNotes(source: string | undefined): ReleasePayload['notes'] {
  if (!source?.trim()) {
    return null;
  }

  const notes: unknown = JSON.parse(source);

  if (!notes || typeof notes !== 'object' || Array.isArray(notes)
    || Object.keys(notes).sort().join(',') !== 'en,ru'
    || Object.values(notes).some((value) => typeof value !== 'string' || value.length > 16000)) {
    throw new Error('release_notes_invalid');
  }

  return notes as { ru: string; en: string };
}

interface StageFile {
  size: number;
  sha256: string;
  mode: number;
}

interface InstalledBundleStage {
  format: 1;
  origin: string;
  delivery: ReleaseDistributionSource;
  payload: ReleasePayload;
  helper: StageFile;
  files: Record<string, StageFile>;
}

const stagedNames = ['desktop.tar.gz', 'server.tar.gz', 'control.tar.gz', 'grigdesk-maintenance.gz',
  'bootstrap-template.sh', 'installer-ru.json', 'installer-en.json'];

const stageFile = 'unsigned-stage.json';

interface BundleSealExpectation {
  identity: ReturnType<typeof buildReleaseIdentity>;
  platform: ReleasePayload['platform'];
  origin: string;
}

/**
 * В опись входят только обычные файлы с подтверждённым режимом.
 * Последующая подпись повторно читает каждый из этих файлов.
 */
async function stagedFile(file: string): Promise<StageFile> {
  const stat = await fs.lstat(file);

  if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o022 || stat.size === 0) {
    throw new Error('release_staging_file_invalid');
  }

  return {
    size: stat.size,
    sha256: await sha256File(file),
    mode: stat.mode & 0o777,
  };
}

/**
 * Сборка завершается полной описью без закрытого ключа. Дорогие
 * builders и compression helper находятся на этой стороне границы.
 */
export async function stageInstalledBundle(options: BundleOptions, work: string): Promise<string> {
  const root = path.resolve(options.root);

  const version = await readProductBuildVersion(root, options.env ?? process.env);
  const commit = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  const channel = ((options.env ?? process.env).GRIGDESK_RELEASE_CHANNEL ?? 'release') as ReleaseChannel;
  const identity = buildReleaseIdentity(channel, version, commit);
  const notes = releaseNotes((options.env ?? process.env).GRIGDESK_RELEASE_NOTES_JSON);
  const origin = new URL((options.env ?? process.env).GRIGDESK_RELEASE_ORIGIN ?? 'https://grigdesk.com');
  const platform: ReleasePayload['platform'] = process.platform === 'darwin'
    ? {
      os: 'darwin',
      arch: 'arm64',
      minMacOS: '15.0',
    } : {
      os: 'linux',
      arch: process.arch === 'arm64' ? 'arm64' : 'x64',
      glibc: '2.28',
    };
  const releasePath = platform.os === 'darwin' ? 'releases/darwin-arm64'
    : platform.arch === 'arm64' ? 'releases/linux-arm64' : 'releases';

  if (process.platform !== platform.os || process.arch !== platform.arch) {
    throw new Error('release_platform_incompatible');
  }

  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/') {
    throw new Error('release_origin_invalid');
  }

  const home = path.join(work, 'home');

  await fs.mkdir(home, { mode: 0o700 });

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: 'C.UTF-8',
    HOME: home,
    GRIGDESK_HOME: path.join(home, 'data'),
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_DATA_HOME: path.join(home, 'share'),
    XDG_CACHE_HOME: path.join(home, 'cache'),
    TMPDIR: path.join(home, 'tmp'),
    GRIGDESK_RELEASE_VERSION: version,
    GRIGDESK_RELEASE_CHANNEL: channel,
    GRIGDESK_RELEASE_COMMIT: commit,
    GRIGDESK_RELEASE_ID: identity.releaseId,
  };

  for (const key of ['GRIGDESK_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'TMPDIR']) {
    await fs.mkdir(env[key]!, { recursive: true, mode: 0o700 });
  }

  if (process.platform === 'darwin') {
    const parent = options.env ?? process.env;

    env.GRIGDESK_BUILD_PROCESS_HELPER = parent.GRIGDESK_BUILD_PROCESS_HELPER;
    env.GRIGDESK_BUILD_PROCESS_HELPER_SHA256 = parent.GRIGDESK_BUILD_PROCESS_HELPER_SHA256;
    env.GRIGDESK_TEST_SETSID_BIN = parent.GRIGDESK_TEST_SETSID_BIN;
    env.GRIGDESK_BUILD_SETSID_SHA256 = parent.GRIGDESK_BUILD_SETSID_SHA256;
  }

  const files: Record<string, string> = {
    server: 'server/bin/grigdesk-server',
    tracker: 'server/bin/tracker',
    pipeline: 'server/bin/pipeline',
    routes: 'server/bin/routes',
    voice: 'server/bin/voice',
    relay: 'server/bin/grigdesk-relay',
    deepseek: 'server/bin/deepseek',
    window: platform.os === 'darwin' ? 'desktop/' + MAC_APP_ARCHIVE : 'desktop/GrigDesk',
  };

  for (const name of Object.keys(files) as (keyof typeof options.builders)[]) {
      if (typeof options.builders[name] !== 'function') {
          throw new Error('release_builder_missing:' + name);
      }
  }

  for (const component of ['desktop', 'server', 'control']) {
    await fs.mkdir(path.join(work, component, 'bin'), { recursive: true, mode: 0o700 });
  }

  for (const name of Object.keys(options.builders) as (keyof typeof options.builders)[]) {
    const input: BundleBuildInput = {
      outDir: path.join(work, 'build', name),
      cacheDir: path.join(work, 'cache', name),
      env,
    };

    await fs.mkdir(input.outDir, { recursive: true });
    await fs.mkdir(input.cacheDir, { recursive: true });

    const output = await options.builders[name](input);
    const physical = await fs.realpath(output);

    if (!physical.startsWith(input.outDir + path.sep) || !(await fs.lstat(output)).isFile()) {
      throw new Error('release_builder_output_invalid');
    }

    await fs.copyFile(output, path.join(work, files[name]!));
    await fs.chmod(path.join(work, files[name]!), name === 'window' && platform.os === 'darwin'
      ? 0o444 : 0o555);

    if (name === 'window' && platform.os === 'darwin') {
      const destination = path.join(work, 'desktop', MAC_APP_TREE);

      await fs.copyFile(path.join(path.dirname(output), MAC_APP_TREE), destination);
      await fs.chmod(destination, 0o444);
    }
  }

  const deepseek = path.join(work, 'server/bin/deepseek');

  await options.verifyDeepSeek(deepseek, env);
  await options.verifyDeepSeekCompatibility(deepseek, env);

  await buildReleaseUtility('grigdesk-ctl', {
    root,
    version,
    env,
    output: path.join(work, 'control/bin/grigdesk-ctl'),
    cache: path.join(work, 'cache/go'),
  });

  const artifacts = {} as ReleasePayload['artifacts'];

  for (const component of ['desktop', 'server', 'control'] as const) {
    const directory = path.join(work, component);
    const entries = await auditStage(directory, { required: [] });

    if (entries.some((entry) => entry.type !== 'file')) {
      throw new Error('release_archive_links_forbidden');
    }

    const inventory = entries.map(({ type: _type, ...file }) => file);
    const archive = path.join(work, `${component}.tar.gz`);

    await execute('tar', ['--format=ustar', '-czf', archive, '-C', directory,
      '--', ...inventory.map((file) => file.path)], {
      env: { ...env, ...(platform.os === 'darwin' ? { COPYFILE_DISABLE: '1' } : {}) },
    });

    const artifact: ReleaseArtifact = {
      url: `${origin.origin}/${releasePath}/${version}/${component}.tar.gz`,
      size: (await fs.stat(archive)).size,
      sha256: await sha256File(archive),
      unpackedSize: inventory.reduce((sum, file) => sum + file.size, 0),
      files: inventory,
      filesDigest: sha256(canonicalJson(inventory)),
      buildIdentity: identity,
    };

    if (component === 'server') {
      const info = await execute(path.join(directory, 'bin/grigdesk-server'), ['--version', '--json'], {
        env,
        timeout: 30_000,
        maxBuffer: 65536,
      });
      const metadata = JSON.parse(info.stdout) as { packageId?: string; version?: string };

      if (metadata.version !== version || !metadata.packageId || info.stderr) {
        throw new Error('release_server_identity_invalid');
      }

      artifact.packageId = metadata.packageId;
    } else if (component === 'desktop' && platform.os === 'darwin') {
      artifact.unpackedBundleBytes = await macDesktopTreeBytes(path.join(directory, MAC_APP_TREE));
    }

    artifacts[component] = artifact;
  }

  const payload: ReleasePayload = {
    ...identity,
    publishedAt: new Date().toISOString(),
    notes,
    dataCompatibility: 'unchanged-v1',
    serverApi: { major: 0, minor: 1 },
    desktopRequiresServerApi: { major: 0, minMinor: 1 },
    platform,
    artifacts,
  };

  const rawHelper = path.join(work, 'grigdesk-install');

  await buildReleaseUtility('grigdesk-maintenance', {
    root,
    version,
    env,
    output: rawHelper,
    cache: path.join(work, 'cache/go'),
  });

  const helperFile = path.join(work, 'grigdesk-maintenance.gz');
  const gzipOutput = await fs.open(helperFile, 'wx', 0o644);
  const gzip = spawn('gzip', ['-n', '-c', rawHelper],
    { stdio: ['ignore', gzipOutput.fd, 'ignore'] });
  const gzipCode = await new Promise<number>((resolve, reject) => {
    gzip.on('error', reject);
    gzip.on('close', (code) => resolve(code ?? 1));
  });

  await gzipOutput.close();

  if (gzipCode !== 0) {
    throw new Error('maintenance_gzip_failed');
  }

  const helperDescription = await stagedFile(rawHelper);

  await fs.rm(rawHelper);

  await fs.copyFile(path.join(root, 'tools/installBootstrap.sh'), path.join(work, 'bootstrap-template.sh'));

  for (const language of ['ru', 'en']) {
    const source = path.join(root, `shared/i18n/assets/locales/${language}/installer.json`);

    await fs.copyFile(source, path.join(work, `installer-${language}.json`));
  }

  const staged: InstalledBundleStage = {
    format: 1,
    origin: origin.origin,
    delivery: RELEASE_DISTRIBUTION_SOURCE,
    payload,
    helper: helperDescription,
    files: {},
  };

  for (const name of stagedNames) {
    const file = path.join(work, name);

    await fs.chmod(file, 0o444);
    staged.files[name] = await stagedFile(file);
  }

  const bytes = canonicalJson(staged) + '\n';

  await fs.writeFile(path.join(work, stageFile), bytes, { flag: 'wx', mode: 0o444 });

  return sha256(bytes);
}

/**
 * Verify stage связывает точную ожидaемую опись и bytes перед первым
 * обращением к signer. JSON stage не может добавить путь для подписи.
 */
export async function sealInstalledBundle(
  work: string, target: string, expectedDigest: string,
  sign: NonNullable<BundleOptions['sign']>,
  expected?: BundleSealExpectation,
): Promise<void> {
  const file = path.join(work, stageFile);

  if ((await stagedFile(file)).sha256 !== expectedDigest) {
    throw new Error('release_staging_digest_invalid');
  }

  const description = JSON.parse(await fs.readFile(file, 'utf8')) as InstalledBundleStage;

  if (description.format !== 1 || description.delivery !== RELEASE_DISTRIBUTION_SOURCE
    || canonicalJson(Object.keys(description.files).sort()) !== canonicalJson([...stagedNames].sort())) {
    throw new Error('release_staging_manifest_invalid');
  }

  for (const name of stagedNames) {
    const actual = await stagedFile(path.join(work, name));

    if (canonicalJson(actual) !== canonicalJson(description.files[name])) {
      throw new Error('release_staging_file_changed');
    }
  }

  const payload = description.payload;
  const { channel, artifacts } = payload;
  const identity = buildReleaseIdentity(channel, payload.version, payload.commit);
  const envelope = {
    format: 3 as const,
    payload,
    signature: '',
  };
  const index = {
    format: 3,
    channel,
    publishedAt: payload.publishedAt,
    latest: envelope,
  };

  decodeReleaseChannelIndex({ ...index, latest: { ...envelope, signature: 'A'.repeat(86) + '==' } });

  if (expected && (canonicalJson(identity) !== canonicalJson(expected.identity)
    || canonicalJson(payload.platform) !== canonicalJson(expected.platform)
    || description.origin !== expected.origin
    || Object.values(artifacts).some(({ url }) => new URL(url).origin !== expected.origin))) {
    throw new Error('release_staging_identity_invalid');
  }

  for (const component of ['desktop', 'server', 'control'] as const) {
    const actual = description.files[component + '.tar.gz']!;
    const expected = artifacts[component]!;

    if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) {
      throw new Error('release_staging_file_changed');
    }
  }

  envelope.signature = await sign(releaseSignedBytes(envelope).toString('utf8'));
  decodeReleaseChannelIndex(index);
  await fs.writeFile(path.join(work, `${channel}.json`), canonicalJson(index) + '\n');

  const indexBytes = Buffer.from(canonicalJson(index) + '\n', 'utf8');
  const manifestDigest = sha256(releaseSignedBytes(envelope));
  const compressed = description.files['grigdesk-maintenance.gz']!;
  const downloadBase = indexBytes.length + compressed.size + artifacts.control!.size;
  const script = renderBootstrap({
    format: 1,
    version: payload.version,
    channel,
    origin: description.origin,
    ...(payload.platform.os === 'darwin' ? { platform: 'darwin-arm64' as const } : {}),
    ...(description.delivery !== 'channel' ? { delivery: description.delivery } : {}),
    manifestDigest,
    indexSha256: sha256(indexBytes),
    indexSize: indexBytes.length,
    helperSha256: description.helper.sha256,
    helperSize: description.helper.size,
    compressedSha256: compressed.sha256,
    compressedSize: compressed.size,
    downloadBytes: {
      local: downloadBase + artifacts.desktop.size + artifacts.server.size,
      remote: downloadBase + artifacts.desktop.size,
      server: downloadBase + artifacts.server.size,
    },
  }, await fs.readFile(path.join(work, 'bootstrap-template.sh'), 'utf8'), {
    ru: JSON.parse(await fs.readFile(path.join(work, 'installer-ru.json'), 'utf8')),
    en: JSON.parse(await fs.readFile(path.join(work, 'installer-en.json'), 'utf8')),
  });

  await fs.writeFile(path.join(work, 'grigdesk-install'), script, { mode: 0o755 });

  const installerDigest = await sha256File(path.join(work, 'grigdesk-install'));
  const installerProof = `GrigDesk installer v1\n${installerDigest}  grigdesk-install\n`
    + `${manifestDigest}\n`;

  await fs.writeFile(path.join(work, 'grigdesk-install.sha256'), installerProof);
  await fs.writeFile(path.join(work, 'grigdesk-install.sig'), await sign(installerProof));
  await fs.writeFile(path.join(work, 'release-acceptance.json'), canonicalJson({
    format: 1,
    identity,
    manifestDigest: sha256(releaseSignedBytes(envelope)),
    checks: {
      schema: 'passed',
      deepseek: 'passed',
      installer: 'built',
    },
    runtimeAcceptance: 'not-performed',
  }) + '\n');

  await fs.mkdir(target);

  for (const name of ['desktop.tar.gz', 'server.tar.gz', 'control.tar.gz',
    'grigdesk-maintenance.gz', 'grigdesk-install',
    'grigdesk-install.sha256',
    'grigdesk-install.sig', 'release-acceptance.json', `${channel}.json`]) {
    await fs.rename(path.join(work, name), path.join(target, name));
  }
}

/**
 * Linux-only и локальный build сохраняют прежнюю команду и формат выхода.
 * Wrapper использует ту же последовательность staging и seal под release lock.
 */
export async function executeInstalledBundle(options: BundleOptions): Promise<void> {
  if (!options.sign) {
    throw new Error('release_signing_key_missing');
  }

  const root = path.resolve(options.root);
  const lock = await acquireDirectoryLock(path.join(root, '.grigdesk-bundle.lock'));
  const work = await fs.mkdtemp(path.join(root, '.installed-release-'));

  try {
    const digest = await stageInstalledBundle(options, work);

    await sealInstalledBundle(work, path.join(root, 'release-artifacts'), digest, options.sign);
  } finally {
    // Go module cache и staged-файлы хранятся read-only, поэтому rmdir каталогов
    // падает с EACCES. Возвращаем право записи и не даём очистке замаскировать
    // результат сборки: одноразовый каталог остаётся допустимым остатком.
    await execute('chmod', ['-R', 'u+w', work]).catch(() => {});
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
    await lock.release();
  }
}
