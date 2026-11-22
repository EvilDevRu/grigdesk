import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

import { verifyGoReleaseEvidence } from './verifyGoReleaseEvidence.mts';
import { parseReleaseChannelIndex, type ReleaseEnvelope }
  from '../shared/runtime/installedUpdateContracts.ts';
import { RELEASE_SIGNING_PUBLIC_KEY } from '../shared/runtime/releaseChannelContracts.ts';
import { verifyReleaseEnvelope } from '../shared/node/releaseTrust.ts';
import { extractReleaseArtifact } from '../shared/node/releaseArchive.ts';
import { compareProductVersions } from '../shared/runtime/productReleaseVersion.ts';
import { sha256, sha256File } from '../shared/node/hash.ts';
import { prepareServerBinary, probeServerBinary, releaseServerPreparation }
  from '../shared/node/serverBinaryRuntime.ts';
import { readContainedText } from '../shared/node/readContainedText.ts';
import { verifyHelpBundle } from '../shared/node/helpSources.ts';
import { HELP_LOCALES, helpResourceFile } from '../shared/help/helpContracts.ts';
import { shellQuote } from '../shared/lib/shellQuote.ts';
import { verifyBootstrapFiles } from './installBootstrap.mts';
import { normalizeStageModes } from '../server/scripts/sea/stage.mts';

const execute = promisify(execFile);

import { verifyReleaseInstaller } from './releaseArtifactVerification.mts';

export { verifyReleaseInstaller };

interface InstalledSiteTarget {
  host: string;
  user: string;
  port: string;
  key: string;
  dir: string;
  origin: string;
}

/**
 * Help извлекается только из проверенного серверного ELF своего выпуска.
 * Preparation lease освобождается независимо от результата публикации.
 */
async function prepareInstalledHelp(work: string, envelope: ReleaseEnvelope): Promise<string> {
  const binary = path.join(work, 'server/bin/grigdesk-server');
  const home = path.join(work, 'probe-home');
  const info = await probeServerBinary(binary, { home });

  if (info.version !== envelope.payload.version
    || info.packageId !== envelope.payload.artifacts.server.packageId) {
    throw new Error('help_server_identity_mismatch');
  }

  const prepared = await prepareServerBinary(binary, { home, expectPackageId: info.packageId });

  try {
    for (const locale of HELP_LOCALES) {
      const file = helpResourceFile(locale);
      const raw = await readContainedText(prepared.root, `server/help/${file}`, 1024 * 1024);
      const published = await readContainedText(prepared.root, `server/help/site/${file}`, 1024 * 1024);

      if (!raw || raw !== published) {
        throw new Error('help_site_mismatch');
      }

      const bundle = verifyHelpBundle(JSON.parse(raw));

      if (bundle.locale !== locale || bundle.version !== envelope.payload.version
        || bundle.commit !== envelope.payload.commit) {
        throw new Error('help_release_mismatch');
      }
    }

    const site = path.join(work, 'help-site');

    await fs.cp(path.join(prepared.root, 'server/help/site'), site, { recursive: true });
    await normalizeStageModes(site);

    const archive = path.join(work, 'help-site.tar.gz');

    await execute('tar', ['-czf', archive, '-C', site, '.']);

    return archive;
  } finally {
    await releaseServerPreparation(binary, {
      home,
      packageId: info.packageId,
      token: prepared.preparationToken,
    });
  }
}

const activeIndexLimit = 1024 ** 2;
const remoteIndexMissing = 44;

/**
 * Проверяет подписанный индекс перед заменой и запоминает точные байты для CAS.
 * Равная версия допустима при совпадении commit и подписанного содержимого.
 */
export function activeStableIndex(bytes: Uint8Array | null, next: ReleaseEnvelope, publicKey: string) {
  if (bytes === null) {
    return null;
  }

  if (bytes.byteLength === 0 || bytes.byteLength > activeIndexLimit) {
    throw new Error('release_active_index_invalid');
  }

  const index = parseReleaseChannelIndex(new TextDecoder('utf-8', {
    fatal: true,
  }).decode(bytes));

  if (index.channel !== 'release' || !index.latest) {
    throw new Error('release_active_index_invalid');
  }

  const digest = verifyReleaseEnvelope(index.latest, publicKey);
  const comparison = compareProductVersions(index.latest.payload.version, next.payload.version);

  if (comparison > 0) {
    throw new Error('release_site_downgrade_forbidden');
  }

  if (comparison === 0 && (index.latest.payload.commit !== next.payload.commit
    || digest !== verifyReleaseEnvelope(next, publicKey))) {
    throw new Error('release_site_version_conflict');
  }

  return sha256(bytes);
}

