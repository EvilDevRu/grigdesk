import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPublicKey, randomUUID, verify } from 'node:crypto';

import { decodeReleaseChannelIndex, type ReleaseEnvelope }
  from '../shared/runtime/installedUpdateContracts.ts';
import { RELEASE_SIGNING_PUBLIC_KEY } from '../shared/runtime/releaseChannelContracts.ts';
import { verifyReleaseEnvelope } from '../shared/node/releaseTrust.ts';
import { extractReleaseArtifact } from '../shared/node/releaseArchive.ts';
import { sha256File } from '../shared/node/hash.ts';
import { prepareServerBinary, probeServerBinary, releaseServerPreparation }
  from '../shared/node/serverBinaryRuntime.ts';
import { readContainedText } from '../shared/node/readContainedText.ts';
import { verifyHelpBundle } from '../shared/node/helpSources.ts';
import { HELP_LOCALES, helpResourceFile } from '../shared/help/helpContracts.ts';
import { shellQuote } from '../shared/lib/shellQuote.ts';
import { normalizeStageModes } from '../server/scripts/sea/stage.mts';

const execute = promisify(execFile);

/**
 * Подпись installer связывает точные байты ELF с уже проверенным конвертом выпуска.
 * Тот же verifier используется перед публикацией и перед запуском приватной копии.
 */
export async function verifyReleaseInstaller(
  binary: string,
  envelope: ReleaseEnvelope,
  proof: string,
  signature: string,
  publicKey: string = RELEASE_SIGNING_PUBLIC_KEY,
): Promise<void> {
  const digest = verifyReleaseEnvelope(envelope, publicKey);
  const installer = await sha256File(binary);
  const expected = `GrigDesk installer v1\n${installer}  grigdesk-install\n${digest}\n`;

  if (proof !== expected || !verify(null, Buffer.from(proof), createPublicKey(publicKey),
    Buffer.from(signature.trim(), 'base64'))) {
    throw new Error('release_installer_signature_invalid');
  }
}

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

/**
 * Remote commit публикует immutable выпуск и help раньше одного выбранного индекса.
 * Повтор сверяет manifest целиком; другой канал остаётся прежним. Deb-бутстрап
 * публикуется рядом с installer как необязательный файл того же выпуска.
 */
function installedPublicationCommand(input: {
  root: string;
  staging: string;
  version: string;
  channel: string;
  deb?: string;
}): string {
  const helpFiles = HELP_LOCALES.map(helpResourceFile).map(shellQuote).join(' ');
  const deb = input.deb ? `
if test -e "$stage/${input.deb}"; then
  if test -e "$root/releases/$version/${input.deb}"; then
    cmp "$stage/${input.deb}" "$root/releases/$version/${input.deb}"
  else
    mv "$stage/${input.deb}" "$root/releases/$version/${input.deb}"
  fi
fi
` : '';

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
trap 'exit 143' TERM
mkdir -p "$root/releases" "$root/help" "$root/api/releases/v1" "$stage/help"
tar -xzf "$stage/help-site.tar.gz" -C "$stage/help"
test -f "$stage/help/index.html"
for file in ${helpFiles}; do
  test -f "$stage/help/$file"
done
if test -e "$root/releases/$version"; then
  cmp "$stage/$channel.json" "$root/releases/$version/$channel.json"
  cmp "$stage/grigdesk-install.sha256" "$root/releases/$version/grigdesk-install.sha256"
else
  mkdir "$stage/release"
  for file in desktop.tar.gz server.tar.gz grigdesk-install grigdesk-install.sha256 grigdesk-install.sig; do
    mv "$stage/$file" "$stage/release/$file"
  done
  cp "$stage/$channel.json" "$stage/release/$channel.json"
  mv "$stage/release" "$root/releases/$version"
fi${deb}
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
rm -rf "$stage"
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
  const names = (await fs.readdir(directory))
    .filter((name) => name === 'release.json' || name === 'dev.json');

  if (names.length !== 1 || !targets[0]) {
    throw new Error('release_publication_ambiguous');
  }

  const indexBytes = await fs.readFile(path.join(directory, names[0]!), 'utf8');
  const index = decodeReleaseChannelIndex(JSON.parse(indexBytes));

  if (!index.latest) {
    throw new Error('release_publication_empty');
  }

  const publicKey = process.env.RELEASE_SIGNING_PUBLIC_KEY_FILE
    ? await fs.readFile(process.env.RELEASE_SIGNING_PUBLIC_KEY_FILE, 'utf8') : RELEASE_SIGNING_PUBLIC_KEY;

  verifyReleaseEnvelope(index.latest, publicKey);

  const proof = await fs.readFile(path.join(directory, 'grigdesk-install.sha256'), 'utf8');
  const signature = await fs.readFile(path.join(directory, 'grigdesk-install.sig'), 'utf8');

  await verifyReleaseInstaller(path.join(directory, 'grigdesk-install'), index.latest,
    proof, signature, publicKey);

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

  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-publish-'));

  try {
    for (const component of ['desktop', 'server'] as const) {
      await extractReleaseArtifact(path.join(directory, `${component}.tar.gz`),
        path.join(work, component), index.latest.payload.artifacts[component]);
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
    const upload = ['desktop.tar.gz', 'server.tar.gz', 'grigdesk-install', 'grigdesk-install.sha256',
      'grigdesk-install.sig', names[0]!].map((name) => path.join(directory, name));

    upload.push(help);

    if (debPresent) {
      upload.push(path.join(directory, debName));
    }

    for (const [number, target] of targets.entries()) {
      const staging = `${target.dir}/.grigdesk-publish-${randomUUID()}`;
      const sshOptions = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
        '-o', 'StrictHostKeyChecking=accept-new', '-i', target.key];
      const remote = (command: string) => execute('ssh', [...sshOptions, '-p', target.port,
        `${target.user}@${target.host}`, command]);

      try {
        await remote(`mkdir -p ${shellQuote(staging)}`);
        await execute('scp', [...sshOptions, '-P', target.port, ...upload,
          `${target.user}@${target.host}:${staging}/`]);
        await remote(installedPublicationCommand({
          root: target.dir,
          staging,
          version: index.latest.payload.version,
          channel: index.channel,
          ...(debPresent ? { deb: debName } : {}),
        }));
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
