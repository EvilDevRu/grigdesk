import path from 'node:path';
import os from 'node:os';
import { chmod, cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sha256, sha256File } from '../shared/node/hash.ts';
import { verifyHelpBundle } from '../shared/node/helpSources.ts';
import { readContainedText } from '../shared/node/readContainedText.ts';
import {
  prepareServerBinary, probeServerBinary, releaseServerPreparation,
} from '../shared/node/serverBinaryRuntime.ts';
import { shellQuote } from '../shared/lib/shellQuote.ts';
import { normalizeStageModes } from '../server/scripts/sea/stage.mts';
import { isStableReleaseVersion } from '../shared/runtime/releaseChannelContracts.ts';

const execute = promisify(execFile);

export interface HelpReleaseIdentity {
  version: string;
  commit: string;
  archiveSha256: string;
  bundleSha256: string;
}
/**
 * Caller уже проверил подпись identity; здесь повторно связываем реальные байты архива,
 * описи, бинарника и справки. Executable запускается только после проверки его SHA.
 */
export async function prepareReleaseHelp(directory: string, expected: HelpReleaseIdentity) {
  const work = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-help-publish-'));
  const archive = path.join(directory, 'release.tar.gz');
  const install = path.join(work, 'install');
  const home = path.join(work, 'data');
  let preparation: Awaited<ReturnType<typeof prepareServerBinary>> | null = null;
  let binary = '';

  /**
   * Освобождает lease подготовленного runtime до удаления собственной папки.
   * Повторная уборка не удаляет ресурсы чужой установки или пользователя.
   */
  async function dispose(): Promise<void> {
    try {
      if (preparation) {
        await releaseServerPreparation(binary, {
          home,
          packageId: preparation.packageId,
          token: preparation.preparationToken
        });
        preparation = null;
      }
    }
    finally {
      await rm(work, {
        recursive: true, force: true
      });
    }
  }

  try {
    if (await sha256File(archive) !== expected.archiveSha256) {
      throw new Error('help_archive_changed');
    }

    const manifest = await execute('tar', ['-xOf', archive, 'release/bin/bundle.json'], {
      maxBuffer: 1024 * 1024,
    });

    if (sha256(manifest.stdout) !== expected.bundleSha256) {
      throw new Error('help_bundle_mismatch');
    }

    const inventory = JSON.parse(manifest.stdout) as {
      version?: unknown;
      commit?: unknown;
      files?: Array<{
        path: string;
        sha256: string;
      }>;
    };
    const entry = inventory.files?.find((item) => item.path === 'bin/grigdesk-server');

    if (inventory.version !== expected.version || inventory.commit !== expected.commit
      || !entry || !/^[a-f0-9]{64}$/u.test(entry.sha256)) {
      throw new Error('help_release_mismatch');
    }

    await mkdir(install, {
      recursive: true
    });
    await execute('tar', ['-xzf', archive, '-C', install, 'release/bin/grigdesk-server']);
    binary = path.join(install, 'release/bin/grigdesk-server');

    if (await sha256File(binary) !== entry.sha256) {
      throw new Error('help_binary_mismatch');
    }

    await chmod(binary, 0o755);

    const info = await probeServerBinary(binary);

    if (info.version !== expected.version) {
      throw new Error('help_server_version_mismatch');
    }

    preparation = await prepareServerBinary(binary, {
      home, expectPackageId: info.packageId
    });

    const raw = await readContainedText(preparation.root, 'server/help/help.json', 1024 * 1024);
    const site = await readContainedText(preparation.root, 'server/help/site/help.json', 1024 * 1024);

    if (!raw || raw !== site) {
      throw new Error('help_site_mismatch');
    }

    const bundle = verifyHelpBundle(JSON.parse(raw));

    if (bundle.version !== expected.version || bundle.commit !== expected.commit) {
      throw new Error('help_release_mismatch');
    }

    const output = path.join(work, 'help-site.tar.gz');
    const siteRoot = path.join(preparation.root, 'server/help/site');

    await readFile(path.join(siteRoot, 'index.html'));
    await readFile(path.join(siteRoot, 'latest.html'));
    await readFile(path.join(siteRoot, 'latest.js'));

    const publicSite = path.join(work, 'public-site');

    await cp(siteRoot, publicSite, { recursive: true });
    await normalizeStageModes(publicSite);
    await execute('tar', ['-czf', output, '-C', publicSite, '.']);

    return {
      archive: output,
      dispose,
      revision: bundle.revision
    };
  }
  catch (error) {
    await dispose();

    throw error;
  }
}

/**
 * Временные файлы принадлежат одному upload; общий lock охватывает только commit.
 * Immutable версии можно допубликовать после обрыва, а канал меняется последним.
 */
export function helpPublicationCommand(input: {
  directory: string;
  staging: string;
  version: string;
  archiveSha256: string;
}): string {
  if (!isStableReleaseVersion(input.version) || !/^[a-f0-9]{64}$/u.test(input.archiveSha256)) {
    throw new Error('help_publication_invalid');
  }

  const directory = shellQuote(input.directory);
  const staging = shellQuote(input.staging);
  const version = shellQuote(input.version);
  const digest = shellQuote(input.archiveSha256);

  return `set -eu
umask 022
root=${directory}
stage=${staging}
version=${version}
digest=${digest}
lock="$root/.grigdesk-release-publish.lock"
if ! mkdir "$lock"; then echo 'release_publish_busy' >&2; exit 42; fi
trap 'rmdir "$lock"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$root/releases" "$root/help" "$root/api/releases/v1" "$stage/help"
chmod 0755 "$root/help"
tar -xzf "$stage/help-site.tar.gz" -C "$stage/help"
test -f "$stage/help/index.html"
test -f "$stage/help/help.json"
test -f "$stage/help/latest.html"
test -f "$stage/help/latest.js"
printf '%s\\n' "$digest" > "$stage/help/.release-archive-sha256"
if test -e "$root/releases/$version"; then
  cmp "$stage/release.tar.gz.sha256" "$root/releases/$version/release.tar.gz.sha256"
fi
if test -e "$root/help/$version"; then
  cmp "$stage/help/.release-archive-sha256" "$root/help/$version/.release-archive-sha256"
  test -f "$root/help/$version/index.html"
  cmp "$stage/help/help.json" "$root/help/$version/help.json"
fi
cp "$stage/help/latest.html" "$stage/latest.html.new"
cp "$stage/help/latest.js" "$stage/latest.js.new"
if ! test -e "$root/help/$version"; then mv "$stage/help" "$root/help/$version"; fi
if ! test -e "$root/releases/$version"; then
  mkdir "$stage/release"
  cp "$stage/release.tar.gz" "$stage/release/"
  cp "$stage/release.tar.gz.sha256" "$stage/release/"
  cp "$stage/release.tar.gz.sha256.sig" "$stage/release/"
  mv "$stage/release" "$root/releases/$version"
fi
mv "$stage/latest.js.new" "$root/help/latest.js"
mv "$stage/latest.html.new" "$root/help/latest.html"
mv "$stage/channel.json" "$root/api/releases/v1/channel.json"
rm -rf "$stage"
`;
}