/**
 * Читает ограниченный объём через тот же SSH-порт, что использует публикация.
 * Отсутствие файла отличается от отказа чтения, битой ссылки и ошибки SSH.
 */
async function readStableSiteIndex(root: string, remote: (command: string) => Promise<{ stdout: Buffer }>) {
  const directory = path.join(root, 'api/releases/v1');
  const result = await remote(`set -eu
dir=${shellQuote(directory)}
file="$dir/release.json"
test -d "$dir" && test -r "$dir" && test -x "$dir" || exit 3
if ! test -e "$file" && ! test -L "$file"; then
  exit ${remoteIndexMissing}
fi
test -f "$file" && test ! -L "$file" || exit 3
head -c ${activeIndexLimit + 1} -- "$file"`).catch((error: { code?: number }) => {
    if (error.code !== remoteIndexMissing) {
      throw error;
    }

    return null;
  });

  return result?.stdout ?? null;
}

/**
 * Remote commit публикует immutable выпуск и help раньше одного выбранного индекса.
 * Повтор сверяет manifest целиком; другой канал остаётся прежним. Deb-бутстрап
 * публикуется рядом с installer как необязательный файл того же выпуска.
 */
export function installedPublicationCommand(input: {
  root: string;
  staging: string;
  version: string;
  channel: string;
  deb?: string;
  expectedSHA?: Readonly<Record<string, string>>;
  expectedActiveIndex?: string | null;
}): string {
  const releaseNames = ['desktop.tar.gz', 'server.tar.gz', 'control.tar.gz', 'grigdesk-install',
    'grigdesk-install.sha256', 'grigdesk-install.sig', 'grigdesk-maintenance.gz'];
  const releaseFiles = releaseNames.map(shellQuote).join(' ');
  const helpFiles = HELP_LOCALES.map(helpResourceFile).map(shellQuote).join(' ');
  const expected = Object.entries(input.expectedSHA ?? {});
  const integrity = expected.map(([name, digest]) => {
    if (!/^[a-z0-9._-]+$/u.test(name) || !/^[a-f0-9]{64}$/u.test(digest)) {
      throw new Error('release_upload_inventory_invalid');
    }

    return `${digest}  ${name}`;
  }).join('\n');
  const immutable = new Set([...releaseNames, input.channel + '.json', input.deb]);
  const readBack = expected.filter(([name]) => immutable.has(name))
    .map(([name, digest]) => `${digest}  ${name}`).join('\n');

  const deb = input.deb ? `
if test -e "$stage/${input.deb}"; then
  if test -e "$root/releases/$version/${input.deb}"; then
    cmp "$stage/${input.deb}" "$root/releases/$version/${input.deb}"
  else
    mv "$stage/${input.deb}" "$root/releases/$version/${input.deb}"
  fi
fi
` : '';

  if (typeof input.expectedActiveIndex === 'string' && !/^[a-f0-9]{64}$/u.test(input.expectedActiveIndex)) {
    throw new Error('release_active_index_invalid');
  }

  const compareActive = input.expectedActiveIndex === undefined ? '' : `
expected_active_index=${shellQuote(input.expectedActiveIndex ?? 'missing')}
current_index="$root/api/releases/v1/$channel.json"
if test -e "$current_index" || test -L "$current_index"; then
  if ! test -f "$current_index" || test -L "$current_index"; then
    echo 'release_active_index_changed' >&2
    exit 3
  fi
  current_hash=$(sha256sum < "$current_index")
  current_hash=\${current_hash%% *}
else
  current_hash=missing
fi
if test "$current_hash" != "$expected_active_index"; then
  echo 'release_active_index_changed' >&2
  exit 3
fi
`;

  return `set -eu
umask 022
root=${shellQuote(input.root)}
stage=${shellQuote(input.staging)}
version=${shellQuote(input.version)}
channel=${shellQuote(input.channel)}
lock="$root/.grigdesk-release-publish.lock"
mkdir "$lock"
trap 'rmdir "$lock"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM${compareActive}
for file in ${releaseFiles} "$channel.json"; do
  test -f "$stage/$file"
  test ! -L "$stage/$file"
done
${integrity ? `(cd "$stage" && printf '%s\\n' ${shellQuote(integrity)} | sha256sum -c -)` : ''}
mkdir -p "$root/releases" "$root/help" "$root/api/releases/v1" "$stage/help"
tar -xzf "$stage/help-site.tar.gz" -C "$stage/help"
test -f "$stage/help/index.html"
for file in ${helpFiles}; do
  test -f "$stage/help/$file"
done
if test -e "$root/releases/$version"; then
  for file in ${releaseFiles} "$channel.json"; do
    cmp "$stage/$file" "$root/releases/$version/$file"
  done
else
  mkdir "$stage/release"
  for file in ${releaseFiles}; do
    mv "$stage/$file" "$stage/release/$file"
  done
  cp "$stage/$channel.json" "$stage/release/$channel.json"
  mv "$stage/release" "$root/releases/$version"
fi${deb}
for file in ${releaseFiles} "$channel.json"; do
  test -f "$root/releases/$version/$file"
  test ! -L "$root/releases/$version/$file"
done
${readBack ? `(cd "$root/releases/$version" && printf '%s\\n' ${shellQuote(readBack)} | sha256sum -c -)` : ''}
if test -e "$root/help/$version"; then
  for file in ${helpFiles}; do
    cmp "$stage/help/$file" "$root/help/$version/$file"
  done
else
  mv "$stage/help" "$root/help/$version"
fi
cp "$root/help/$version/latest.html" "$stage/latest.html.new"
cp "$root/help/$version/latest.js" "$stage/latest.js.new"
mv "$stage/latest.html.new" "$root/help/latest-$channel.html"
mv "$stage/latest.js.new" "$root/help/latest.js"
mv "$stage/$channel.json" "$root/api/releases/v1/$channel.json"
# Время фиксируется только после переключения канала; повтор не меняет порядок выпуска.
if test ! -e "$root/releases/$version/.published-$channel"; then
  touch "$root/releases/$version/.published-$channel"
fi
: > "$stage/retention"
for candidate in "$root/releases/"*; do
  test -d "$candidate" && test ! -L "$candidate" || continue
  test -f "$candidate/grigdesk-maintenance.gz" && test -f "$candidate/$channel.json" || continue
  candidate_version=$(basename "$candidate")
  case "$candidate_version" in ''|*[!0-9A-Za-z.-]*) continue ;; esac
  test "$candidate_version" != "$version" || continue
  published="$candidate/.published-$channel"
  test -f "$published" || published="$candidate/$channel.json"
  printf '%s %s\n' "$(find "$published" -maxdepth 0 -printf '%T@')" "$candidate_version" >> "$stage/retention"
done
sort -k1,1nr -k2,2r "$stage/retention" | awk 'NR > 1 {print $2}' > "$stage/remove"
while IFS= read -r obsolete; do
  test -n "$obsolete" && test "$obsolete" != "$version" || continue
  rm -rf -- "$root/releases/$obsolete" "$root/help/$obsolete"
  printf 'Удалено: %s\n' "$root/releases/$obsolete" "$root/help/$obsolete"
done < "$stage/remove"
rm -rf "$stage"
`;
}

