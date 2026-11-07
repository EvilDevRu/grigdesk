import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { canonicalJson } from '../shared/lib/canonicalJson.ts';
import { buildReleaseIdentity, type ReleaseChannel } from '../shared/runtime/productReleaseVersion.ts';
import { decodeReleaseChannelIndex, type ReleaseArtifact, type ReleasePayload }
  from '../shared/runtime/installedUpdateContracts.ts';
import { readProductBuildVersion } from '../shared/node/releaseBuild.ts';
import { releaseSignedBytes } from '../shared/node/releaseTrust.ts';
import { sha256, sha256File } from '../shared/node/hash.ts';
import { acquireDirectoryLock } from '../shared/node/directoryLock.ts';
import { auditStage } from '../server/scripts/sea/stage.mts';
import { buildMaintenance } from './build-maintenance.mts';
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

/**
 * Новый официальный выход состоит из installer, двух архивов и отдельного v2-индекса.
 * Старый executeBundle остаётся историческим сборочным контрактом, но этот путь его не вызывает.
 */
export async function executeInstalledBundle(options: BundleOptions): Promise<void> {
  if (!options.sign) {
    throw new Error('release_signing_key_missing');
  }

  const root = path.resolve(options.root);
  const lock = await acquireDirectoryLock(path.join(root, '.grigdesk-bundle.lock'));
  const work = await fs.mkdtemp(path.join(root, '.installed-release-'));

  try {
    const version = await readProductBuildVersion(root, options.env ?? process.env);
    const commit = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
    const channel = ((options.env ?? process.env).GRIGDESK_RELEASE_CHANNEL ?? 'release') as ReleaseChannel;
    const identity = buildReleaseIdentity(channel, version, commit);
    const notes = releaseNotes((options.env ?? process.env).GRIGDESK_RELEASE_NOTES_JSON);
    const origin = new URL((options.env ?? process.env).GRIGDESK_RELEASE_ORIGIN ?? 'https://grigdesk.com');

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

    const files: Record<string, string> = {
      server: 'server/bin/grigdesk-server',
      b24: 'server/bin/b24',
      relay: 'server/bin/grigdesk-relay',
      deepseek: 'server/bin/deepseek',
      window: 'desktop/GrigDesk',
    };

    for (const component of ['desktop', 'server']) {
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
      await fs.chmod(path.join(work, files[name]!), 0o555);
    }

    const deepseek = path.join(work, 'server/bin/deepseek');

    await options.verifyDeepSeek(deepseek, env);
    await options.verifyDeepSeekCompatibility(deepseek, env);

    const artifacts = {} as ReleasePayload['artifacts'];

    for (const component of ['desktop', 'server'] as const) {
      const directory = path.join(work, component);
      const entries = await auditStage(directory, { required: [] });

      if (entries.some((entry) => entry.type !== 'file')) {
        throw new Error('release_archive_links_forbidden');
      }

      const inventory = entries.map(({ type: _type, ...file }) => file);
      const archive = path.join(work, `${component}.tar.gz`);

      await execute('tar', ['--format=ustar', '-czf', archive, '-C', directory,
        '--', ...inventory.map((file) => file.path)], { env });

      const artifact: ReleaseArtifact = {
        url: `${origin.origin}/releases/${version}/${component}.tar.gz`,
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
      platform: {
        os: 'linux',
        arch: 'x64',
        glibc: '2.28',
      },
      artifacts,
    };
    const envelope = { payload, signature: '' };

    envelope.signature = await options.sign(releaseSignedBytes(envelope).toString('utf8'));

    const index = {
      format: 2,
      channel,
      publishedAt: payload.publishedAt,
      latest: envelope,
    };

    decodeReleaseChannelIndex(index);
    await fs.writeFile(path.join(work, `${channel}.json`), canonicalJson(index) + '\n');
    await fs.writeFile(path.join(work, 'release-envelope.json'), canonicalJson(envelope) + '\n');
    await buildMaintenance({
      root,
      outDir: work,
      cacheDir: path.join(work, 'cache/maintenance'),
      assets: {
        release: path.join(work, 'release-envelope.json'),
        desktop: path.join(work, 'desktop.tar.gz'),
        server: path.join(work, 'server.tar.gz'),
      },
    });

    const installerDigest = await sha256File(path.join(work, 'grigdesk-install'));
    const installerProof = `GrigDesk installer v1\n${installerDigest}  grigdesk-install\n`
      + `${sha256(releaseSignedBytes(envelope))}\n`;

    await fs.writeFile(path.join(work, 'grigdesk-install.sha256'), installerProof);
    await fs.writeFile(path.join(work, 'grigdesk-install.sig'), await options.sign(installerProof));
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

    const target = path.join(root, 'release-artifacts');

    await fs.mkdir(target);

    for (const name of ['desktop.tar.gz', 'server.tar.gz', 'grigdesk-install', 'grigdesk-install.sha256',
      'grigdesk-install.sig', 'release-acceptance.json', `${channel}.json`]) {
      await fs.rename(path.join(work, name), path.join(target, name));
    }
  } finally {
    await fs.rm(work, { recursive: true, force: true });
    await lock.release();
  }
}