/**
 * Перед SCP убираются только старые staging-каталоги в корне публикации.
 * Свободное место проверяется на этой файловой системе до заливки любых байтов.
 */
export function installedPublicationPreflight(root: string, staging: string, bytes: number): string {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error('release_publication_size_invalid');
  }

  const cleanup = ['find "$root" -mindepth 1 -maxdepth 1 -type d',
    "-name '.grigdesk-publish-*' -mmin +10080 -print -exec rm -rf -- {} +"].join(' ');

  return `set -eu
root=${shellQuote(root)}
mkdir -p "$root"
${cleanup}
available=$(df -Pk -- "$root" | awk 'NR == 2 {print $4}')
required=${Math.ceil(bytes * 2 / 1024)}
case "$available" in ''|*[!0-9]*) echo 'Не удалось проверить свободное место выпуска' >&2; exit 2 ;; esac
if test "$available" -lt "$required"; then
  echo "Недостаточно места для выпуска: нужно $required KiB, свободно $available KiB" >&2
  exit 2
fi
mkdir ${shellQuote(staging)}
`;
}

/**
 * До SSH проверяются подпись payload, архивы, описи и отдельная подпись installer.
 * Dry-run не исполняет готовые программы и не создаёт файлы на сайте.
 */
export async function publishInstalledRelease(
  directory: string,
  targets: InstalledSiteTarget[],
  dryRun = false,
): Promise<void> {
  if (await fs.lstat(path.join(directory, 'local-build.json')).then(() => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }

      return false;
    })) {
    throw new Error('release_local_build_not_publishable');
  }

  const names = (await fs.readdir(directory))
    .filter((name) => name === 'release.json' || name === 'dev.json');

  if (names.length !== 1 || !targets[0]) {
    throw new Error('release_publication_ambiguous');
  }

  const indexBytes = await fs.readFile(path.join(directory, names[0]!), 'utf8');
  const index = parseReleaseChannelIndex(indexBytes);

  if (!index.latest) {
    throw new Error('release_publication_empty');
  }

  const publicKey = RELEASE_SIGNING_PUBLIC_KEY;

  verifyReleaseEnvelope(index.latest, publicKey);

  if (index.latest.payload.platform.os !== 'linux') {
    throw new Error('release_publish_platform_unsupported');
  }

  const proof = await fs.readFile(path.join(directory, 'grigdesk-install.sha256'), 'utf8');
  const signature = await fs.readFile(path.join(directory, 'grigdesk-install.sig'), 'utf8');

  await verifyReleaseInstaller(path.join(directory, 'grigdesk-install'), index.latest,
    proof, signature, publicKey);
  const bootstrap = await verifyBootstrapFiles(directory, { envelope: index.latest, publicKey });

  if (bootstrap.delivery) {
    throw new Error('release_local_build_not_publishable');
  }

  for (const component of ['desktop', 'server'] as const) {
    const artifact = index.latest.payload.artifacts[component];

    if (artifact.url !== `${targets[0].origin.replace(/\/$/u, '')}/releases/`
      + `${index.latest.payload.version}/${component}.tar.gz`
      || await sha256File(path.join(directory, `${component}.tar.gz`)) !== artifact.sha256
      || (await fs.stat(path.join(directory, `${component}.tar.gz`))).size !== artifact.size) {
      throw new Error('release_archive_integrity_invalid');
    }
  }

  if (dryRun) {
    process.stdout.write(`Проверен ${index.channel}/${index.latest.payload.version};`
      + ' публикация не выполнялась.\n');

    return;
  }

  await verifyGoReleaseEvidence(directory);

  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-publish-'));

  try {
    if (index.format !== 3 || !index.latest.payload.artifacts.control) {
      throw new Error('release_go_target_required');
    }

    for (const component of ['desktop', 'server', 'control'] as const) {
      await extractReleaseArtifact(path.join(directory, `${component}.tar.gz`),
        path.join(work, component), index.latest.payload.artifacts[component]!);
    }

    const help = await prepareInstalledHelp(work, index.latest);
    const debName = `grigdesk_${index.latest.payload.version}_amd64.deb`;
    const debPresent = await fs.stat(path.join(directory, debName)).then(() => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }

        return false;
      });
    const upload = ['desktop.tar.gz', 'server.tar.gz', 'control.tar.gz',
      'grigdesk-maintenance.gz', 'grigdesk-install',
      'grigdesk-install.sha256',
      'grigdesk-install.sig', names[0]!].map((name) => path.join(directory, name));

    upload.push(help);

    if (debPresent) {
      upload.push(path.join(directory, debName));
    }

    const expectedSHA = Object.fromEntries(await Promise.all(upload.map(async (file) =>
      [path.basename(file), await sha256File(file)] as const)));

    for (const [number, target] of targets.entries()) {
      const staging = `${target.dir}/.grigdesk-publish-${randomUUID()}`;
      const sshOptions = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
        '-o', 'StrictHostKeyChecking=accept-new', '-i', target.key];
      const remote = (command: string) => execute('ssh', [...sshOptions, '-p', target.port,
        `${target.user}@${target.host}`, command], {
        encoding: 'buffer',
        maxBuffer: activeIndexLimit + 1,
      });

      try {
        const bytes = (await Promise.all(upload.map(async (file) => (await fs.stat(file)).size)))
          .reduce((sum, size) => sum + size, 0);
        const preflight = await remote(installedPublicationPreflight(target.dir, staging, bytes));

        process.stdout.write(preflight.stdout);

        const expectedActiveIndex = index.channel === 'release'
          ? activeStableIndex(await readStableSiteIndex(target.dir, remote), index.latest, publicKey)
          : undefined;

        await execute('scp', [...sshOptions, '-P', target.port, ...upload,
          `${target.user}@${target.host}:${staging}/`]);

        const published = await remote(installedPublicationCommand({
          root: target.dir,
          staging,
          version: index.latest.payload.version,
          channel: index.channel,
          expectedSHA,
          expectedActiveIndex,
          ...(debPresent ? { deb: debName } : {}),
        }));

        process.stdout.write(published.stdout);
      } catch (error) {
        if (number === 0) {
          throw error;
        }

        process.stderr.write(`Не удалось опубликовать зеркало ${target.host}.\n`);
      }
    }
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}
